import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';

// ─────────────────────────────────────────────────────────────
// Mongo URI Resolver
//
// The subscriber database the 5G core reads is not always at a fixed address.
// A native or docker Open5GS keeps it on localhost, but the k8s lab runs it as
// a Service in the cluster whose ClusterIP is reassigned every time the lab is
// torn down and brought back up. Pointing MONGODB_URI at localhost in that
// deployment gives a working API on an empty database that no NF ever reads,
// which looks like a UI bug and is not one.
//
// So when MONGODB_K8S_SERVICE is set to "<namespace>/<service>" the address is
// resolved from the cluster instead of being configured, and re-resolved on
// every reconnect. Leave it unset and MONGODB_URI is used verbatim.
// ─────────────────────────────────────────────────────────────

export class MongoAddressUnavailableError extends Error {
  constructor(service: string, detail: string) {
    super(
      `Could not resolve the MongoDB address of Service ${service}: ${detail}. ` +
        'Is the lab running?',
    );
    this.name = 'MongoAddressUnavailableError';
  }
}

export class MongoUriResolver {
  constructor(
    private readonly staticUri: string,
    private readonly k8sService: string | null,
    private readonly hostExecutor: IHostExecutor,
    private readonly kubeconfigPath: string,
    private readonly executionUser: string,
    private readonly logger: pino.Logger,
  ) {}

  /** True when the address is looked up in the cluster rather than configured. */
  get isDynamic(): boolean {
    return this.k8sService !== null;
  }

  describe(): string {
    return this.k8sService ? `Service ${this.k8sService}` : this.staticUri;
  }

  async resolve(): Promise<string> {
    if (!this.k8sService) {
      return this.staticUri;
    }

    const [namespace, name] = this.splitService(this.k8sService);
    const result = await this.runKubectl([
      '-n',
      namespace,
      'get',
      'service',
      name,
      '-o',
      'jsonpath={.spec.clusterIP} {.spec.ports[0].port}',
    ]);

    if (result.exitCode !== 0) {
      throw new MongoAddressUnavailableError(
        this.k8sService,
        (result.stderr || result.stdout).trim() || `kubectl exited ${result.exitCode}`,
      );
    }

    const [clusterIP, port] = result.stdout.trim().split(/\s+/);
    if (!clusterIP || clusterIP === 'None') {
      throw new MongoAddressUnavailableError(
        this.k8sService,
        `the Service has no ClusterIP (got "${clusterIP || 'empty response'}")`,
      );
    }

    const uri = `mongodb://${clusterIP}:${port || '27017'}/${this.databaseName()}`;
    this.logger.info({ service: this.k8sService, uri }, 'Resolved MongoDB address from cluster');
    return uri;
  }

  /**
   * The address without the database path. mongodump and mongorestore work on a
   * whole dump directory, and naming a database in the URI makes mongorestore
   * refuse a dump that holds more than one, so only the address is swapped and
   * their existing semantics are left alone.
   */
  async resolveServerUri(): Promise<string> {
    const uri = await this.resolve();
    const parts = uri.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/);
    if (!parts) {
      return uri;
    }
    //mongodb://host?opts is not a valid URI, the empty database path stays
    return parts[2] ? `${parts[1]}/${parts[2]}` : parts[1];
  }

  /** The database name to keep, taken from the configured URI so both agree. */
  databaseName(): string {
    const path = this.staticUri.split('/').pop() ?? '';
    const name = path.split('?')[0];
    return name || 'open5gs';
  }

  private splitService(service: string): [string, string] {
    const parts = service.split('/').filter(Boolean);
    if (parts.length !== 2) {
      throw new Error(
        `MONGODB_K8S_SERVICE must be "<namespace>/<service>", got "${service}"`,
      );
    }
    return [parts[0], parts[1]];
  }

  private runKubectl(args: string[]) {
    //Same route the service monitor and the lab actions take: kubectl on the
    //host, as the user that owns the kubeconfig
    return this.hostExecutor.executeCommand(
      '/usr/bin/sudo',
      [
        '-n',
        '-u',
        this.executionUser,
        'env',
        `KUBECONFIG=${this.kubeconfigPath}`,
        '/usr/bin/kubectl',
        ...args,
      ],
      15000,
    );
  }
}
