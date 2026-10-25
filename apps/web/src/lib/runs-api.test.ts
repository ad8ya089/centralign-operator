import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { RunSnapshotSchema } from '@centralign/shared';
import { ApiError, fetchArtifact, runsApi } from './runs-api.js';

const at = '2026-10-26T00:00:00.000Z';
export const snapshotFixture = RunSnapshotSchema.parse({ run: { id: 'run-1', objective: 'Read company context', status: 'RUNNING', createdAt: at, updatedAt: at, completedAt: null, metadata: {}, version: 1 }, goal: null, plan: null, planRevision: 0, steps: [], currentStepId: null, pendingQuestions: [], pendingApprovals: [], verification: [], finalResult: null, artifacts: [], budgets: { modelCalls: 1, toolCalls: 0, recoveries: 0, replans: 0, deadlineAt: '2026-10-26T00:30:00.000Z' }, resolvedCustomerId: null, cancelRequested: false, actions: [], milestones: [] });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const error = (code: string) => ({ error: { code, message: 'private server details', requestId: 'request-1', details: null }, timestamp: at });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('creates a run using only the validated objective and accepts the actual 202 contract', async () => {
  const fetch = vi.fn().mockResolvedValue(response({ id: 'new-run', status: 'CREATED' }, 202)); vi.stubGlobal('fetch', fetch);
  expect(await runsApi.create('A real request')).toEqual({ id: 'new-run', status: 'CREATED' }); expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/runs'); expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ objective: 'A real request' });
});
it('validates the complete snapshot and refuses malformed successful responses', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(snapshotFixture)).mockResolvedValueOnce(response({ run: { status: 'COMPLETED' } })).mockResolvedValueOnce(new Response('not-json')));
  expect((await runsApi.get('run-1')).run.id).toBe('run-1'); await expect(runsApi.get('run-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); await expect(runsApi.get('run-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('shows configuration errors without fake success or provider details', async () => { const fetch = vi.fn().mockImplementation(() => Promise.resolve(response(error('CONFIGURATION_ERROR'), 503))); vi.stubGlobal('fetch', fetch); await expect(runsApi.create('Read context')).rejects.toMatchObject({ status: 503, code: 'CONFIGURATION_ERROR', retryable: false }); expect(fetch).toHaveBeenCalledTimes(1); try { await runsApi.create('Read context'); } catch (failure) { expect((failure as Error).message).toContain('OPENAI_API_KEY'); expect((failure as Error).message).not.toContain('private server'); } });
it.each([[404, 'NOT_FOUND'], [409, 'CONFLICT'], [500, 'INTERNAL_ERROR'], [503, 'DEPENDENCY_UNAVAILABLE']] as const)('maps HTTP %s to a safe structured error', async (status, code) => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(error(code), status))); await expect(runsApi.get('run-1')).rejects.toMatchObject({ status, code, retryable: status >= 500 }); });
it('classifies network loss and explicit cancellation separately', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('secret transport'))); await expect(runsApi.get('run-1')).rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true }); const controller = new AbortController(); controller.abort(); await expect(runsApi.get('run-1', controller.signal)).rejects.toMatchObject({ code: 'ABORTED', retryable: false });
});
it('bounds a stalled request using its abort signal', async () => {
  vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true }); })));
  // AbortSignal.timeout uses a native unref'ed timer; exercise the real bound.
  await expect(runsApi.get('run-1')).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
}, 10000);
it('uses exact decision/input/cancel routes without action authority fields', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ accepted: true, repeated: false }, 202)).mockResolvedValueOnce(response({ accepted: true, repeated: true })).mockResolvedValueOnce(response({ accepted: true }, 202)).mockResolvedValueOnce(response({ accepted: true }, 202)); vi.stubGlobal('fetch', fetch);
  await runsApi.decide('run-1', 'approval-1', 'APPROVED', 'Reviewed'); await runsApi.decide('run-1', 'approval-1', 'REJECTED', ''); await runsApi.answer('run-1', 'question-1', 'Use selected record', 'customer-1'); await runsApi.cancel('run-1');
  expect(fetch.mock.calls.map((call) => call[0])).toEqual(['/api/v1/runs/run-1/approvals/approval-1/decision', '/api/v1/runs/run-1/approvals/approval-1/decision', '/api/v1/runs/run-1/input', '/api/v1/runs/run-1/cancel']);
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ decision: 'APPROVED', note: 'Reviewed' }); expect(JSON.parse(fetch.mock.calls[2]?.[1].body)).toEqual({ questionId: 'question-1', answer: 'Use selected record', choiceId: 'customer-1' });
});
it('rejects invalid question acknowledgements and empty answers', async () => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ accepted: false }))); await expect(runsApi.answer('run-1', 'q1', 'Some answer', null)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); expect(() => runsApi.answer('run-1', 'q1', '   ', null)).toThrow(); });
it('encodes IDs and pagination cursors and accepts future event names for readable fallback', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ runs: [], nextCursor: null })).mockResolvedValueOnce(response({ events: [{ id: 'e1', runId: 'run-1', stepId: null, type: 'FUTURE_EVENT', payload: {}, createdAt: at }], cursor: 5, nextCursor: null })); vi.stubGlobal('fetch', fetch); await runsApi.list('abc+/='); const page = await runsApi.events('run-1', 4); expect(fetch.mock.calls[0]?.[0]).toContain('cursor=abc%2B%2F%3D'); expect(page.events[0]?.type).toBe('FUTURE_EVENT'); expect(() => runsApi.get('')).toThrow(ApiError);
});
it('checks artifact bytes, digest and attachment identity before preview/download', async () => {
  const text = '<script>never execute this</script>'; const hash = createHash('sha256').update(text).digest('hex'); const artifact = { id: 'a1', runId: 'run-1', stepId: null, name: 'brief.md', path: 'internal/brief.md', mimeType: 'text/markdown', contentHash: hash, metadata: {}, createdAt: at };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(text, { headers: { etag: `"sha256-${hash}"`, 'content-disposition': 'attachment; filename="brief.md"', 'content-type': 'text/markdown' } })).mockResolvedValueOnce(new Response('tampered', { headers: { etag: `"sha256-${hash}"`, 'content-disposition': 'attachment;' } })).mockResolvedValueOnce(response(error('CONFLICT'), 409)));
  expect(new TextDecoder().decode((await fetchArtifact('run-1', artifact)).content)).toBe(text); await expect(fetchArtifact('run-1', artifact)).rejects.toMatchObject({ code: 'CONFLICT' }); await expect(fetchArtifact('run-1', artifact)).rejects.toMatchObject({ status: 409 });
});
