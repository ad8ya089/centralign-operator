import { useEffect, useState } from 'react';
import type { HealthResponse } from '@centralign/shared';
import { fetchHealth } from '../lib/api.js';

type HealthState = { kind: 'loading' } | { kind: 'ready'; response: HealthResponse } | { kind: 'error'; message: string };

export function ServiceHealth() {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });
  const [requestNumber, setRequestNumber] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void fetchHealth(controller.signal).then((response) => {
      if (!controller.signal.aborted) setState({ kind: 'ready', response });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ kind: 'error', message: error instanceof Error && error.name === 'TimeoutError' ? 'The health request timed out. Check the service and retry.' : 'Unable to reach a valid health response. Check the backend and retry.' });
    });
    return () => { controller.abort(); };
  }, [requestNumber]);

  const healthy = state.kind === 'ready' && state.response.status === 'healthy';
  const label = state.kind === 'loading' ? 'Checking services' : state.kind === 'error' ? 'Request error' : healthy ? 'All services healthy' : 'Service degraded';

  return (
    <section className="health-card" aria-labelledby="health-title">
      <div className="section-heading">
        <div><p className="eyebrow">LIVE CONNECTION</p><h2 id="health-title">System health</h2></div>
        <button type="button" onClick={() => setRequestNumber((value) => value + 1)} disabled={state.kind === 'loading'}>↻ <span>{state.kind === 'loading' ? 'Checking…' : 'Retry check'}</span></button>
      </div>
      <div className={`health-summary ${state.kind === 'loading' ? 'loading' : healthy ? 'healthy' : 'attention'}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <div><strong>{label}</strong><p>{state.kind === 'loading' ? 'Contacting the API and checking SQLite.' : state.kind === 'error' ? state.message : healthy ? 'The API is responding and SQLite is connected.' : 'The API is responding, but its database check failed.'}</p></div>
      </div>
      <dl className="service-list">
        <div><dt>Backend API</dt><dd>{state.kind === 'ready' ? 'Connected' : state.kind === 'loading' ? 'Checking…' : 'Unconfirmed'}</dd></div>
        <div><dt>SQLite database</dt><dd>{state.kind === 'ready' ? state.response.database === 'connected' ? 'Connected' : 'Unavailable' : state.kind === 'loading' ? 'Checking…' : 'Unconfirmed'}</dd></div>
        <div><dt>Last checked</dt><dd>{state.kind === 'ready' ? <time dateTime={state.response.timestamp}>{new Date(state.response.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time> : '—'}</dd></div>
      </dl>
      <p className="card-footnote">Checks run on page load and when you retry. No background polling.</p>
    </section>
  );
}
