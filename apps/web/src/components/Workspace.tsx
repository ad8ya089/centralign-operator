import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { CreateRunRequestSchema } from '@centralign/shared';
import type { RunListPage } from '@centralign/shared';
import { ApiError, runsApi } from '../lib/runs-api.js';
import { dateLabel, Icon, Notice, Status } from './ui.js';
import { ServiceHealth } from './ServiceHealth.js';

const example = 'Onboard Acme Logistics using our CRM and onboarding SOP. Create the onboarding project and checklist, prepare an onboarding brief with sources, draft and send the welcome email.';
export function Workspace({ navigate }: { navigate: (path: string) => void }) {
  const [objective, setObjective] = useState(''); const [pending, setPending] = useState(false); const submitting = useRef(false);
  const [error, setError] = useState(''); const [listError, setListError] = useState(''); const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<RunListPage>({ runs: [], nextCursor: null }); const controller = useRef<AbortController | null>(null);
  async function load(cursor: string | null, signal: AbortSignal) {
    setLoading(true); setListError('');
    try { const result = await runsApi.list(cursor, signal); if (!signal.aborted) setPage((old) => ({ runs: cursor ? [...new Map([...old.runs, ...result.runs].map((run) => [run.id, run])).values()] : result.runs, nextCursor: result.nextCursor })); }
    catch (failure) { if (!signal.aborted) setListError(failure instanceof ApiError ? failure.message : 'Unable to load recent runs.'); }
    finally { if (!signal.aborted) setLoading(false); }
  }
  useEffect(() => { const next = new AbortController(); controller.current = next; void load(null, next.signal); return () => next.abort(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (submitting.current) return;
    if (!CreateRunRequestSchema.safeParse({ objective }).success) { setError('Enter a request between 1 and 8,000 characters.'); return; }
    const signal = controller.current?.signal; submitting.current = true; setPending(true); setError('');
    try { const result = await runsApi.create(objective, signal); if (!signal?.aborted) navigate(`/runs/${encodeURIComponent(result.id)}`); }
    catch (failure) { if (!signal?.aborted) setError(failure instanceof ApiError ? `${failure.message}${['NETWORK_ERROR', 'TIMEOUT'].includes(failure.code) ? ' Check recent runs before submitting again; the backend may have accepted your request.' : ''}` : 'Unable to submit this request. Please retry.'); }
    finally { submitting.current = false; if (!signal?.aborted) setPending(false); }
  }
  return <>
    <header className="page-heading"><div><p className="eyebrow">YOUR OPERATIONS WORKSPACE</p><h1>From request to verified work.</h1><p className="muted">Give the goal. Follow the work. Stay in control of decisions that matter.</p></div><span className="local-pill"><span />Local workspace</span></header>
    <div className="workspace-grid">
      <section className="panel compose" aria-labelledby="new-request"><div className="panel-heading"><div className="section-icon"><Icon name="plus" /></div><div><h2 id="new-request">What needs to get done?</h2><p>Describe the outcome you want the operator to deliver.</p></div></div>
        <form onSubmit={(event) => { void submit(event); }}>
          <label className="field-label" htmlFor="objective">Your request</label><textarea id="objective" name="objective" value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Prepare onboarding materials for a customer…" maxLength={8000} rows={6} disabled={pending} aria-invalid={Boolean(error)} aria-describedby={error ? 'request-error request-help' : 'request-help'} />
          <div className="input-footer"><button className="text-button" type="button" disabled={pending} onClick={() => setObjective(example)}>Use onboarding example</button><span>{objective.length.toLocaleString()} / 8,000</span></div>
          {error && <div id="request-error"><Notice>{error}</Notice></div>}
          <div className="compose-actions"><p id="request-help"><Icon name="shield" size={15} />Consequential actions may pause for your approval.</p><button className="button primary" type="submit" disabled={pending}>{pending ? 'Starting run…' : 'Start run'}<Icon name="arrow" size={17} /></button></div>
        </form>
      </section>
      <aside className="workspace-aside"><p className="eyebrow">WORK YOU CAN INSPECT</p><h2>Clear progress.<br />Evidence at every step.</h2><ul className="promise-list"><li><Icon name="activity" /><div><strong>Follow the execution</strong><p>See the plan, actions, retries and verified results.</p></div></li><li><Icon name="shield" /><div><strong>You make the call</strong><p>Review the complete message before approving an exact action.</p></div></li><li><Icon name="file" /><div><strong>Keep the evidence</strong><p>Inspect sources and download generated artifacts.</p></div></li></ul><div className="sandbox-note"><span className="mini-label">SANDBOX EMAIL</span><p>Messages are queued locally. This prototype does not deliver real email.</p></div></aside>
    </div>
    <section className="panel recent-runs" aria-labelledby="recent-title"><div className="section-row"><div><p className="eyebrow">PERSISTED WORK</p><h2 id="recent-title">Recent runs <span className="count">{page.runs.length}</span></h2></div><button className="button quiet" disabled={loading} onClick={() => { if (controller.current) void load(null, controller.current.signal); }}>Refresh runs</button></div>
      {listError && <Notice onRetry={() => { if (controller.current) void load(null, controller.current.signal); }}>{listError}</Notice>}
      {loading && !page.runs.length ? <p className="empty" role="status">Loading persisted runs…</p> : !page.runs.length && !listError ? <div className="empty"><Icon name="activity" size={28} /><h3>Your first run starts here.</h3><p>Submit a request above. Its progress and evidence will appear in this workspace.</p></div> : <div className="run-list">{page.runs.map((run) => <a key={run.id} className="run-list-item" href={`/runs/${encodeURIComponent(run.id)}`} onClick={(event) => { if (!event.ctrlKey && !event.metaKey) { event.preventDefault(); navigate(`/runs/${encodeURIComponent(run.id)}`); } }}><span className="run-list-icon"><Icon name="activity" /></span><div className="run-list-main"><strong>{run.objective}</strong><p>{run.blocker ?? run.summary ?? 'Waiting for the operator to understand the request.'}</p><span className="small-meta">{dateLabel(run.updatedAt)}{run.requiredCount > 0 ? ` · ${run.verifiedCount}/${run.requiredCount} outcomes verified` : ''}</span></div><Status status={run.status} /><Icon name="chevron" size={16} /></a>)}</div>}
      {page.nextCursor && <div className="load-more"><button className="button" disabled={loading} onClick={() => { if (controller.current) void load(page.nextCursor, controller.current.signal); }}>{loading ? 'Loading…' : 'Load older runs'}</button></div>}
    </section>
    <details className="system-details" id="service-health"><summary>Service health and connection</summary><ServiceHealth /></details>
  </>;
}
