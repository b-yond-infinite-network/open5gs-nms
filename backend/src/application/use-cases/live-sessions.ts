import pino from 'pino';
import * as path from 'path';
import { IHostExecutor, CommandResult } from '../../domain/interfaces/host-executor';

/**
 * Live attachment state, read from the network itself rather than from config.
 *
 * Two sources, deliberately kept apart because they have different authority:
 *
 *  - Counts come from the AMF and SMF Prometheus endpoints. That is the core's
 *    own view of how many subscribers are registered and how many PDU sessions
 *    exist, so it is correct no matter what RAN is attached.
 *  - Per-UE rows come from UERANSIM's nr-cli inside the UE pods, because
 *    Open5GS exposes no API that enumerates registered UEs — the metrics are
 *    gauges only. That makes the detail RAN-side, and simulator-specific.
 *
 * Nothing here parses /etc/open5gs YAML or the host conntrack table: under
 * Kubernetes the NF configs live in ConfigMaps and UE traffic never crosses the
 * host's conntrack, so neither can answer "who is attached right now".
 */

//Metrics scrapes and nr-cli calls are cheap but they are behind kubectl, which
//is not. These bounds keep one poll from turning into a hundred execs.
const MAX_UE_PODS = 25;
const MAX_UES_PER_POD = 16;
const METRICS_PORT = 9090;
const KUBECTL_TIMEOUT_MS = 15000;
const EXEC_TIMEOUT_MS = 20000;

//Where UERANSIM ships nr-cli, in the two spellings the upstream images use.
//These must stay absolute: `kubectl exec` runs the binary directly, and the
//UE image's working directory is the build dir, so a bare name resolves during
//the probe and then fails at exec time.
const NR_CLI_CANDIDATES = ['/UERANSIM/build/nr-cli', '/ueransim/build/nr-cli'];

export interface LiveMetricSample {
  labels: Record<string, string>;
  value: number;
}

export interface LiveSliceCount {
  plmnId: string;
  snssai: string;
  value: number;
}

export interface LiveGnb {
  pod: string;
  ip: string;
}

export interface LiveSessionCounts {
  available: boolean;
  /** Why the counts are unavailable; null when they are. */
  reason: string | null;
  /** Total registered subscribers across every AMF, or null if no AMF answered. */
  registeredSubscribers: number | null;
  /** Total active PDU sessions across every SMF, or null if no SMF answered. */
  activePduSessions: number | null;
  /** AMF's RAN UE contexts — UEs with a live NGAP context. */
  ranUeContexts: number | null;
  /** gNodeBs currently in NGAP association with an AMF. */
  gnbCount: number | null;
  registeredBySlice: LiveSliceCount[];
  sessionsBySlice: LiveSliceCount[];
  /** The gNodeB pods themselves, so N2/N3 can name peers and not just count them. */
  gnbs: LiveGnb[];
  /** Pods that were scraped, and pods that failed, for operator diagnosis. */
  scrapedPods: string[];
  failedPods: string[];
  scrapedAt: string;
}

export interface LivePduSession {
  id: number;
  state: string;
  type: string;
  dnn: string;
  sst: string;
  sd: string;
  address: string | null;
}

export interface LiveUe {
  imsi: string;
  pod: string;
  cmState: string;
  rmState: string;
  mmState: string;
  sessions: LivePduSession[];
}

export interface LiveUeDetail {
  available: boolean;
  reason: string | null;
  /** RAN-side: these rows come from the UE simulator, not from the core. */
  source: 'ueransim-nr-cli';
  ues: LiveUe[];
  /** True when a bound above cut the walk short, so the list is partial. */
  truncated: boolean;
  scrapedAt: string;
}

interface PodRef {
  name: string;
  container: string;
}

