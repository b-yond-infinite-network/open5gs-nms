import pino from 'pino';
import { Mutex } from 'async-mutex';
import * as path from 'path';
import {
  IHostExecutor,
  CommandResult,
  StreamHandlers,
  StreamHandle,
} from '../../domain/interfaces/host-executor';

//A traffic run is three pings of five packets. Well under this, but a stream left
//open by a closed browser tab must not outlive the interest in it.
const TRAFFIC_STREAM_TIMEOUT_MS = 300000;

export type K8sLabAction = 'install-node' | 'delete-node' | 'start-lab' | 'stop-lab';
export type K8sUeScenario = 'normal' | 'auth-error' | 'dnn-error' | 'imsi-error' | 'slice-error';
export type K8sUeScriptAction = 'attach' | 'detach' | 'remove' | 'traffic' | 'check';

export type SubscriberUeAction = 'attach' | 'detach' | 'traffic' | 'check';
export type SubscriberUeState =
  | 'unconfigured'
  | 'detached'
  | 'starting'
  | 'attached'
  | 'failed'
  | 'unavailable';

export interface SubscriberUeStatus {
  imsi: string;
  status: SubscriberUeState;
  message: string;
}

export interface K8sLabStatus {
  rootPath: string;
  executionUser: string;
  available: boolean;
  kubectlAvailable: boolean;
  clusterReachable: boolean;
  currentContext: string | null;
  open5gsNamespace: boolean;
  open5gsPodCount: number;
  open5gsReadyPodCount: number;
  open5gsUnhealthyPods: string[];
  generatedUes: string[];
  logFiles: string[];
}

export interface K8sCommandDefinition {
  id: string;
  category: 'cluster' | 'ue-create' | 'ue-action';
  script: string;
  guiAction: string;
  description: string;
  destructive: boolean;
  acceptsUeCount: boolean;
  available: boolean;
}

export interface K8sScriptResult {
  success: boolean;
  action: string;
  message: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  logFiles: string[];
  generatedUes: string[];
}

export interface K8sLogFile {
  name: string;
  content: string;
}

interface ScriptDefinition {
  folder: 'INSTALL' | 'SCRIPTS';
  file: string;
  timeoutMs: number;
}

