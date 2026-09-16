import { useCallback, useEffect, useRef, useState } from 'react';

export interface TrafficLine {
  stream: 'stdout' | 'stderr' | 'client';
  line: string;
  timestamp: string;
}

export interface UeTrafficStream {
  lines: TrafficLine[];
  connected: boolean;
  running: boolean;
  /** Set once the run ends; null while it is still going or was stopped by hand. */
  exitCode: number | null;
  error: string | null;
  stop: () => void;
  restart: () => void;
}

//A traffic run is three pings of five packets, so the transcript is short. The cap
//is here for the case where a script is changed to something chattier.
const MAX_LINES = 2000;

/**
 * Follows one UE's traffic test over the same WebSocket the log views use.
 *
 * Pass an IMSI to start; pass null to tear the socket down. Closing the socket is
 * what stops the pings on the host, so an operator who closes the window does not
 * leave a run going.
 */
export function useUeTrafficStream(imsi: string | null): UeTrafficStream {
  const [lines, setLines] = useState<TrafficLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  const append = useCallback((entry: TrafficLine) => {
    setLines((prev) => [...prev, entry].slice(-MAX_LINES));
  }, []);

  useEffect(() => {
    if (!imsi) {
      return;
    }

    setLines([]);
    setRunning(true);
    setExitCode(null);
    setError(null);

    const wsUrl =
      import.meta.env.VITE_WS_URL ||
      `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: 'ue_traffic_start', imsi }));
    };

    ws.onmessage = (event) => {
      let data: {
        type?: string;
        imsi?: string;
        stream?: 'stdout' | 'stderr';
        line?: string;
        timestamp?: string;
        exitCode?: number | null;
        error?: string;
      };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      //The socket carries the log views' frames too, so ignore anything else
      if (data.imsi !== imsi) {
        return;
      }

      if (data.type === 'ue_traffic_line') {
        append({
          stream: data.stream ?? 'stdout',
          line: data.line ?? '',
          timestamp: data.timestamp ?? new Date().toISOString(),
        });
      } else if (data.type === 'ue_traffic_end') {
        setRunning(false);
        setExitCode(data.exitCode ?? null);
      } else if (data.type === 'ue_traffic_error') {
        setRunning(false);
        setError(data.error ?? 'Failed to start the traffic test');
      }
    };

    ws.onerror = () => {
      setError('Lost the connection to the traffic stream');
      setRunning(false);
    };

    ws.onclose = () => {
      setConnected(false);
      setRunning(false);
    };

    return () => {
      //Closing the socket stops the run on the host
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ue_traffic_stop' }));
      }
      ws.close();
      wsRef.current = null;
    };
  }, [imsi, attempt, append]);

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ue_traffic_stop' }));
    }
    setRunning(false);
  }, []);

  const restart = useCallback(() => setAttempt((value) => value + 1), []);

  return { lines, connected, running, exitCode, error, stop, restart };
}
