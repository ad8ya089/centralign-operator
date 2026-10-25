import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/runs-api.js';
export function useMutation(refresh: () => Promise<void>, reportError?: (message: string) => void) {
  const [pending, setPending] = useState(false); const [error, setError] = useState(''); const busy = useRef(false); const mounted = useRef(true); const controller = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  async function submit(action: (signal: AbortSignal) => Promise<unknown>) {
    if (busy.current) return; busy.current = true; setPending(true); setError(''); const next = new AbortController(); controller.current = next;
    try { await action(next.signal); if (!next.signal.aborted) await refresh(); }
    catch (failure) { if (!next.signal.aborted) { const message = failure instanceof ApiError ? failure.message : 'The decision could not be recorded. Please retry.'; reportError?.(message); if (mounted.current) setError(message); if (failure instanceof ApiError && failure.status === 409) await refresh(); } }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  return { pending, error, submit };
}
