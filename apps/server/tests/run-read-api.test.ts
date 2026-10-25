import { linkSync, mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { RunListPageSchema, RunSnapshotSchema } from '@centralign/shared';
import { createOnboardingTestModel, ONBOARDING_OBJECTIVE } from '../src/agent/testing/onboarding-model.js';
import { MAX_DOWNLOAD_BYTES } from '../src/api/artifact-content.js';
import { agentFixture } from './agent-helpers.js';

async function ready() {
  const f = agentFixture({ provider: createOnboardingTestModel() }); const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id);
  const snapshot = f.service.snapshot(id); const artifact = snapshot.artifacts[0]!; const path = join(f.workspace, artifact.path);
  return { ...f, id, snapshot, artifact, artifactPath: path, url: `/api/v1/runs/${id}/artifacts/${artifact.id}/content` };
}
it('lists only persisted executable runs in stable keyset pages and validates cursors', async () => {
  const f = agentFixture();
  try {
    const ids: string[] = []; for (let index = 0; index < 5; index++) ids.push(f.service.store.create(`Request ${index}`, 'local-user', [], f.service.budgets));
    const seen: string[] = []; let cursor: string | null = null;
    do { const reply = await f.app.inject(`/api/v1/runs?limit=2${cursor ? `&cursor=${cursor}` : ''}`); expect(reply.statusCode).toBe(200); const page = RunListPageSchema.parse(reply.json()); seen.push(...page.runs.map((run) => run.id)); cursor = page.nextCursor; } while (cursor);
    expect(new Set(seen).size).toBe(5); expect(seen.sort()).toEqual(ids.sort());
    expect((await f.app.inject('/api/v1/runs?cursor=bad')).statusCode).toBe(400); expect((await f.app.inject('/api/v1/runs?limit=51')).statusCode).toBe(400);
  } finally { await f.close(); }
});
it('returns decision history and actual customer activation separately from the completed run', async () => {
  const f = await ready();
  try { f.service.decision(f.id, f.snapshot.pendingApprovals[0]!.id, { decision: 'APPROVED' }); await f.service.waitForIdle(f.id); const reply = await f.app.inject(`/api/v1/runs/${f.id}`); const snapshot = RunSnapshotSchema.parse(reply.json()); expect(snapshot.run.status).toBe('COMPLETED'); expect(snapshot.approvalHistory[0]?.status).toBe('APPROVED'); expect(snapshot.businessStatus?.activation).toBe('BLOCKED'); expect(snapshot.businessStatus?.blockers.join(' ')).toContain('questionnaire'); const page = RunListPageSchema.parse((await f.app.inject('/api/v1/runs')).json()); expect(page.runs[0]?.verifiedCount).toBe(7); }
  finally { await f.close(); }
});
it('serves actual verified bytes with attachment, MIME, hash, CSP and nosniff headers', async () => {
  const f = await ready();
  try { const reply = await f.app.inject(f.url); expect(reply.statusCode).toBe(200); expect(reply.body).toContain('# Acme Logistics onboarding'); expect(reply.headers['content-type']).toContain('text/markdown'); expect(reply.headers['content-disposition']).toContain('attachment; filename="onboarding-brief.md"'); expect(reply.headers['etag']).toBe(`"sha256-${f.artifact.contentHash}"`); expect(reply.headers['content-security-policy']).toContain('sandbox'); expect(reply.headers['x-content-type-options']).toBe('nosniff'); expect(reply.headers['cache-control']).toBe('no-store'); }
  finally { await f.close(); }
});
it.each(['missing artifact', 'different run', 'traversal query', 'traversal metadata', 'missing file', 'changed bytes', 'oversized file', 'linked directory', 'hard link', 'stale citation'])( 'rejects unsafe artifact access: %s', async (scenario) => {
  const f = await ready(); let url = f.url;
  try {
    if (scenario === 'missing artifact') url = `/api/v1/runs/${f.id}/artifacts/absent/content`;
    if (scenario === 'different run') url = `/api/v1/runs/another-run/artifacts/${f.artifact.id}/content`;
    if (scenario === 'traversal query') url += '?path=../../outside.txt';
    if (scenario === 'traversal metadata') f.db.prepare("UPDATE artifacts SET path='../outside.txt' WHERE id=?").run(f.artifact.id);
    if (scenario === 'missing file') unlinkSync(f.artifactPath);
    if (scenario === 'changed bytes') writeFileSync(f.artifactPath, 'tampered');
    if (scenario === 'oversized file') writeFileSync(f.artifactPath, Buffer.alloc(MAX_DOWNLOAD_BYTES + 1));
    if (scenario === 'linked directory') { const directory = dirname(f.artifactPath); renameSync(directory, `${directory}-owned`); const outside = join(dirname(f.workspace), 'outside'); mkdirSync(outside); writeFileSync(join(outside, f.artifact.name), 'outside secret'); symlinkSync(outside, directory, 'junction'); }
    if (scenario === 'hard link') linkSync(f.artifactPath, join(dirname(f.workspace), 'linked-copy.md'));
    if (scenario === 'stale citation') f.db.prepare("UPDATE company_documents SET content_hash=? WHERE id='doc-onboarding-sop'").run('0'.repeat(64));
    const reply = await f.app.inject(url); expect(reply.statusCode).toBeGreaterThanOrEqual(400); expect(reply.statusCode).toBeLessThan(500); expect(reply.headers['content-disposition']).toBeUndefined(); expect(reply.body).not.toContain(f.workspace); expect(reply.body).not.toContain('outside secret');
  } finally { await f.close(); }
});
it('downloads unsupported content as inert binary and sanitizes a hostile filename', async () => {
  const f = await ready();
  try { f.db.prepare('UPDATE artifacts SET mime_type=?,name=? WHERE id=?').run('text/html', 'evil"\r\nX-Fake: value.html', f.artifact.id); const reply = await f.app.inject(f.url); expect(reply.statusCode).toBe(200); expect(reply.headers['content-type']).toBe('application/octet-stream'); expect(reply.headers['content-disposition']).not.toMatch(/[\r\n]/); expect(reply.headers['x-fake']).toBeUndefined(); }
  finally { await f.close(); }
});
