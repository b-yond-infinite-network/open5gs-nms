import { useEffect, useState } from 'react';
import {
  Radio,
  Activity,
  Users,
  Circle,
  Gauge,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { useTopologyStore } from '../../stores';

/** One core-reported number. A dash means the NF did not publish the gauge. */
const LiveStat: React.FC<{
  label: string;
  value: number | null;
  hint: string;
  sub?: string;
}> = ({ label, value, hint, sub }) => (
  <div className="border border-nms-border rounded-md px-4 py-3">
    <div className="text-2xl font-semibold font-display text-nms-text">
      {value === null ? '—' : value}
    </div>
    <div className="text-xs font-medium text-nms-text mt-1">{label}</div>
    <div className="text-xs text-nms-text-dim mt-0.5">{hint}</div>
    {sub && <div className="text-xs text-nms-accent mt-1">{sub}</div>}
  </div>
);

interface RANPageProps {
  onNavigateToSubscriber?: (imsi: string) => void;
}

export const RANPage: React.FC<RANPageProps> = ({ onNavigateToSubscriber }) => {
  const interfaceStatus = useTopologyStore((s) => s.interfaceStatus);
  const fetchInterfaceStatus = useTopologyStore((s) => s.fetchInterfaceStatus);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (imsi: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(imsi)) {
        next.delete(imsi);
      } else {
        next.add(imsi);
      }
      return next;
    });

  useEffect(() => {
    // This page is the UE session view, so it pays for the per-UE walk.
    const load = () => fetchInterfaceStatus({ detail: true });
    load();
    const interval = setInterval(load, 30000); // Poll every 30 seconds
    return () => clearInterval(interval);
  }, [fetchInterfaceStatus]);

  // Extract data
  const s1mmeActive = interfaceStatus?.s1mme?.active || false;
  const s1mmeEnodebs = interfaceStatus?.s1mme?.connectedEnodebs || [];
  
  const s1uActive = interfaceStatus?.s1u?.active || false;
  const s1uEnodebs = interfaceStatus?.s1u?.connectedEnodebs || [];
  
  const activeUEs4G = interfaceStatus?.activeUEs4G || [];
  const activeUEs5G = interfaceStatus?.activeUEs5G || [];
  const activeUEs = [...activeUEs4G, ...activeUEs5G]; // Combined 4G + 5G sessions

  const live = interfaceStatus?.live || null;
  const liveUEs = interfaceStatus?.liveUEs || null;
  const fromLiveMetrics = interfaceStatus?.sessionSource === 'live-metrics';

  // One subscriber per row, its PDU sessions folded underneath: a UE holding
  // Internet, IMS and SOS DNNs is one subscriber with three sessions, not three
  // unrelated rows. Falls back to the flat IP/IMSI pairs off the host checks,
  // which carry no DNN, so those group to one session each.
  const groups = (liveUEs?.ues || []).length > 0
    ? (liveUEs?.ues || []).map((ue) => ({
        imsi: ue.imsi,
        ueState: ue.rmState,
        connState: ue.cmState,
        sessions: ue.sessions.map((session) => ({
          key: `${ue.imsi}-${session.id}`,
          id: session.id,
          ip: session.address || '—',
          dnn: session.dnn,
          snssai: `${session.sst}/${session.sd}`,
          state: session.state,
        })),
      }))
    : Object.values(
        activeUEs.reduce<Record<string, { imsi: string; ueState: string; connState: string; sessions: Array<{ key: string; id: number; ip: string; dnn: string; snssai: string; state: string }> }>>(
          (acc, ue, idx) => {
            const group = acc[ue.imsi] || { imsi: ue.imsi, ueState: '—', connState: '—', sessions: [] };
            group.sessions.push({
              key: `${ue.imsi}-${idx}`,
              id: group.sessions.length + 1,
              ip: ue.ip,
              dnn: '—',
              snssai: '—',
              state: 'PS-ACTIVE',
            });
            acc[ue.imsi] = group;
            return acc;
          },
          {},
        ),
      );

  const totalSessions = groups.reduce((sum, group) => sum + group.sessions.length, 0);

  // The AMF counts contexts it still holds; the RAN read counts UEs that
  // answered. A UE stopped without deregistering leaves its context behind, so
  // the difference is stale state rather than a second opinion on the same
  // thing, and it is named as such instead of being averaged away.
  const registered = live?.registeredSubscribers ?? null;
  const staleContexts =
    fromLiveMetrics && registered !== null && liveUEs?.available
      ? registered - groups.length
      : 0;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold font-display text-nms-text mb-1">RAN Network</h1>
        <p className="text-sm text-nms-text-dim">Radio Access Network interface status and active sessions</p>
      </div>

      {/* Live counts, straight from the AMF and SMF */}
      <div className="nms-card mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className={`p-2 rounded-lg ${live?.available ? 'bg-nms-accent/10' : 'bg-nms-red/10'}`}>
            <Gauge className={`w-5 h-5 ${live?.available ? 'text-nms-accent' : 'text-nms-red'}`} />
          </div>
          <div>
            <h2 className="text-lg font-semibold font-display text-nms-text">Live Core Counts</h2>
            <p className="text-xs text-nms-text-dim">
              Contexts the AMF and SMF hold right now, read from their own metrics
            </p>
          </div>
          {live?.available && (
            <div className="ml-auto text-xs text-nms-text-dim">
              {new Date(live.scrapedAt).toLocaleTimeString()}
            </div>
          )}
        </div>

        {live?.available ? (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <LiveStat
                label="Registered Contexts"
                value={live.registeredSubscribers}
                hint="AMF, RM-REGISTERED"
                sub={
                  liveUEs?.available
                    ? `${groups.length} answering on RAN`
                    : undefined
                }
              />
              <LiveStat
                label="PDU Session Contexts"
                value={live.activePduSessions}
                hint="SMF, established"
                sub={liveUEs?.available ? `${totalSessions} answering on RAN` : undefined}
              />
              <LiveStat label="RAN UE Contexts" value={live.ranUeContexts} hint="AMF, NGAP contexts" />
              <LiveStat label="gNodeBs" value={live.gnbCount} hint="AMF, NG associations" />
            </div>

            <p className="text-xs text-nms-text-dim mt-3">
              These are live gauges, not totals — but a context only disappears when the UE
              deregisters and stays away. A UE that releases a session re-establishes it in well
              under a second, so a 30s poll lands on the same number either side of the dip.
            </p>
            {live.failedPods.length > 0 && (
              <p className="text-xs text-nms-text-dim mt-3">
                Not scraped: {live.failedPods.join(', ')}
              </p>
            )}
          </>
        ) : (
          <div className="text-sm text-nms-text-dim py-4">
            {live?.reason || 'Core metrics unavailable — interface status falls back to host checks.'}
          </div>
        )}
      </div>

      {/* Grid Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        
        {/* S1-MME Interface */}
        <div className="nms-card">
          <div className="flex items-center gap-3 mb-4">
            <div className={`p-2 rounded-lg ${s1mmeActive ? 'bg-nms-green/10' : 'bg-nms-red/10'}`}>
              <Radio className={`w-5 h-5 ${s1mmeActive ? 'text-nms-green' : 'text-nms-red'}`} />
            </div>
            <div>
              <h2 className="text-lg font-semibold font-display text-nms-text">S1-MME Interface</h2>
              <p className="text-xs text-nms-text-dim">Control Plane (MME ↔ eNodeB)</p>
            </div>
          </div>

          {/* Status Badge */}
          <div className="flex items-center gap-2 mb-4">
            <Circle className={`w-2 h-2 ${s1mmeActive ? 'fill-nms-green text-nms-green' : 'fill-nms-red text-nms-red'}`} />
            <span className={`text-sm font-medium ${s1mmeActive ? 'text-nms-green' : 'text-nms-red'}`}>
              {s1mmeActive ? 'Active' : 'Inactive'}
            </span>
            <span className="text-xs text-nms-text-dim ml-auto">
              {s1mmeEnodebs.length} {s1mmeEnodebs.length === 1 ? 'eNodeB' : 'eNodeBs'} connected
            </span>
          </div>

          {/* Connected eNodeBs */}
          {s1mmeEnodebs.length > 0 ? (
            <div className="border border-nms-border rounded-md overflow-hidden">
              <div className="bg-nms-surface-2 px-3 py-2 border-b border-nms-border">
                <span className="text-xs font-semibold text-nms-text">Connected eNodeBs</span>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {s1mmeEnodebs.map((ip, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between px-3 py-2 border-b border-nms-border last:border-b-0 hover:bg-nms-surface-2/50 transition-colors"
                  >
                    <span className="text-sm font-mono text-nms-text">{ip}</span>
                    <Circle className="w-2 h-2 fill-nms-green text-nms-green" />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-nms-text-dim text-sm">
              No eNodeBs connected
            </div>
          )}
        </div>

        {/* S1-U Interface */}
        <div className="nms-card">
          <div className="flex items-center gap-3 mb-4">
            <div className={`p-2 rounded-lg ${s1uActive ? 'bg-nms-green/10' : 'bg-nms-red/10'}`}>
              <Activity className={`w-5 h-5 ${s1uActive ? 'text-nms-green' : 'text-nms-red'}`} />
            </div>
            <div>
              <h2 className="text-lg font-semibold font-display text-nms-text">S1-U Interface</h2>
              <p className="text-xs text-nms-text-dim">User Plane (SGW-U ↔ eNodeB)</p>
            </div>
          </div>

          {/* Status Badge */}
          <div className="flex items-center gap-2 mb-4">
            <Circle className={`w-2 h-2 ${s1uActive ? 'fill-nms-green text-nms-green' : 'fill-nms-red text-nms-red'}`} />
            <span className={`text-sm font-medium ${s1uActive ? 'text-nms-green' : 'text-nms-red'}`}>
              {s1uActive ? 'Active' : 'Inactive'}
            </span>
            <span className="text-xs text-nms-text-dim ml-auto">
              {s1uEnodebs.length} {s1uEnodebs.length === 1 ? 'eNodeB' : 'eNodeBs'} connected
            </span>
          </div>

          {/* Connected eNodeBs */}
          {s1uEnodebs.length > 0 ? (
            <div className="border border-nms-border rounded-md overflow-hidden">
              <div className="bg-nms-surface-2 px-3 py-2 border-b border-nms-border">
                <span className="text-xs font-semibold text-nms-text">Connected eNodeBs</span>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {s1uEnodebs.map((ip, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between px-3 py-2 border-b border-nms-border last:border-b-0 hover:bg-nms-surface-2/50 transition-colors"
                  >
                    <span className="text-sm font-mono text-nms-text">{ip}</span>
                    <Circle className="w-2 h-2 fill-nms-green text-nms-green" />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-nms-text-dim text-sm">
              No eNodeBs connected
            </div>
          )}
        </div>
      </div>

      {/* Active UE Sessions - Full Width */}
      <div className="nms-card">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-nms-accent/10">
            <Users className="w-5 h-5 text-nms-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold font-display text-nms-text">Active UE Sessions</h2>
            <p className="text-xs text-nms-text-dim">
              {fromLiveMetrics
                ? 'Per-UE detail read from the UE simulator (RAN side)'
                : 'Connected user equipment with active PDN sessions'}
            </p>
          </div>
          <div className="ml-auto text-right">
            <div className="text-sm font-semibold text-nms-accent">
              {groups.length} {groups.length === 1 ? 'subscriber' : 'subscribers'}
            </div>
            <div className="text-xs text-nms-text-dim">
              {totalSessions} {totalSessions === 1 ? 'session' : 'sessions'}
            </div>
          </div>
        </div>

        {staleContexts > 0 && (
          <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-md bg-nms-surface-2 border border-nms-border">
            <AlertTriangle className="w-4 h-4 text-nms-accent mt-0.5 shrink-0" />
            <p className="text-xs text-nms-text-dim">
              The AMF holds {registered} registered context{registered === 1 ? '' : 's'} but only{' '}
              {groups.length} UE{groups.length === 1 ? '' : 's'} answered on the RAN side, so{' '}
              {staleContexts} belong{staleContexts === 1 ? 's' : ''} to a UE that stopped without
              deregistering. Those contexts, and their PDU sessions, keep counting until the AMF
              ages them out.
            </p>
          </div>
        )}

        {fromLiveMetrics && liveUEs && !liveUEs.available && (
          <p className="text-xs text-nms-text-dim mb-4">{liveUEs.reason}</p>
        )}

        {groups.length > 0 ? (
          <div className="border border-nms-border rounded-md overflow-hidden">
            <table className="w-full">
              <thead className="bg-nms-surface-2 border-b border-nms-border">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text uppercase tracking-wider">
                    IMSI
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text uppercase tracking-wider">
                    Sessions
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text uppercase tracking-wider">
                    DNNs
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-nms-text uppercase tracking-wider">
                    Registration
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nms-border">
                {groups.map((group) => {
                  const isOpen = expanded.has(group.imsi);
                  return [
                    <tr
                      key={group.imsi}
                      className="hover:bg-nms-surface-2/50 transition-colors cursor-pointer"
                      onClick={() => toggle(group.imsi)}
                    >
                      <td className="px-4 py-3 text-sm font-mono">
                        <div className="flex items-center gap-2">
                          {isOpen ? (
                            <ChevronDown className="w-4 h-4 text-nms-text-dim shrink-0" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-nms-text-dim shrink-0" />
                          )}
                          <button
                            onClick={(e) => {
                              //The row toggles; only the IMSI itself navigates.
                              e.stopPropagation();
                              onNavigateToSubscriber?.(group.imsi);
                            }}
                            className="text-nms-accent hover:text-nms-accent-hover hover:underline transition-colors cursor-pointer text-left"
                          >
                            {group.imsi}
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-nms-text">
                        {group.sessions.length}
                      </td>
                      <td className="px-4 py-3 text-sm text-nms-text-dim truncate max-w-xs">
                        {group.sessions.map((session) => session.dnn).join(', ')}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${
                            group.ueState === 'RM-REGISTERED'
                              ? 'bg-nms-green/10 text-nms-green'
                              : 'bg-nms-surface-2 text-nms-text-dim'
                          }`}
                        >
                          <Circle
                            className={`w-1.5 h-1.5 ${
                              group.ueState === 'RM-REGISTERED' ? 'fill-nms-green' : 'fill-nms-text-dim'
                            }`}
                          />
                          {group.ueState}
                        </span>
                      </td>
                    </tr>,
                    isOpen ? (
                      <tr key={`${group.imsi}-detail`} className="bg-nms-surface-2/30">
                        <td colSpan={4} className="px-4 py-3">
                          <table className="w-full">
                            <thead>
                              <tr>
                                <th className="px-3 py-2 text-left text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
                                  PDU
                                </th>
                                <th className="px-3 py-2 text-left text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
                                  DNN
                                </th>
                                <th className="px-3 py-2 text-left text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
                                  UE IP
                                </th>
                                <th className="px-3 py-2 text-left text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
                                  S-NSSAI
                                </th>
                                <th className="px-3 py-2 text-center text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
                                  State
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {group.sessions.map((session) => (
                                <tr key={session.key}>
                                  <td className="px-3 py-2 text-sm text-nms-text-dim">#{session.id}</td>
                                  <td className="px-3 py-2 text-sm text-nms-text">{session.dnn}</td>
                                  <td className="px-3 py-2 text-sm font-mono text-nms-text">
                                    {session.ip}
                                  </td>
                                  <td className="px-3 py-2 text-sm font-mono text-nms-text-dim">
                                    {session.snssai}
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    <span
                                      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${
                                        session.state === 'PS-ACTIVE'
                                          ? 'bg-nms-green/10 text-nms-green'
                                          : 'bg-nms-red/10 text-nms-red'
                                      }`}
                                    >
                                      <Circle
                                        className={`w-1.5 h-1.5 ${
                                          session.state === 'PS-ACTIVE'
                                            ? 'fill-nms-green'
                                            : 'fill-nms-red'
                                        }`}
                                      />
                                      {session.state}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-12 text-nms-text-dim">
            <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="text-sm">No active UE sessions</p>
            <p className="text-xs mt-1">UE sessions will appear here when devices connect</p>
          </div>
        )}
      </div>
    </div>
  );
};
