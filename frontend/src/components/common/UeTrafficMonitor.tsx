import { useEffect, useRef } from 'react';
import { Activity, RefreshCw, Square, X } from 'lucide-react';
import { useUeTrafficStream } from '../../hooks/useUeTrafficStream';

interface UeTrafficMonitorProps {
  /** The UE being watched, or null when the window is closed. */
  imsi: string | null;
  onClose: () => void;
}

/**
 * Live view of one UE's traffic test. Opens over the page that started it, and
 * closing it stops the run — the pings are only interesting while someone is
 * looking at them.
 */
export function UeTrafficMonitor({ imsi, onClose }: UeTrafficMonitorProps) {
  const { lines, connected, running, exitCode, error, stop, restart } = useUeTrafficStream(imsi);
  const scrollRef = useRef<HTMLDivElement>(null);

  //Follow the tail as replies arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines.length]);

  //Escape closes, like every other overlay
  useEffect(() => {
    if (!imsi) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [imsi, onClose]);

  if (!imsi) {
    return null;
  }

  const state = running
    ? { label: connected ? 'Running' : 'Connecting', className: 'bg-nms-accent/10 text-nms-accent' }
    : error
      ? { label: 'Failed', className: 'bg-nms-red/10 text-nms-red' }
      : exitCode === 0
        ? { label: 'Passed', className: 'bg-nms-green/10 text-nms-green' }
        : exitCode === null
          ? { label: 'Stopped', className: 'bg-nms-surface-2 text-nms-text-dim' }
          : { label: `Exit ${exitCode}`, className: 'bg-nms-red/10 text-nms-red' };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Traffic test for UE ${imsi}`}
      onClick={onClose}
    >
      <div
        className="nms-card flex w-full max-w-3xl flex-col gap-3 p-0 max-h-[85vh]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-nms-border px-4 py-3">
          <Activity className="h-4 w-4 text-nms-accent" />
          <div className="flex-1">
            <h2 className="font-display text-sm font-semibold">Traffic test</h2>
            <p className="font-mono text-xs text-nms-text-dim">{imsi}</p>
          </div>
          <span className={`rounded-full px-2 py-0.5 text-xs ${state.className}`}>{state.label}</span>
          {running ? (
            <button onClick={stop} className="nms-btn-ghost flex items-center gap-1.5 px-2 py-1 text-xs">
              <Square className="h-3.5 w-3.5" />
              Stop
            </button>
          ) : (
            <button onClick={restart} className="nms-btn-ghost flex items-center gap-1.5 px-2 py-1 text-xs">
              <RefreshCw className="h-3.5 w-3.5" />
              Run again
            </button>
          )}
          <button
            onClick={onClose}
            className="nms-btn-ghost px-2 py-1 text-xs"
            aria-label="Close traffic test"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div
          ref={scrollRef}
          className="mx-4 mb-1 min-h-[14rem] flex-1 overflow-auto rounded-md bg-nms-bg p-3 font-mono text-xs leading-relaxed"
        >
          {error && <div className="text-nms-red">{error}</div>}
          {lines.length === 0 && !error && (
            <div className="text-nms-text-dim">
              {running ? 'Waiting for the first packets...' : 'No output.'}
            </div>
          )}
          {lines.map((entry, index) => (
            <div
              key={`${entry.timestamp}-${index}`}
              className={`whitespace-pre-wrap ${
                entry.stream === 'stderr' ? 'text-nms-red' : 'text-nms-text'
              }`}
            >
              {entry.line}
            </div>
          ))}
        </div>

        <p className="px-4 pb-3 text-xs text-nms-text-dim">
          Runs <span className="font-mono">NMS/traffic_ue.sh</span> for this UE and follows its
          output. Closing this window stops the run.
        </p>
      </div>
    </div>
  );
}
