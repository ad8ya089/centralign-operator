import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactInputSchema, ArtifactResultSchema } from '../src/tools/artifacts.js';
import { sha256 } from '../src/persistence/json.js';
import { success, toolFixture } from './tool-helpers.js';

describe('restricted artifacts', () => {
  let fixture: ReturnType<typeof toolFixture>;
  beforeEach(() => { fixture = toolFixture(); });
  afterEach(() => { fixture.cleanup(); });
  it('writes actual UTF-8 bytes with matching hash, source metadata, and a verification reference', async () => {
    const source = fixture.db.prepare('SELECT content_hash FROM company_documents WHERE id=?').get('doc-security-policy') as { content_hash: string };
    const input = { filename: 'brief.md', content: '# Brief\n\nQuestionnaire pending. Café.', mimeType: 'text/markdown', sources: [{ documentId: 'doc-security-policy', contentHash: source.content_hash, chunkId: null }] };
    const first = await fixture.executor.execute('write_artifact', input, fixture.context('brief-key'));
    const artifact = success(first, ArtifactResultSchema);
    const bytes = readFileSync(join(fixture.workspace, artifact.path));
    expect(sha256(bytes)).toBe(artifact.contentHash); expect(bytes.length).toBe(artifact.sizeBytes);
    expect(artifact.path).toMatch(/^artifacts\/runs\//); expect(artifact.verificationReference).toContain(artifact.contentHash);
    expect(await fixture.executor.execute('write_artifact', input, fixture.context('brief-key'))).toMatchObject({ ok: true, replayed: true, data: artifact });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM artifacts').get()).toEqual({ count: 1 });
  });
  it('rejects traversal, absolute paths, reserved names, and undeclared output destinations', async () => {
    for (const filename of ['../protected.md', '/tmp/out.md', 'C:/out.md', 'nested/file.md', 'CON.txt', 'NUL', 'bad.']) {
      expect(await fixture.executor.execute('write_artifact', { filename, content: 'Text', mimeType: 'text/plain' }, fixture.context(`bad-${filename}`))).toMatchObject({ ok: false, error: { category: 'VALIDATION' } });
    }
    expect(await fixture.executor.execute('write_artifact', { filename: 'file.md', content: 'Text', mimeType: 'text/plain', outputRoot: 'elsewhere' }, fixture.context('bad-root'))).toMatchObject({ ok: false, error: { category: 'VALIDATION' } });
    expect(existsSync(fixture.workspace)).toBe(false);
  });
  it('rejects linked ancestors and leaves protected outside files untouched', async () => {
    mkdirSync(fixture.workspace, { recursive: true });
    const outside = join(fixture.workspace, '..', 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, 'protected.txt'), 'Do not overwrite');
    symlinkSync(outside, join(fixture.workspace, 'artifacts'), 'junction');
    expect(await fixture.executor.execute('write_artifact', { filename: 'protected.txt', content: 'Changed', mimeType: 'text/plain' }, fixture.context('symlink'))).toMatchObject({ ok: false, error: { code: 'UNSAFE_ARTIFACT_PATH' } });
    expect(readFileSync(join(outside, 'protected.txt'), 'utf8')).toBe('Do not overwrite');
    expect(readdirSync(outside)).toEqual(['protected.txt']);
  });
  it('rejects stale source hashes before writing a file', async () => {
    expect(await fixture.executor.execute('write_artifact', { filename: 'brief.md', content: 'Text', mimeType: 'text/markdown', sources: [{ documentId: 'doc-security-policy', contentHash: '0'.repeat(64), chunkId: null }] }, fixture.context('stale-source'))).toMatchObject({ ok: false, error: { code: 'STALE_SOURCE' } });
    expect(existsSync(fixture.workspace)).toBe(false);
  });
  it('reconciles matching owned bytes after a file write succeeded but its database transaction failed', async () => {
    fixture.registry.register({ metadata: { name: 'artifact_fault_probe', description: 'Inject a failure after writing owned artifact bytes.', risk: 'reversible_write', requiredScopes: ['artifacts:write'], timeoutMs: 3000, retry: 'reconcile_before_retry', changesPersistentState: true, persistence: 'filesystem' }, inputSchema: ArtifactInputSchema, resultSchema: ArtifactResultSchema,
      handler: (input, context) => { context.artifacts.write(input, context); throw new Error('Injected post-file failure'); },
      reconcile: (input, context) => context.artifacts.write(input, context, true),
    });
    const input = { filename: 'recover.md', content: 'Durable source-backed bytes', mimeType: 'text/plain' };
    expect(await fixture.executor.execute('artifact_fault_probe', input, fixture.context('artifact-fault'))).toMatchObject({ ok: false, error: { category: 'UNKNOWN_OUTCOME', retryability: 'RECONCILE' } });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM artifacts').get()).toEqual({ count: 0 });
    const reconciled = await fixture.executor.execute('artifact_fault_probe', input, fixture.context('artifact-fault'));
    const artifact = success(reconciled, ArtifactResultSchema);
    expect(reconciled).toMatchObject({ replayed: true });
    expect(sha256(readFileSync(join(fixture.workspace, artifact.path)))).toBe(artifact.contentHash);
    expect(fixture.db.prepare('SELECT count(*) AS count FROM artifacts').get()).toEqual({ count: 1 });
  });
});
