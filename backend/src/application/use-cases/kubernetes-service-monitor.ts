import * as path from 'path';
import pino from 'pino';
import { ServiceMonitorUseCase } from './service-monitor';
import { IHostExecutor, CommandResult } from '../../domain/interfaces/host-executor';
import { IWebSocketBroadcaster } from '../../domain/interfaces/websocket-broadcaster';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import {
  ServiceName,
  ServiceStatus,
  SERVICE_RESTART_ORDER,
  SERVICE_UNIT_MAP,
} from '../../domain/entities/service-status';
import { ServiceActionDto, ServiceStatusDto } from '../dto';

interface KubernetesWorkload {
  apiVersion?: string;
  kind: 'Deployment' | 'StatefulSet';
  metadata: {
    name: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    replicas?: number;
  };
  status?: {
    readyReplicas?: number;
    availableReplicas?: number;
    replicas?: number;
  };
}

interface KubernetesWorkloadList {
  items?: KubernetesWorkload[];
}

interface WorkloadSnapshot {
  workloads: Map<ServiceName, KubernetesWorkload>;
  error: string | null;
}

interface ServiceActionResult {
  success: boolean;
  message: string;
}

export class KubernetesServiceMonitorUseCase extends ServiceMonitorUseCase {
  private readonly kubernetesStatusCache: Record<string, ServiceStatus> = {};

  constructor(
    private readonly kubernetesHostExecutor: IHostExecutor,
    wsBroadcaster: IWebSocketBroadcaster,
    private readonly kubernetesAuditLogger: IAuditLogger,
    private readonly kubernetesLogger: pino.Logger,
    private readonly kubeconfigPath: string,
    private readonly executionUser: string,
    private readonly namespace: string = 'open5gs',
  ) {
    super(kubernetesHostExecutor, wsBroadcaster, kubernetesAuditLogger, kubernetesLogger);
  }

  override async getAll(): Promise<ServiceStatusDto[]> {
    const snapshot = await this.loadWorkloads();

    return Object.keys(SERVICE_UNIT_MAP).map((name) =>
      this.toServiceStatus(name as ServiceName, snapshot),
    );
  }

  override async getOne(name: ServiceName): Promise<ServiceStatusDto> {
    return this.toServiceStatus(name, await this.loadWorkloads());
  }

  override async executeAction(dto: ServiceActionDto): Promise<ServiceActionResult> {
    const snapshot = await this.loadWorkloads();
    if (snapshot.error) {
      return {
        success: false,
        message: snapshot.error,
      };
    }

    const workload = snapshot.workloads.get(dto.service);
    if (!workload) {
      return {
        success: false,
        message: `${dto.service.toUpperCase()} is not deployed in namespace ${this.namespace}`,
      };
    }

    return this.executeWorkloadAction(dto.service, dto.action, workload);
  }

  override async executeAllAction(
    action: 'start' | 'stop' | 'restart',
  ): Promise<{
    success: boolean;
    message: string;
    results: Array<{ service: string; success: boolean }>;
  }> {
    const snapshot = await this.loadWorkloads();
    if (snapshot.error) {
      return {
        success: false,
        message: snapshot.error,
        results: [],
      };
    }

    const orderedServices = action === 'stop'
      ? [...SERVICE_RESTART_ORDER].reverse()
      : SERVICE_RESTART_ORDER;
    const deployedServices = orderedServices.filter((service) => snapshot.workloads.has(service));
    const results: Array<{ service: string; success: boolean }> = [];

    for (const service of deployedServices) {
      const workload = snapshot.workloads.get(service);
      if (!workload) continue;

      const result = await this.executeWorkloadAction(service, action, workload);
      results.push({ service, success: result.success });
      if (!result.success) {
        this.kubernetesLogger.warn(
          { service, action, message: result.message },
          'Kubernetes service action failed, continuing with remaining workloads',
        );
      }
    }

    const allSuccess = results.length > 0 && results.every((result) => result.success);
    return {
      success: allSuccess,
      message: results.length === 0
        ? `No managed Open5GS workloads found in namespace ${this.namespace}`
        : allSuccess
          ? `All deployed services ${action} successful`
          : `Some deployed services failed to ${action}`,
      results,
    };
  }

  override getStatusCache(): Record<string, ServiceStatus> {
    return { ...this.kubernetesStatusCache };
  }

