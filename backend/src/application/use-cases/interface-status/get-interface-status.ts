import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../../domain/interfaces/config-repository';
import { ActiveSessionsUseCase, ActiveUE } from '../active-sessions';
import {
  LiveSessionsUseCase,
  LiveSessionCounts,
  LiveUeDetail,
} from '../live-sessions';

export interface InterfaceStatus {
  // 4G Interfaces
  s1mme: {
    active: boolean;
    connectedEnodebs: string[];  // IP addresses
  };
  s1u: {
    active: boolean;
    connectedEnodebs: string[];  // IP addresses
  };
  // 5G Interfaces
  n2: {
    active: boolean;
    connectedGnodebs: string[];  // IP addresses
  };
  n3: {
    active: boolean;
    connectedGnodebs: string[];  // IP addresses
  };
  // Separated Active Sessions
  activeUEs4G: ActiveUE[];  // 4G only
  activeUEs5G: ActiveUE[];  // 5G only
  /**
   * Counts as the core itself reports them (AMF/SMF metrics). Null when the
   * deployment is not on Kubernetes, in which case the host checks above are
   * the only source.
   */
  live: LiveSessionCounts | null;
  /** Per-UE rows, only when the caller asked for them; null otherwise. */
  liveUEs: LiveUeDetail | null;
  /** Which source filled activeUEs5G, so the UI need not guess. */
  sessionSource: 'live-metrics' | 'host-conntrack';
}

export interface InterfaceStatusOptions {
  /**
   * Walk the UE pods for per-UE detail. Costs several execs per UE, so a
   * status poll leaves it off and a UE view turns it on.
   */
  includeUeDetail?: boolean;
}

