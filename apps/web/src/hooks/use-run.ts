import { useEffect, useRef, useState } from 'react';
import { RunMonitor } from '../lib/run-monitor.js';
import type { MonitorState } from '../lib/run-monitor.js';
export function useRun(id: string) {
  const [state, setState] = useState<MonitorState>({ snapshot: null, events: [], cursor: 0, loading: true, error: null, retryMs: 0, historyLimited: false });
  const monitor = useRef<RunMonitor | null>(null);
  useEffect(() => { const next = new RunMonitor(id, setState); monitor.current = next; setState(next.state); next.start(); return () => next.stop(); }, [id]);
  return { ...state, refresh: () => monitor.current?.refresh() ?? Promise.resolve() };
}