  private async executeWorkloadAction(
    service: ServiceName,
    action: ServiceActionDto['action'],
    workload: KubernetesWorkload,
  ): Promise<ServiceActionResult> {
    if (action === 'enable' || action === 'disable') {
      return {
        success: false,
        message: 'Boot enable/disable does not apply to Kubernetes workloads',
      };
    }

    const resource = `${workload.kind.toLowerCase()}/${workload.metadata.name}`;
    const desiredReplicas = workload.spec?.replicas ?? 0;
    let result: CommandResult;

    if (action === 'start') {
      result = await this.runKubectl(['-n', this.namespace, 'scale', resource, '--replicas=1']);
    } else if (action === 'stop') {
      result = await this.runKubectl(['-n', this.namespace, 'scale', resource, '--replicas=0']);
    } else {
      if (desiredReplicas === 0) {
        return {
          success: false,
          message: `${service.toUpperCase()} is scaled down; start it before restarting`,
        };
      }
      result = await this.runKubectl(['-n', this.namespace, 'rollout', 'restart', resource]);
    }

    const success = result.exitCode === 0;
    const detail = (result.stderr || result.stdout).trim();
    await this.kubernetesAuditLogger.log({
      action: `service_${action}` as any,
      user: 'admin',
      target: service,
      details: success ? `${action} successful via Kubernetes` : detail,
      success,
    });

    return {
      success,
      message: success
        ? `Service ${service} ${action} successful`
        : detail || `Failed to ${action} ${service}`,
    };
  }

  private async loadWorkloads(): Promise<WorkloadSnapshot> {
    const result = await this.runKubectl([
      '-n',
      this.namespace,
      'get',
      'deployments,statefulsets',
      '-o',
      'json',
    ]);

    if (result.exitCode !== 0) {
      const error = (result.stderr || result.stdout).trim() || 'Kubernetes cluster is unavailable';
      this.kubernetesLogger.warn({ error }, 'Unable to query Kubernetes service workloads');
      return {
        workloads: new Map(),
        error,
      };
    }

    try {
      const payload = JSON.parse(result.stdout) as KubernetesWorkloadList;
      const workloads = new Map<ServiceName, KubernetesWorkload>();

      for (const workload of payload.items ?? []) {
        const service = workload.metadata.labels?.nf as ServiceName | undefined;
        if (service && service in SERVICE_UNIT_MAP) {
          workloads.set(service, workload);
        }
      }

      return { workloads, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.kubernetesLogger.error({ error: message }, 'Invalid kubectl workload response');
      return {
        workloads: new Map(),
        error: `Unable to parse Kubernetes workload status: ${message}`,
      };
    }
  }

  private toServiceStatus(
    name: ServiceName,
    snapshot: WorkloadSnapshot,
  ): ServiceStatusDto {
    const workload = snapshot.workloads.get(name);
    const now = new Date().toISOString();

    if (!workload) {
      const status: ServiceStatus = {
        name,
        unitName: `deployment/open5gs-${name}`,
        active: false,
        enabled: false,
        state: 'unavailable',
        subState: snapshot.error ? 'context-error' : 'not-deployed',
        pid: null,
        uptime: null,
        restartCount: 0,
        cpuPercent: null,
        memoryBytes: null,
        memoryPercent: null,
        lastChecked: now,
        source: 'kubernetes',
        available: false,
        statusMessage: snapshot.error || `Not deployed in namespace ${this.namespace}`,
        workload: null,
        desiredReplicas: 0,
        readyReplicas: 0,
      };
      this.kubernetesStatusCache[name] = status;
      return status;
    }

    const desiredReplicas = workload.spec?.replicas ?? 0;
    const readyReplicas = workload.status?.readyReplicas ?? 0;
    const active = desiredReplicas > 0 && readyReplicas >= desiredReplicas;
    const state = desiredReplicas === 0 ? 'inactive' : active ? 'active' : 'activating';
    const subState = desiredReplicas === 0
      ? 'scaled-down'
      : active
        ? 'running'
        : `${readyReplicas}/${desiredReplicas} ready`;
    const resource = `${workload.kind.toLowerCase()}/${workload.metadata.name}`;

    const status: ServiceStatus = {
      name,
      unitName: resource,
      active,
      enabled: desiredReplicas > 0,
      state,
      subState,
      pid: null,
      uptime: workload.metadata.creationTimestamp ?? null,
      restartCount: 0,
      cpuPercent: null,
      memoryBytes: null,
      memoryPercent: null,
      lastChecked: now,
      source: 'kubernetes',
      available: true,
      statusMessage: active
        ? `${readyReplicas}/${desiredReplicas} replicas ready`
        : subState,
      workload: resource,
      desiredReplicas,
      readyReplicas,
    };
    this.kubernetesStatusCache[name] = status;
    return status;
  }

  private runKubectl(args: string[], timeoutMs: number = 30000): Promise<CommandResult> {
    const hostHome = path.dirname(path.dirname(this.kubeconfigPath));
    return this.kubernetesHostExecutor.executeCommand(
      '/usr/bin/sudo',
      [
        '-n',
        '-u',
        this.executionUser,
        '-H',
        'env',
        `HOME=${hostHome}`,
        `KUBECONFIG=${this.kubeconfigPath}`,
        '/usr/bin/kubectl',
        ...args,
      ],
      timeoutMs,
    );
  }
}