export class K8sLabUseCase {
  private readonly actionMutex = new Mutex();

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
    private readonly rootPath: string,
    private readonly kubeconfigPath: string,
    private readonly executionUser: string,
  ) {}

  async getStatus(): Promise<K8sLabStatus> {
    const available = await this.hostPathExists(this.rootPath);
    if (!available) {
      return {
        rootPath: this.rootPath,
        executionUser: this.executionUser,
        available: false,
        kubectlAvailable: false,
        clusterReachable: false,
        currentContext: null,
        open5gsNamespace: false,
        open5gsPodCount: 0,
        open5gsReadyPodCount: 0,
        open5gsUnhealthyPods: [],
        generatedUes: [],
        logFiles: [],
      };
    }

    const kubectlAvailable = (await this.runHostShell('command -v kubectl >/dev/null 2>&1', 10000)).exitCode === 0;
    const currentContextResult = kubectlAvailable
      ? await this.runHostShell('kubectl config current-context 2>/dev/null || true', 10000)
      : null;
    const clusterReachable = kubectlAvailable
      ? (await this.runHostShell('kubectl cluster-info >/dev/null 2>&1', 15000)).exitCode === 0
      : false;
    const open5gsNamespace = clusterReachable
      ? (await this.runHostShell('kubectl get namespace open5gs >/dev/null 2>&1', 10000)).exitCode === 0
      : false;
    const podsResult = open5gsNamespace
      ? await this.runHostShell('kubectl -n open5gs get pods --no-headers 2>/dev/null', 10000)
      : null;
    const pods = podsResult?.exitCode === 0
      ? podsResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
      : [];
    const unhealthyPods = pods.flatMap((line) => {
      const [name, ready = '0/0', status = 'Unknown'] = line.split(/\s+/);
      const [readyCount, totalCount] = ready.split('/').map(Number);
      return totalCount > 0 && readyCount === totalCount ? [] : [`${name} (${status}, ${ready})`];
    });

    return {
      rootPath: this.rootPath,
      executionUser: this.executionUser,
      available,
      kubectlAvailable,
      clusterReachable,
      currentContext: currentContextResult?.stdout.trim() || null,
      open5gsNamespace,
      open5gsPodCount: pods.length,
      open5gsReadyPodCount: pods.length - unhealthyPods.length,
      open5gsUnhealthyPods: unhealthyPods,
      generatedUes: await this.listGeneratedUes(),
      logFiles: await this.listLogFiles(),
    };
  }

  async listCommands(): Promise<K8sCommandDefinition[]> {
    const commands: Array<Omit<K8sCommandDefinition, 'available'>> = [
      { id: 'start-lab', category: 'cluster', script: 'INSTALL/START_5gsa.sh', guiAction: 'Start 5GSA Lab', description: 'Deploy the Open5GS standalone lab.', destructive: false, acceptsUeCount: false },
      { id: 'stop-lab', category: 'cluster', script: 'INSTALL/STOP_5gsa.sh', guiAction: 'Stop 5GSA Lab', description: 'Delete deployed Open5GS lab resources.', destructive: true, acceptsUeCount: false },
      { id: 'install-node', category: 'cluster', script: 'INSTALL/INSTALL_NODE_k8s.sh', guiAction: 'Install K8s Node', description: 'Install Kubernetes and the lab networking stack on the host.', destructive: true, acceptsUeCount: false },
      { id: 'delete-node', category: 'cluster', script: 'INSTALL/DELETE_NODE_k8s.sh', guiAction: 'Delete K8s Node', description: 'Remove Kubernetes and its networking stack from the host.', destructive: true, acceptsUeCount: false },
      { id: 'create-ues:normal', category: 'ue-create', script: 'SCRIPTS/ue_create.sh', guiAction: 'Create UE / Normal', description: 'Provision normal subscribers and generate UE manifests.', destructive: false, acceptsUeCount: true },
      { id: 'create-ues:auth-error', category: 'ue-create', script: 'SCRIPTS/ue_create_auth_error.sh', guiAction: 'Create UE / Auth Error', description: 'Generate UEs with mismatched authentication credentials.', destructive: false, acceptsUeCount: true },
      { id: 'create-ues:dnn-error', category: 'ue-create', script: 'SCRIPTS/ue_create_dnn_error.sh', guiAction: 'Create UE / DNN Error', description: 'Generate UEs with invalid DNN configuration.', destructive: false, acceptsUeCount: true },
      { id: 'create-ues:imsi-error', category: 'ue-create', script: 'SCRIPTS/ue_create_imsi_error.sh', guiAction: 'Create UE / IMSI Error', description: 'Generate UEs whose provisioned IMSI does not match.', destructive: false, acceptsUeCount: true },
      { id: 'create-ues:slice-error', category: 'ue-create', script: 'SCRIPTS/ue_create_slice_error.sh', guiAction: 'Create UE / Slice Error', description: 'Generate UEs with invalid slice configuration.', destructive: false, acceptsUeCount: true },
      { id: 'ue-attach', category: 'ue-action', script: 'SCRIPTS/attach_ue.sh', guiAction: 'Attach UE(s)', description: 'Create UE configmaps and deployments. Accepts a single UE.', destructive: false, acceptsUeCount: false },
      { id: 'ue-detach', category: 'ue-action', script: 'SCRIPTS/dettach_ue.sh', guiAction: 'Detach UE(s)', description: 'Delete UE deployments and configmaps. Accepts a single UE.', destructive: true, acceptsUeCount: false },
      { id: 'ue-remove', category: 'ue-action', script: 'SCRIPTS/remove_ue.sh', guiAction: 'Remove UE(s)', description: 'Delete subscribers and generated UE files. Accepts a single UE.', destructive: true, acceptsUeCount: false },
      { id: 'ue-traffic', category: 'ue-action', script: 'SCRIPTS/traffic_ue.sh', guiAction: 'Run Traffic Test', description: 'Ping through each generated UE tunnel. Accepts a single UE.', destructive: false, acceptsUeCount: false },
      { id: 'ue-check', category: 'ue-action', script: 'SCRIPTS/check_ue.sh', guiAction: 'Check UE(s)', description: 'Report how far each UE got: registration and PDU session outcome. Accepts a single UE.', destructive: false, acceptsUeCount: false },
    ];

    return Promise.all(commands.map(async (command) => ({
      ...command,
      available: await this.hostPathExists(`${this.rootPath}/${command.script}`),
    })));
  }

  async runLabAction(action: K8sLabAction): Promise<K8sScriptResult> {
    const definition = this.getLabScriptDefinition(action);
    return this.runScriptAction(action, definition);
  }

  async createUes(count: number, scenario: K8sUeScenario): Promise<K8sScriptResult> {
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new Error('UE count must be an integer between 1 and 50');
    }

    const file =
      scenario === 'normal'
        ? 'ue_create.sh'
        : `ue_create_${scenario.replace('-', '_')}.sh`;

    return this.runScriptAction(
      `create-ues:${scenario}`,
      {
        folder: 'SCRIPTS',
        file,
        timeoutMs: 180000,
      },
      [String(count)],
    );
  }

  /**
   * Runs one of the generated UE scripts. With no imsis it acts on the whole
   * batch, as it always has; with imsis the script acts only on those UEs, so a
   * single UE can be attached, detached, removed or pinged on its own.
   */
  async runUeScript(
    action: K8sUeScriptAction,
    imsis: string[] = [],
  ): Promise<K8sScriptResult> {
    const files: Record<K8sUeScriptAction, string> = {
      attach: 'attach_ue.sh',
      detach: 'dettach_ue.sh',
      remove: 'remove_ue.sh',
      traffic: 'traffic_ue.sh',
      check: 'check_ue.sh',
    };

    const targets = imsis.map((imsi) => this.normaliseImsi(imsi));

    return this.runScriptAction(
      `ue-${action}${targets.length ? `:${targets.join(',')}` : ''}`,
      {
        folder: 'SCRIPTS',
        file: files[action],
        timeoutMs: action === 'traffic' ? 180000 : 120000,
      },
      targets,
    );
  }

  /**
   * The status endpoint reports UEs by folder name (ue001019000000001) while the
   * scripts select on the bare IMSI, so accept either and reject anything that is
   * not one. Arguments are shell-quoted downstream, and this keeps a value that
   * could never be a UE from reaching the command line at all.
   */
  private normaliseImsi(value: string): string {
    const imsi = String(value).trim().replace(/^ue/i, '');
    if (!/^\d{15}$/.test(imsi)) {
      throw new Error(`Not a UE identity: "${value}" (expected 15 digits, or ue<15 digits>)`);
    }
    return imsi;
  }

  async createSubscriberUe(imsi: string): Promise<K8sScriptResult> {
    this.assertImsi(imsi);
    return this.runScriptAction(
      `subscriber-ue-create:${imsi}`,
      { folder: 'SCRIPTS', file: 'NMS/ue_create_subscriber.sh', timeoutMs: 120000 },
      [imsi],
    );
  }

  async runSubscriberUeAction(
    imsi: string,
    action: SubscriberUeAction,
  ): Promise<K8sScriptResult> {
    this.assertImsi(imsi);

    return this.actionMutex.runExclusive(async () => {
      const ueDir = `${this.rootPath}/SCRIPTS/ue${imsi}`;
      if (action === 'attach' && !(await this.hostPathExists(ueDir))) {
        const prepared = await this.executeScriptAction(
          `subscriber-ue-create:${imsi}`,
          { folder: 'SCRIPTS', file: 'NMS/ue_create_subscriber.sh', timeoutMs: 120000 },
          [imsi],
        );
        if (!prepared.success) {
          return prepared;
        }
      }

      const files: Record<SubscriberUeAction, string> = {
        attach: 'NMS/attach_ue.sh',
        detach: 'NMS/dettach_ue.sh',
        traffic: 'NMS/traffic_ue.sh',
        check: 'NMS/check_ue.sh',
      };

      //Deletion is deliberately not one of these. There is a single way to delete a
      //UE from a subscriber row — DELETE /api/subscribers/:imsi, which tears the UE
      //down and removes the subscriber entry with it. A UE-only teardown reachable
      //here as well would be a second, quieter delete with different consequences.
      return this.executeScriptAction(
        `subscriber-ue-${action}:${imsi}`,
        {
          folder: 'SCRIPTS',
          file: files[action],
          timeoutMs: action === 'traffic' ? 180000 : 120000,
        },
        [imsi],
      );
    });
  }

  async removeSubscriberUe(imsi: string): Promise<K8sScriptResult> {
    this.assertImsi(imsi);
    return this.runScriptAction(
      `subscriber-ue-remove:${imsi}`,
      { folder: 'SCRIPTS', file: 'NMS/remove_ue.sh', timeoutMs: 120000 },
      ['--keep-subscriber', imsi],
    );
  }

  async getSubscriberUeStatuses(imsis: string[]): Promise<SubscriberUeStatus[]> {
    const requested = [...new Set(imsis)];
    if (requested.length > 100) {
      throw new Error('At most 100 UE statuses can be checked at once');
    }
    requested.forEach((imsi) => this.assertImsi(imsi));
    if (requested.length === 0) {
      return [];
    }

    const result = await this.executeScript(
      'subscriber-ue-status',
      { folder: 'SCRIPTS', file: 'NMS/check_ue.sh', timeoutMs: 30000 },
      requested,
    );
    if (result.exitCode !== 0) {
      const message = (result.stderr || result.stdout).trim() || 'check_ue.sh failed';
      return requested.map((imsi) => ({ imsi, status: 'unavailable', message }));
    }

    const validStates = new Set<SubscriberUeState>([
      'unconfigured',
      'detached',
      'starting',
      'attached',
      'failed',
      'unavailable',
    ]);
    const parsed = new Map<string, SubscriberUeStatus>();
    for (const line of result.stdout.split('\n')) {
      const [marker, imsi, rawStatus, ...messageParts] = line.split('\t');
      if (marker !== 'NMS_UE_STATUS' || !requested.includes(imsi)) {
        continue;
      }
      const status = rawStatus as SubscriberUeState;
      if (!validStates.has(status)) {
        continue;
      }
      parsed.set(imsi, { imsi, status, message: messageParts.join('\t').trim() });
    }

    return requested.map((imsi) => parsed.get(imsi) || ({
      imsi,
      status: 'unavailable',
      message: 'check_ue.sh returned no status for this IMSI',
    }));
  }

  async listLogFiles(): Promise<string[]> {
    if (!(await this.hostPathExists(this.logDir()))) {
      return [];
    }

    const result = await this.runHostShell(
      `cd ${this.quote(this.logDir())} && ls -1t | head -n 30`,
      10000,
    );

    if (result.exitCode !== 0) {
      return [];
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async readLog(name: string, tailLines: number = 200): Promise<K8sLogFile> {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error('Invalid log file name');
    }

    const filePath = `${this.logDir()}/${name}`;
    if (!(await this.hostPathExists(filePath))) {
      throw new Error(`Log file not found: ${name}`);
    }

    const safeTail = Math.max(10, Math.min(tailLines, 1000));
    const result = await this.runHostShell(
      `tail -n ${safeTail} ${this.quote(filePath)}`,
      10000,
    );

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to read log file: ${name}`);
    }

    return {
      name,
      content: result.stdout,
    };
  }

  private async runScriptAction(
    action: string,
    definition: ScriptDefinition,
    args: string[] = [],
  ): Promise<K8sScriptResult> {
    return this.actionMutex.runExclusive(() =>
      this.executeScriptAction(action, definition, args),
    );
  }

  private async executeScriptAction(
    action: string,
    definition: ScriptDefinition,
    args: string[] = [],
  ): Promise<K8sScriptResult> {
    const result = await this.executeScript(action, definition, args);
    return this.buildScriptResult(action, result);
  }

  private async executeScript(
    action: string,
    definition: ScriptDefinition,
    args: string[] = [],
  ): Promise<CommandResult> {
    await this.ensureRootAvailable();

    const workingDir = `${this.rootPath}/${definition.folder}`;
    const scriptPath = `${workingDir}/${definition.file}`;
    if (!(await this.hostPathExists(scriptPath))) {
      throw new Error(`Required script not found: ${scriptPath}`);
    }

    this.logger.info({ action, scriptPath, args }, 'Executing LAAS 5GSA script');
    const shellArgs = args.map((arg) => this.quote(arg)).join(' ');
    const command = `cd ${this.quote(workingDir)} && /bin/bash ${this.quote(`./${definition.file}`)}${shellArgs ? ` ${shellArgs}` : ''}`;
    return this.runHostShell(command, definition.timeoutMs);
  }

  private buildScriptResult(action: string, result: CommandResult): Promise<K8sScriptResult> {
    const success = result.exitCode === 0;
    const message = success
      ? `Script "${action}" completed successfully`
      : `Script "${action}" failed with exit code ${result.exitCode}`;

    return Promise.all([this.listLogFiles(), this.listGeneratedUes()]).then(([logFiles, generatedUes]) => ({
      success,
      action,
      message,
      stdout: this.trimOutput(result.stdout),
      stderr: this.trimOutput(result.stderr),
      exitCode: result.exitCode,
      logFiles,
      generatedUes,
    }));
  }

  private async listGeneratedUes(): Promise<string[]> {
    const scriptsDir = `${this.rootPath}/SCRIPTS`;
    if (!(await this.hostPathExists(scriptsDir))) {
      return [];
    }

    const result = await this.runHostShell(
      `find ${this.quote(scriptsDir)} -maxdepth 1 -mindepth 1 -type d -name 'ue[0-9]*' -printf '%f\n' | grep -E '^ue[0-9]{15}$' | sort`,
      10000,
    );

    if (result.exitCode !== 0) {
      return [];
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private getLabScriptDefinition(action: K8sLabAction): ScriptDefinition {
    const definitions: Record<K8sLabAction, ScriptDefinition> = {
      'install-node': {
        folder: 'INSTALL',
        file: 'INSTALL_NODE_k8s.sh',
        timeoutMs: 1800000,
      },
      'delete-node': {
        folder: 'INSTALL',
        file: 'DELETE_NODE_k8s.sh',
        timeoutMs: 1800000,
      },
      'start-lab': {
        folder: 'INSTALL',
        file: 'START_5gsa.sh',
        timeoutMs: 600000,
      },
      'stop-lab': {
        folder: 'INSTALL',
        file: 'STOP_5gsa.sh',
        timeoutMs: 300000,
      },
    };

    return definitions[action];
  }

  private async ensureRootAvailable(): Promise<void> {
    if (!(await this.hostPathExists(this.rootPath))) {
      throw new Error(`LAAS 5GSA root path not found: ${this.rootPath}`);
    }
  }

  private logDir(): string {
    return `${this.rootPath}/LOGS`;
  }

  private async hostPathExists(path: string): Promise<boolean> {
    const result = await this.runHostShell(`test -e ${this.quote(path)}`, 10000);
    return result.exitCode === 0;
  }

  private hostShellArgv(command: string): string[] {
    const hostHome = path.dirname(path.dirname(this.kubeconfigPath));
    const hostCommand = `export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin KUBECONFIG=${this.quote(this.kubeconfigPath)}; ${command}`;

    return ['-n', '-u', this.executionUser, '-H', 'env', `HOME=${hostHome}`, '/bin/bash', '-lc', hostCommand];
  }

  private runHostShell(command: string, timeoutMs: number): Promise<CommandResult> {
    return this.hostExecutor.executeCommand(
      '/usr/bin/sudo',
      this.hostShellArgv(command),
      timeoutMs,
    );
  }

  /**
   * Starts traffic_ue.sh for one UE and hands its output over as it appears. The
   * pings run for a couple of minutes, and the point of watching them is seeing
   * replies arrive, so this streams rather than returning a finished transcript.
   *
   * Deliberately outside actionMutex: this can be left running while the operator
   * watches, and holding the mutex that long would block every other lab action,
   * status check included.
   */
  async streamSubscriberUeTraffic(
    imsi: string,
    handlers: StreamHandlers,
  ): Promise<StreamHandle> {
    this.assertImsi(imsi);
    await this.ensureRootAvailable();

    const workingDir = `${this.rootPath}/SCRIPTS`;
    const script = 'NMS/traffic_ue.sh';
    if (!(await this.hostPathExists(`${workingDir}/${script}`))) {
      throw new Error(`Required script not found: ${workingDir}/${script}`);
    }

    const command = `cd ${this.quote(workingDir)} && /bin/bash ${this.quote(`./${script}`)} ${this.quote(imsi)}`;
    this.logger.info({ imsi, script }, 'Streaming UE traffic');

    return this.hostExecutor.streamCommand(
      '/usr/bin/sudo',
      this.hostShellArgv(command),
      handlers,
      TRAFFIC_STREAM_TIMEOUT_MS,
    );
  }

  private trimOutput(output: string, maxChars: number = 12000): string {
    if (output.length <= maxChars) {
      return output;
    }

    return `${output.slice(0, maxChars)}\n...[output truncated]`;
  }

  private assertImsi(imsi: string): void {
    if (!/^\d{15}$/.test(imsi)) {
      throw new Error('IMSI must be exactly 15 digits');
    }
  }

  private quote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
}
