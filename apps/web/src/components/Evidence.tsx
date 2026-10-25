import { useEffect, useRef, useState } from 'react';
import { DocumentCitationSchema } from '@centralign/shared';
import type { RunSnapshot } from '@centralign/shared';
import { ApiError, fetchArtifact } from '../lib/runs-api.js';
import { dateLabel, Icon, Notice, safeText, Status } from './ui.js';

function ArtifactCard({ artifact, snapshot }: { artifact: RunSnapshot['artifacts'][number]; snapshot: RunSnapshot }) {
  const [loading, setLoading] = useState(false); const [preview, setPreview] = useState<string | null>(null); const [error, setError] = useState(''); const [fresh, setFresh] = useState(false);
  const controller = useRef<AbortController | null>(null); const busy = useRef(false);
  useEffect(() => { setPreview(null); setFresh(false); setError(''); return () => controller.current?.abort(); }, [artifact.contentHash]);
  const supported = ['text/plain', 'text/markdown', 'application/json'].includes(artifact.mimeType);
  const check = snapshot.verification.find((item) => item.targetId === artifact.stepId);
  const sources = Array.isArray(artifact.metadata['sources']) ? artifact.metadata['sources'].flatMap((value) => { const result = DocumentCitationSchema.safeParse(value); return result.success ? [result.data] : []; }) : [];
  async function read(download: boolean) {
    if (busy.current) return; busy.current = true; setLoading(true); setError(''); const next = new AbortController(); controller.current = next;
    try {
      const result = await fetchArtifact(snapshot.run.id, artifact, next.signal); if (next.signal.aborted) return;
      if (download) {
        const blob = new Blob([new Uint8Array(result.content).buffer], { type: result.mimeType }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = artifact.name.replace(/[^a-zA-Z0-9._ -]/g, '-').slice(0, 100) || 'artifact'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        if (!supported || !['text/plain', 'text/markdown', 'application/json'].includes(result.mimeType)) throw new ApiError('This file is available for download only. A text preview is not supported.');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(result.content); setPreview(text.slice(0, 32000) + (text.length > 32000 ? '\n\n[Preview truncated. Download the verified file for its complete content.]' : ''));
      }
      setFresh(true);
    } catch (failure) { if (!next.signal.aborted) { setFresh(false); setPreview(null); setError(failure instanceof ApiError ? failure.message : 'The artifact could not be safely read. No verified preview is available.'); } }
    finally { busy.current = false; if (!next.signal.aborted) setLoading(false); }
  }
  return <article className="artifact-card"><div className="section-row"><div className="artifact-name"><span className="section-icon"><Icon name="file" /></span><div><h3>{artifact.name}</h3><p className="small-meta">{artifact.mimeType} · {typeof artifact.metadata['sizeBytes'] === 'number' ? `${artifact.metadata['sizeBytes'].toLocaleString()} bytes` : 'Size not recorded'}</p></div></div><Status status={error ? 'FAILED' : fresh ? 'VERIFIED' : 'PENDING'} /></div>
    <p className="small-meta">{error ? 'Current content verification failed.' : fresh ? 'Actual bytes and recorded hash matched on this access.' : check?.passed ? `A verification passed ${dateLabel(check.createdAt)}. Access the file to check its current bytes.` : 'Artifact metadata exists; current content is not yet verified in this view.'}</p>
    <div className="artifact-actions"><button className="button" disabled={loading} onClick={() => { void read(true); }}><Icon name="download" size={15} />{loading ? 'Checking file…' : 'Download artifact'}</button>{supported && <button className="button quiet" disabled={loading} onClick={() => { void read(false); }}>Preview as text</button>}{preview !== null && <button className="text-button" onClick={() => setPreview(null)}>Close preview</button>}</div>
    {error && <Notice>{error}</Notice>}{preview !== null && <div className="artifact-preview"><span className="mini-label">UNTRUSTED CONTENT · TEXT ONLY</span><pre data-testid="artifact-preview">{preview}</pre></div>}
    <details className="metadata-details"><summary>Evidence and source metadata</summary><dl className="metadata-list"><div><dt>Artifact ID</dt><dd>{artifact.id}</dd></div><div><dt>Associated step</dt><dd>{artifact.stepId ?? 'Not recorded'}</dd></div><div><dt>Created</dt><dd>{dateLabel(artifact.createdAt)}</dd></div><div><dt>SHA-256</dt><dd>{artifact.contentHash}</dd></div></dl>{sources.length > 0 ? <ul className="source-list">{sources.map((source, index) => <li key={`${source.documentId}-${index}`}><strong>{source.documentId}</strong><span>SHA-256 {source.contentHash}</span>{source.chunkId && <span>Chunk {source.chunkId}</span>}</li>)}</ul> : <p className="small-meta">No citation metadata recorded.</p>}</details>
  </article>;
}
export function EvidencePanel({ snapshot }: { snapshot: RunSnapshot }) {
  const references = [...new Map(snapshot.verification.flatMap((check) => check.evidence).map((item) => [`${item.kind}:${item.id}:${item.reference}`, item])).values()];
  const latest = [...new Map([...snapshot.verification].reverse().map((check) => [check.targetId, check])).values()];
  return <div className="tab-content"><section className="panel"><div className="section-row"><div><p className="eyebrow">GENERATED WORK</p><h2>Artifacts <span className="count">{snapshot.artifacts.length}</span></h2></div><Icon name="file" /></div><p className="muted">Downloads and text previews check the actual file against its persisted hash. File existence alone does not establish a verified deliverable.</p>{snapshot.artifacts.length ? snapshot.artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} snapshot={snapshot} />) : <p className="empty">No artifact metadata has been recorded for this run.</p>}</section>
    <section className="panel"><p className="eyebrow">INDEPENDENT READ-BACK</p><h2>Verification checks</h2>{latest.length ? <ul className="verification-list">{latest.map((check) => <li key={check.id}><Icon name={check.passed ? 'check' : 'alert'} /><div><strong>{snapshot.goal?.deliverables.find((item) => item.id === check.targetId)?.description ?? snapshot.steps.find((step) => step.id === check.targetId)?.description ?? check.targetId}</strong><p>{check.explanation}</p><span className="small-meta">{check.passed ? 'Passed' : 'Failed'} · {dateLabel(check.createdAt)}</span><details className="metadata-details"><summary>Expected and observed</summary><pre>{JSON.stringify({ expected: check.expected, observed: check.observed }, null, 2).slice(0, 4000)}</pre></details></div></li>)}</ul> : <p className="empty">No independent verification checks yet.</p>}</section>
    <section className="panel"><p className="eyebrow">TRACEABLE REFERENCES</p><h2>Sources and evidence</h2>{references.length ? <ul className="source-list">{references.slice(0, 200).map((reference) => <li key={`${reference.kind}:${reference.id}:${reference.reference}`}><span className="mini-label">{reference.kind}</span><strong>{reference.id}</strong><span>{safeText(reference.reference, 1000)}</span>{reference.metadata['contentHash'] && <span>SHA-256 {safeText(reference.metadata['contentHash'])}</span>}</li>)}</ul> : <p className="empty">No source or evidence references have been verified yet.</p>}{references.length > 200 && <p className="small-meta">Showing 200 of {references.length} recorded references.</p>}</section>
  </div>;
}