export class GetInterfaceStatus {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
    private readonly activeSessionsUseCase: ActiveSessionsUseCase,
    private readonly configRepo: IConfigRepository,
    private readonly liveSessionsUseCase: LiveSessionsUseCase,
  ) {}

  async execute(options: InterfaceStatusOptions = {}): Promise<InterfaceStatus> {
    //Ask the core first. Whether it answers decides where everything below
    //comes from, because the host checks cannot see a containerised core.
    const live = await this.readLiveCounts();

    const [s1mmeStatus, s1uStatus] = await Promise.all([this.checkS1MME(), this.checkS1U()]);

    //No eNodeB on this host means there is no 4G RAN to hold sessions, so the
    //subnet-and-conntrack scan is skipped rather than run to find nothing. On a
    //5G-only or containerised deployment that scan has no source to read: the
    //NF configs are not in CONFIG_PATH and UE traffic never crosses the host's
    //conntrack, and it logged a "no session pools found" round on every poll.
    const has4gRan = s1mmeStatus.active || s1uStatus.active;

    let activeUEs4G: ActiveUE[] = [];
    if (has4gRan) {
      try {
        activeUEs4G = await this.activeSessionsUseCase.getActive4GUEs();
      } catch (error) {
        this.logger.error({ error }, 'Error getting active 4G UE sessions');
      }
    }

    if (live?.available) {
      return this.fromLive(live, s1mmeStatus, s1uStatus, activeUEs4G, options);
    }

    //Bare-metal Open5GS: the NFs run on this host, so netstat and conntrack
    //genuinely see the interfaces and this is still the right answer.
    const n2Status = await this.checkN2();
    const n3Status = await this.checkN3();

    let activeUEs5G: ActiveUE[] = [];
    if (n2Status.active || n3Status.active) {
      try {
        activeUEs5G = await this.activeSessionsUseCase.getActive5GUEs();
      } catch (error) {
        this.logger.error({ error }, 'Error getting active 5G UE sessions');
      }
    }

    return {
      s1mme: s1mmeStatus,
      s1u: s1uStatus,
      n2: n2Status,
      n3: n3Status,
      activeUEs4G,
      activeUEs5G,
      live,
      liveUEs: null,
      sessionSource: 'host-conntrack',
    };
  }

  private async readLiveCounts(): Promise<LiveSessionCounts | null> {
    try {
      return await this.liveSessionsUseCase.getCounts();
    } catch (error) {
      this.logger.error({ error }, 'Error reading live session counts');
      return null;
    }
  }

  /**
   * Build the 5G half from what the network reports. N2 peers are the gNodeB
   * pods the AMF is associated with; N3 is treated as up once the SMF holds a
   * PDU session, since the user plane terminates inside the UPF pod and no
   * host-side table can confirm it.
   */
  private async fromLive(
    live: LiveSessionCounts,
    s1mmeStatus: InterfaceStatus['s1mme'],
    s1uStatus: InterfaceStatus['s1u'],
    activeUEs4G: ActiveUE[],
    options: InterfaceStatusOptions,
  ): Promise<InterfaceStatus> {
    const gnbIPs = live.gnbs.map((gnb) => gnb.ip);

    let liveUEs: LiveUeDetail | null = null;
    if (options.includeUeDetail) {
      try {
        liveUEs = await this.liveSessionsUseCase.getUeDetail();
      } catch (error) {
        this.logger.error({ error }, 'Error reading live UE detail');
      }
    }

    //One row per PDU session: a UE with three sessions holds three UE IPs, and
    //each is separately routable, so collapsing them would lose addresses.
    const activeUEs5G: ActiveUE[] = (liveUEs?.ues || []).flatMap((ue) =>
      ue.sessions
        .filter((session) => session.address)
        .map((session) => ({ ip: session.address as string, imsi: ue.imsi })),
    );

    this.logger.info(
      {
        registered: live.registeredSubscribers,
        sessions: live.activePduSessions,
        gnbs: gnbIPs.length,
        ueDetail: options.includeUeDetail,
      },
      'Interface status served from live core metrics',
    );

    return {
      s1mme: s1mmeStatus,
      s1u: s1uStatus,
      n2: {
        active: (live.gnbCount || 0) > 0,
        connectedGnodebs: gnbIPs,
      },
      n3: {
        active: (live.activePduSessions || 0) > 0,
        connectedGnodebs: gnbIPs,
      },
      activeUEs4G,
      activeUEs5G,
      live,
      liveUEs,
      sessionSource: 'live-metrics',
    };
  }

  /**
   * Get AMF NGAP interface IP address from config
   */
  private async getAmfNgapInterface(): Promise<string | null> {
    try {
      const amfConfig = await this.configRepo.loadAmf();
      const amfRaw = amfConfig as any;
      
      // Try different config paths
      const ngapAddr = amfRaw?.ngap?.server?.[0]?.address || 
                       amfRaw?.ngap?.addr || 
                       amfRaw?.rawYaml?.amf?.ngap?.server?.[0]?.address ||
                       amfRaw?.rawYaml?.amf?.ngap?.addr;
      
      this.logger.info({ ngapAddr }, 'AMF NGAP interface address');
      return ngapAddr || null;
    } catch (error) {
      this.logger.error({ error }, 'Failed to read AMF NGAP interface');
      return null;
    }
  }

  /**
   * Get all IP addresses assigned to host network interfaces
   * This detects the actual host IPs, not just config values
   */
  private async getHostNetworkIPs(): Promise<string[]> {
    try {
      // Run: ip -4 addr show | grep -oP '(?<=inet\s)\d+(\.\d+){3}'
      const result = await this.hostExecutor.executeCommand('bash', [
        '-c',
        "ip -4 addr show | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}' | grep -v '^127\\.' | sort -u"
      ]);
      
      if (result.exitCode !== 0) {
        this.logger.warn({ stderr: result.stderr }, 'Failed to get host network IPs');
        return [];
      }

      const ips = result.stdout.split('\n').filter(line => line.trim().length > 0);
      this.logger.info({ hostIPs: ips }, 'Detected host network interface IPs');
      
      return ips;
    } catch (error) {
      this.logger.error({ error }, 'Error detecting host network IPs');
      return [];
    }
  }

  /**
   * Get SGW-U GTPU interface IP from config and verify it exists on host
   * Returns only IPs that are BOTH in config AND assigned to host interfaces
   */
  private async getVerifiedSgwuGtpuIP(): Promise<string | null> {
    try {
      // Step 1: Extract IP from SGW-U YAML config
      const sgwuConfig = await this.configRepo.loadSgwu();
      const sgwuRaw = sgwuConfig as any;
      
      const gtpuAddr = sgwuRaw?.gtpu?.server?.[0]?.address ||
                       sgwuRaw?.gtpu?.addr ||
                       sgwuRaw?.rawYaml?.sgwu?.gtpu?.server?.[0]?.address ||
                       sgwuRaw?.rawYaml?.sgwu?.gtpu?.addr;
      
      if (!gtpuAddr) {
        this.logger.warn('No SGW-U GTPU address found in config');
        return null;
      }

      // Step 2: Get actual host IPs
      const hostIPs = await this.getHostNetworkIPs();

      // Step 3: Verify the config IP exists on the host
      if (hostIPs.includes(gtpuAddr)) {
        this.logger.info({ gtpuAddr, verified: true }, 'SGW-U GTPU IP verified on host interface');
        return gtpuAddr;
      } else {
        this.logger.warn({ gtpuAddr, hostIPs, verified: false }, 'SGW-U GTPU IP from config NOT found on host interfaces');
        return null;
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to get verified SGW-U GTPU IP');
      return null;
    }
  }

  /**
   * Get UPF GTPU interface IP from config and verify it exists on host
   * Returns only IPs that are BOTH in config AND assigned to host interfaces
   */
  private async getVerifiedUpfGtpuIP(): Promise<string | null> {
    try {
      // Step 1: Extract IP from UPF YAML config
      const upfConfig = await this.configRepo.loadUpf();
      const upfRaw = upfConfig as any;
      
      const gtpuAddr = upfRaw?.gtpu?.server?.[0]?.address ||
                       upfRaw?.gtpu?.addr ||
                       upfRaw?.rawYaml?.upf?.gtpu?.server?.[0]?.address ||
                       upfRaw?.rawYaml?.upf?.gtpu?.addr;
      
      if (!gtpuAddr) {
        this.logger.warn('No UPF GTPU address found in config');
        return null;
      }

      // Step 2: Get actual host IPs
      const hostIPs = await this.getHostNetworkIPs();

      // Step 3: Verify the config IP exists on the host
      if (hostIPs.includes(gtpuAddr)) {
        this.logger.info({ gtpuAddr, verified: true }, 'UPF GTPU IP verified on host interface');
        return gtpuAddr;
      } else {
        this.logger.warn({ gtpuAddr, hostIPs, verified: false }, 'UPF GTPU IP from config NOT found on host interfaces');
        return null;
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to get verified UPF GTPU IP');
      return null;
    }
  }

  /**
   * Get AMF NGAP interface IP from config and verify it exists on host
   * Returns only IPs that are BOTH in config AND assigned to host interfaces
   */
  private async getVerifiedAmfNgapIP(): Promise<string | null> {
    try {
      // Step 1: Extract IP from AMF YAML config
      const amfConfig = await this.configRepo.loadAmf();
      const amfRaw = amfConfig as any;
      
      const ngapAddr = amfRaw?.ngap?.server?.[0]?.address || 
                       amfRaw?.ngap?.addr || 
                       amfRaw?.rawYaml?.amf?.ngap?.server?.[0]?.address ||
                       amfRaw?.rawYaml?.amf?.ngap?.addr;
      
      if (!ngapAddr) {
        this.logger.warn('No AMF NGAP address found in config');
        return null;
      }

      // Step 2: Get actual host IPs
      const hostIPs = await this.getHostNetworkIPs();

      // Step 3: Verify the config IP exists on the host
      if (hostIPs.includes(ngapAddr)) {
        this.logger.info({ ngapAddr, verified: true }, 'AMF NGAP IP verified on host interface');
        return ngapAddr;
      } else {
        this.logger.warn({ ngapAddr, hostIPs, verified: false }, 'AMF NGAP IP from config NOT found on host interfaces');
        return null;
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to get verified AMF NGAP IP');
      return null;
    }
  }

  private async checkS1MME(): Promise<{ active: boolean; connectedEnodebs: string[] }> {
    try {
      // Run: netstat -an | grep 36412 | grep ESTABLISHED
      const result = await this.hostExecutor.executeCommand('netstat', ['-an']);
      
      this.logger.info({ exitCode: result.exitCode, stdoutLength: result.stdout.length }, 'netstat command result');
      
      if (result.exitCode !== 0) {
        this.logger.warn({ stderr: result.stderr }, 'Failed to run netstat for S1-MME check');
        return { active: false, connectedEnodebs: [] };
      }

      // Parse output for SCTP connections on port 36412
      const lines = result.stdout.split('\n');
      const connectedIPs: string[] = [];
      
      this.logger.info({ totalLines: lines.length }, 'Parsing netstat output');
      
      for (const line of lines) {
        // Look for: sctp ... 10.0.1.175:36412 10.0.1.102:36412 ESTABLISHED
        if (line.includes('36412') && line.includes('ESTABLISHED') && line.includes('sctp')) {
          this.logger.info({ line }, 'Found SCTP connection on port 36412');
          const parts = line.trim().split(/\s+/);
          // Format: sctp 0 0 LOCAL_IP:36412 REMOTE_IP:36412 ESTABLISHED
          if (parts.length >= 5) {
            const remoteAddr = parts[4]; // e.g., "10.0.1.102:36412"
            const ip = remoteAddr.split(':')[0];
            if (ip && !connectedIPs.includes(ip)) {
              connectedIPs.push(ip);
              this.logger.info({ ip }, 'Added eNodeB IP');
            }
          }
        }
      }
      
      this.logger.info({ connectedIPs, count: connectedIPs.length }, 'S1-MME check complete');

      return {
        active: connectedIPs.length > 0,
        connectedEnodebs: connectedIPs,
      };
    } catch (error) {
      this.logger.error({ error }, 'Error checking S1-MME interface status');
      return { active: false, connectedEnodebs: [] };
    }
  }

  private async checkS1U(): Promise<{ active: boolean; connectedEnodebs: string[] }> {
    try {
      // Run: conntrack -L -p udp --dport 2152 | grep -oP 'src=\K[0-9.]+' | grep -vE '10\.0\.1\.175|10\.0\.1\.155' | sort -u
      const result = await this.hostExecutor.executeCommand('bash', [
        '-c',
        "conntrack -L -p udp --dport 2152 | grep -oP 'src=\\K[0-9.]+' | grep -vE '10\\.0\\.1\\.175|10\\.0\\.1\\.155' | sort -u"
      ]);
      
      this.logger.info({ exitCode: result.exitCode, stdoutLength: result.stdout.length }, 'conntrack command result');
      
      if (result.exitCode !== 0) {
        this.logger.warn({ stderr: result.stderr }, 'Failed to run conntrack for S1-U check');
        return { active: false, connectedEnodebs: [] };
      }

      // Parse output - each line is an IP
      const lines = result.stdout.split('\n').filter(line => line.trim().length > 0);
      const connectedIPs: string[] = [];
      
      this.logger.info({ totalLines: lines.length }, 'Parsing conntrack output');
      
      for (const line of lines) {
        const ip = line.trim();
        // Validate it's an IP address
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          connectedIPs.push(ip);
          this.logger.info({ ip }, 'Found S1-U connected eNodeB');
        }
      }
      
      this.logger.info({ connectedIPs, count: connectedIPs.length }, 'S1-U check complete');

      return {
        active: connectedIPs.length > 0,
        connectedEnodebs: connectedIPs,
      };
    } catch (error) {
      this.logger.error({ error }, 'Error checking S1-U interface status');
      return { active: false, connectedEnodebs: [] };
    }
  }

  /**
   * Check N2 interface (AMF ↔ gNodeB) - SCTP port 38412
   * Filtered to AMF NGAP interface only (verified from config + host)
   * Also filters out any IPs that appear in 4G S1-MME (dual-mode radios)
   */
  private async checkN2(): Promise<{ active: boolean; connectedGnodebs: string[] }> {
    try {
      // Get verified AMF NGAP interface IP (must be in config AND on host)
      const ngapIP = await this.getVerifiedAmfNgapIP();
      if (!ngapIP) {
        this.logger.warn('No verified AMF NGAP interface found, skipping N2 check');
        return { active: false, connectedGnodebs: [] };
      }

      // Get S1-MME IPs first (these are 4G eNodeBs that might also be dual-mode)
      const s1mmeStatus = await this.checkS1MME();
      const s1mmeIPs = s1mmeStatus.connectedEnodebs;

      // N2 uses SCTP on port 38412, filtered to AMF NGAP interface
      const result = await this.hostExecutor.executeCommand('netstat', ['-an']);
      
      this.logger.info({ exitCode: result.exitCode, stdoutLength: result.stdout.length }, 'netstat command result for N2');
      
      if (result.exitCode !== 0) {
        this.logger.warn({ stderr: result.stderr }, 'Failed to run netstat for N2 check');
        return { active: false, connectedGnodebs: [] };
      }

      const lines = result.stdout.split('\n');
      const connectedIPs: string[] = [];
      
      this.logger.info({ totalLines: lines.length }, 'Parsing netstat output for N2');
      
      for (const line of lines) {
        // Look for: sctp ... AMF_NGAP_IP:38412 GNODEB_IP:38412 ESTABLISHED
        if (line.includes('38412') && 
            line.includes('ESTABLISHED') && 
            line.includes('sctp') &&
            line.includes(ngapIP)) {  // FILTER TO VERIFIED AMF NGAP INTERFACE
          
          this.logger.info({ line }, 'Found SCTP connection on port 38412 (N2)');
          const parts = line.trim().split(/\s+/);
          
          if (parts.length >= 5) {
            const remoteAddr = parts[4]; // e.g., "10.0.2.101:38412"
            const ip = remoteAddr.split(':')[0];
            if (ip && !connectedIPs.includes(ip)) {
              connectedIPs.push(ip);
              this.logger.info({ ip }, 'Added gNodeB IP (N2)');
            }
          }
        }
      }
      
      // Filter out any IPs that also appear in S1-MME (dual-mode radios)
      const pureGnodebIPs = connectedIPs.filter(ip => !s1mmeIPs.includes(ip));
      
      this.logger.info({ 
        allN2IPs: connectedIPs, 
        s1mmeIPs, 
        filtered5GOnly: pureGnodebIPs, 
        count: pureGnodebIPs.length 
      }, 'N2 check complete (filtered out dual-mode 4G radios)');

      return {
        active: pureGnodebIPs.length > 0,
        connectedGnodebs: pureGnodebIPs,
      };
    } catch (error) {
      this.logger.error({ error }, 'Error checking N2 interface status');
      return { active: false, connectedGnodebs: [] };
    }
  }

  /**
   * Check N3 interface (UPF ↔ gNodeB) - GTP-U port 2152
   * Filtered to exclude S1-U eNodeBs and verified 4G/5G core infrastructure IPs
   * Also filters out any IPs that appear in 4G S1-U (dual-mode radios)
   */
  private async checkN3(): Promise<{ active: boolean; connectedGnodebs: string[] }> {
    try {
      // Get verified UPF GTPU interface IP (5G core - must be in config AND on host)
      const upfGtpuIP = await this.getVerifiedUpfGtpuIP();
      if (!upfGtpuIP) {
        this.logger.warn('No verified UPF GTPU interface found, skipping N3 check');
        return { active: false, connectedGnodebs: [] };
      }

      // Get verified SGW-U GTPU interface IP (4G core - must be in config AND on host)
      const sgwuGtpuIP = await this.getVerifiedSgwuGtpuIP();
      
      // Get S1-U IPs first (these are 4G eNodeBs that might also be dual-mode)
      const s1uStatus = await this.checkS1U();
      const s1uIPs = s1uStatus.connectedEnodebs;

      // Build filter pattern to exclude verified core IPs (both 4G and 5G)
      const escapeIP = (ip: string) => ip.replace(/\./g, '\\.');
      const coreIPs = [upfGtpuIP];
      if (sgwuGtpuIP) {
        coreIPs.push(sgwuGtpuIP);
      }
      const filterPattern = coreIPs.map(escapeIP).join('|');

      this.logger.info({ upfGtpuIP, sgwuGtpuIP, coreIPs, filterPattern }, 'N3 filter: excluding verified core GTPU IPs');

      // Query conntrack for all GTP-U traffic on port 2152, excluding core IPs
      const result = await this.hostExecutor.executeCommand('bash', [
        '-c',
        `conntrack -L -p udp --dport 2152 | grep -oP 'src=\\K[0-9.]+' | grep -vE '${filterPattern}' | sort -u`
      ]);
      
      this.logger.info({ exitCode: result.exitCode, stdoutLength: result.stdout.length }, 'conntrack command result for N3');
      
      if (result.exitCode !== 0) {
        this.logger.warn({ stderr: result.stderr }, 'Failed to run conntrack for N3 check');
        return { active: false, connectedGnodebs: [] };
      }

      const lines = result.stdout.split('\n').filter(line => line.trim().length > 0);
      const allGtpIPs: string[] = [];
      
      this.logger.info({ totalLines: lines.length }, 'Parsing conntrack output for N3');
      
      for (const line of lines) {
        const ip = line.trim();
        // Validate it's an IP address
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          allGtpIPs.push(ip);
        }
      }
      
      // Filter out S1-U eNodeB IPs to get only 5G gNodeB IPs (pure 5G radios)
      const pureGnodebIPs = allGtpIPs.filter(ip => !s1uIPs.includes(ip));
      
      pureGnodebIPs.forEach(ip => {
        this.logger.info({ ip }, 'Found N3 connected gNodeB (5G only)');
      });
      
      this.logger.info({ 
        allN3IPs: allGtpIPs, 
        s1uIPs, 
        filtered5GOnly: pureGnodebIPs, 
        count: pureGnodebIPs.length 
      }, 'N3 check complete (filtered out dual-mode 4G radios)');

      return {
        active: pureGnodebIPs.length > 0,
        connectedGnodebs: pureGnodebIPs,
      };
    } catch (error) {
      this.logger.error({ error }, 'Error checking N3 interface status');
      return { active: false, connectedGnodebs: [] };
    }
  }
}