export class LiveSessionsUseCase {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
    private readonly kubeconfigPath: string,
    private readonly executionUser: string,
    private readonly namespace: string,
  ) {}

  /**
   * Core-side counts. Answers "how many are attached" authoritatively and in a
   * single scrape per NF, so this is what a status poll should call.
   */
  async getCounts(): Promise<LiveSessionCounts> {
    const empty = (reason: string): LiveSessionCounts => ({
      available: false,
      reason,
      registeredSubscribers: null,
      activePduSessions: null,
      ranUeContexts: null,
      gnbCount: null,
      registeredBySlice: [],
      sessionsBySlice: [],
      gnbs: [],
      scrapedPods: [],
      failedPods: [],
      scrapedAt: new Date().toISOString(),
    });

    const reachable = await this.clusterReachable();
    if (reachable !== null) {
      return empty(reachable);
    }

    const [amfPods, smfPods, gnbs] = await Promise.all([
      this.listPods('nf=amf'),
      this.listPods('nf=smf'),
      this.listGnbs(),
    ]);

    if (amfPods.length === 0 && smfPods.length === 0) {
      return empty(`No running AMF or SMF pods found in namespace "${this.namespace}"`);
    }

    const scrapedPods: string[] = [];
    const failedPods: string[] = [];

    const scrapes = await Promise.all(
      [...amfPods, ...smfPods].map(async (pod) => {
        const text = await this.scrapeMetrics(pod.name);
        if (text === null) {
          failedPods.push(pod.name);
          return null;
        }
        scrapedPods.push(pod.name);
        return text;
      }),
    );

    const texts = scrapes.filter((t): t is string => t !== null);
    if (texts.length === 0) {
      return empty('AMF/SMF pods were found but none served /metrics on port ' + METRICS_PORT);
    }

    const registered = this.sumAcross(texts, 'fivegs_amffunction_rm_registeredsubnbr');
    const sessions = this.sumAcross(texts, 'fivegs_smffunction_sm_sessionnbr');
    const ranUe = this.sumAcross(texts, 'ran_ue');
    const gnb = this.sumAcross(texts, 'gnb');

    return {
      available: true,
      reason: null,
      registeredSubscribers: registered.total,
      activePduSessions: sessions.total,
      ranUeContexts: ranUe.total,
      gnbCount: gnb.total,
      registeredBySlice: this.toSliceCounts(registered.samples),
      sessionsBySlice: this.toSliceCounts(sessions.samples),
      gnbs,
      scrapedPods,
      failedPods,
      scrapedAt: new Date().toISOString(),
    };
  }

  /**
   * Per-UE rows: IMSI, registration state and the live IP of each PDU session.
   * Costs one exec per UE plus two per UE context, so it is the follow-up call,
   * not part of a status poll.
   */
  async getUeDetail(): Promise<LiveUeDetail> {
    const empty = (reason: string, ues: LiveUe[] = [], truncated = false): LiveUeDetail => ({
      available: ues.length > 0,
      reason,
      source: 'ueransim-nr-cli',
      ues,
      truncated,
      scrapedAt: new Date().toISOString(),
    });

    const reachable = await this.clusterReachable();
    if (reachable !== null) {
      return empty(reachable);
    }

    const allPods = await this.listPods('app=ueransim');
    //The lab runs both a pooled UE deployment and one pod per generated IMSI;
    //the per-IMSI pods predate the nf=ue label, so match on either.
    const uePods = allPods.filter((p) => p.name.startsWith('ueransim-ue'));
    if (uePods.length === 0) {
      return empty(`No UERANSIM UE pods found in namespace "${this.namespace}"`);
    }

    const truncated = uePods.length > MAX_UE_PODS;
    const ues: LiveUe[] = [];

    for (const pod of uePods.slice(0, MAX_UE_PODS)) {
      const collected = await this.collectFromPod(pod);
      ues.push(...collected);
    }

    if (ues.length === 0) {
      return empty('UE pods are running but nr-cli reported no UE contexts', [], truncated);
    }

    return {
      available: true,
      reason: null,
      source: 'ueransim-nr-cli',
      ues,
      truncated,
      scrapedAt: new Date().toISOString(),
    };
  }

  // ── Core-side scraping ──

  private async scrapeMetrics(podName: string): Promise<string | null> {
    //Through the API server's pod proxy rather than the pod IP: it needs no
    //curl in the NF image, survives pod IP churn between polls, and does not
    //assume the NMS shares a route with the CNI network.
    const rawPath = `/api/v1/namespaces/${this.namespace}/pods/${podName}:${METRICS_PORT}/proxy/metrics`;
    const result = await this.runHostShell(
      `kubectl get --raw ${this.quote(rawPath)}`,
      KUBECTL_TIMEOUT_MS,
    );

    if (result.exitCode !== 0) {
      this.logger.debug(
        { pod: podName, stderr: result.stderr.trim() },
        'Metrics scrape failed',
      );
      return null;
    }
    return result.stdout;
  }

  /**
   * Parse one Prometheus metric out of an exposition text. Returns every label
   * set so a per-slice breakdown survives; comment lines are skipped.
   */
  parseMetric(text: string, metric: string): LiveMetricSample[] {
    const samples: LiveMetricSample[] = [];

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#') || !line.startsWith(metric)) {
        continue;
      }

      //Guard against a prefix match: registeredsubnbr must not match
      //registeredsubnbr_total, so the next char has to be '{' or whitespace.
      const next = line.charAt(metric.length);
      if (next !== '{' && next !== ' ' && next !== '\t') {
        continue;
      }

      const labels: Record<string, string> = {};
      let remainder = line.slice(metric.length).trim();

      if (remainder.startsWith('{')) {
        const close = remainder.indexOf('}');
        if (close === -1) {
          continue;
        }
        const labelBody = remainder.slice(1, close);
        remainder = remainder.slice(close + 1).trim();

        for (const pair of this.splitLabels(labelBody)) {
          const eq = pair.indexOf('=');
          if (eq === -1) {
            continue;
          }
          const key = pair.slice(0, eq).trim();
          const value = pair.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
          labels[key] = value;
        }
      }

      const value = Number.parseFloat(remainder.split(/\s+/)[0]);
      if (Number.isFinite(value)) {
        samples.push({ labels, value });
      }
    }

    return samples;
  }

  private splitLabels(body: string): string[] {
    //Split on commas that sit outside quotes; label values may contain commas.
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;

    for (const char of body) {
      if (char === '"') {
        inQuotes = !inQuotes;
        current += char;
      } else if (char === ',' && !inQuotes) {
        parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim().length > 0) {
      parts.push(current);
    }
    return parts;
  }

  private sumAcross(
    texts: string[],
    metric: string,
  ): { total: number | null; samples: LiveMetricSample[] } {
    const samples: LiveMetricSample[] = [];
    for (const text of texts) {
      samples.push(...this.parseMetric(text, metric));
    }
    if (samples.length === 0) {
      return { total: null, samples };
    }
    return {
      total: samples.reduce((sum, s) => sum + s.value, 0),
      samples,
    };
  }

  private toSliceCounts(samples: LiveMetricSample[]): LiveSliceCount[] {
    return samples
      .filter((s) => s.labels.plmnid !== undefined || s.labels.snssai !== undefined)
      .map((s) => ({
        plmnId: s.labels.plmnid || 'unknown',
        snssai: s.labels.snssai || 'unknown',
        value: s.value,
      }));
  }

  // ── RAN-side detail ──

  private async collectFromPod(pod: PodRef): Promise<LiveUe[]> {
    const nrCli = await this.resolveNrCli(pod);
    if (!nrCli) {
      this.logger.debug({ pod: pod.name }, 'nr-cli not found in UE pod');
      return [];
    }

    const dump = await this.execInPod(pod, `${this.quote(nrCli)} --dump`);
    if (dump.exitCode !== 0) {
      return [];
    }

    const ueIds = dump.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^imsi-\d{5,15}$/.test(line))
      .slice(0, MAX_UES_PER_POD);

    const ues: LiveUe[] = [];
    for (const ueId of ueIds) {
      const [status, psList] = await Promise.all([
        this.execInPod(pod, `${this.quote(nrCli)} ${this.quote(ueId)} -e ${this.quote('status')}`),
        this.execInPod(pod, `${this.quote(nrCli)} ${this.quote(ueId)} -e ${this.quote('ps-list')}`),
      ]);

      const statusFields = this.parseNrCliStatus(status.exitCode === 0 ? status.stdout : '');
      ues.push({
        imsi: ueId.replace(/^imsi-/, ''),
        pod: pod.name,
        cmState: statusFields['cm-state'] || 'unknown',
        rmState: statusFields['rm-state'] || 'unknown',
        mmState: statusFields['mm-state'] || 'unknown',
        sessions: psList.exitCode === 0 ? this.parsePsList(psList.stdout) : [],
      });
    }

    return ues;
  }

  private async resolveNrCli(pod: PodRef): Promise<string | null> {
    //Known locations first, then a PATH lookup, which also prints an absolute
    //path. Anything relative is discarded rather than handed to exec.
    const known = NR_CLI_CANDIDATES.map(
      (candidate) => `[ -x ${this.quote(candidate)} ] && { echo ${this.quote(candidate)}; exit 0; }`,
    ).join('; ');
    const probe = `${known}; command -v nr-cli 2>/dev/null`;

    const result = await this.execInPod(pod, `sh -c ${this.quote(probe)}`);
    if (result.exitCode !== 0) {
      return null;
    }

    const found = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('/') && line.endsWith('nr-cli'));

    return found[0] || null;
  }

  /** `key: value` lines, one per line, as `nr-cli -e status` prints them. */
  parseNrCliStatus(output: string): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const line of output.split('\n')) {
      const match = line.match(/^\s*([a-z0-9-]+):\s*(.*)$/i);
      if (match) {
        fields[match[1].toLowerCase()] = match[2].trim();
      }
    }
    return fields;
  }

  /**
   * `nr-cli -e ps-list` prints one indented block per PDU session, with s-nssai
   * nested a level deeper. Indentation is the only thing separating sst/sd from
   * the session's own keys, so the nesting is tracked rather than flattened.
   */
  parsePsList(output: string): LivePduSession[] {
    const sessions: LivePduSession[] = [];
    let current: LivePduSession | null = null;
    let inSnssai = false;

    for (const rawLine of output.split('\n')) {
      if (rawLine.trim().length === 0) {
        continue;
      }

      const headerMatch = rawLine.match(/^PDU Session(\d+):/);
      if (headerMatch) {
        if (current) {
          sessions.push(current);
        }
        current = {
          id: Number.parseInt(headerMatch[1], 10),
          state: 'unknown',
          type: 'unknown',
          dnn: 'unknown',
          sst: 'unknown',
          sd: 'unknown',
          address: null,
        };
        inSnssai = false;
        continue;
      }

      if (!current) {
        continue;
      }

      const indent = rawLine.length - rawLine.trimStart().length;
      const fieldMatch = rawLine.match(/^\s*([a-z0-9-]+):\s*(.*)$/i);
      if (!fieldMatch) {
        continue;
      }

      const key = fieldMatch[1].toLowerCase();
      const value = fieldMatch[2].trim();

      if (key === 's-nssai') {
        inSnssai = true;
        continue;
      }
      //Anything back at the session's own indent ends the s-nssai block.
      if (inSnssai && indent <= 1) {
        inSnssai = false;
      }

      if (inSnssai) {
        if (key === 'sst') current.sst = value;
        if (key === 'sd') current.sd = value;
        continue;
      }

      if (key === 'state') current.state = value;
      if (key === 'session-type') current.type = value;
      if (key === 'apn' || key === 'dnn') current.dnn = value;
      if (key === 'address') current.address = value || null;
    }

    if (current) {
      sessions.push(current);
    }
    return sessions;
  }

  // ── Cluster plumbing ──

  /** Returns null when the cluster is usable, or the reason it is not. */
  private async clusterReachable(): Promise<string | null> {
    const kubectl = await this.runHostShell('command -v kubectl >/dev/null 2>&1', 10000);
    if (kubectl.exitCode !== 0) {
      return 'kubectl is not installed on the host';
    }

    const cluster = await this.runHostShell('kubectl cluster-info >/dev/null 2>&1', KUBECTL_TIMEOUT_MS);
    if (cluster.exitCode !== 0) {
      return 'Kubernetes cluster is not reachable';
    }

    const ns = await this.runHostShell(
      `kubectl get namespace ${this.quote(this.namespace)} >/dev/null 2>&1`,
      KUBECTL_TIMEOUT_MS,
    );
    if (ns.exitCode !== 0) {
      return `Namespace "${this.namespace}" not found`;
    }

    return null;
  }

  private async listPods(selector: string): Promise<PodRef[]> {
    const jsonpath =
      '{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\\t"}{.spec.containers[0].name}{"\\n"}{end}';

    const result = await this.runHostShell(
      `kubectl get pods -n ${this.quote(this.namespace)} -l ${this.quote(selector)} -o jsonpath=${this.quote(jsonpath)}`,
      KUBECTL_TIMEOUT_MS,
    );

    if (result.exitCode !== 0) {
      this.logger.debug({ selector, stderr: result.stderr.trim() }, 'Pod listing failed');
      return [];
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, container] = line.split('\t');
        return { name, container: container || '' };
      })
      .filter((pod) => pod.name.length > 0);
  }

  /**
   * gNodeB pods with their addresses. The AMF's `gnb` gauge says how many are
   * associated but not which, and under Kubernetes the host's netstat cannot
   * see the NGAP association at all, so the peers are named from the cluster.
   */
  private async listGnbs(): Promise<LiveGnb[]> {
    const jsonpath =
      '{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\\t"}{.status.podIP}{"\\n"}{end}';

    const result = await this.runHostShell(
      `kubectl get pods -n ${this.quote(this.namespace)} -l ${this.quote('nf=gnb')} -o jsonpath=${this.quote(jsonpath)}`,
      KUBECTL_TIMEOUT_MS,
    );

    if (result.exitCode !== 0) {
      return [];
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [pod, ip] = line.split('\t');
        return { pod, ip: ip || '' };
      })
      .filter((gnb) => gnb.pod.length > 0 && gnb.ip.length > 0);
  }

  private execInPod(pod: PodRef, command: string): Promise<CommandResult> {
    const container = pod.container ? ` -c ${this.quote(pod.container)}` : '';
    return this.runHostShell(
      `kubectl exec -n ${this.quote(this.namespace)} ${this.quote(pod.name)}${container} -- ${command}`,
      EXEC_TIMEOUT_MS,
    );
  }

  //Same host hop as K8sLabUseCase: the NMS container has no kubectl or
  //kubeconfig of its own, so every call runs as the host's cluster user.
  private hostShellArgv(command: string): string[] {
    const hostHome = path.dirname(path.dirname(this.kubeconfigPath));
    const hostCommand = `export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin KUBECONFIG=${this.quote(this.kubeconfigPath)}; ${command}`;

    return ['-n', '-u', this.executionUser, '-H', 'env', `HOME=${hostHome}`, '/bin/bash', '-lc', hostCommand];
  }

  private runHostShell(command: string, timeoutMs: number): Promise<CommandResult> {
    return this.hostExecutor.executeCommand('/usr/bin/sudo', this.hostShellArgv(command), timeoutMs);
  }

  private quote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
}
