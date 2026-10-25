import {
  AcceptedResponseSchema, ApprovalDecisionRequestSchema, CreateRunRequestSchema, CreateRunResponseSchema,
  DecisionResponseSchema, ErrorResponseSchema, RunEventsPageSchema, RunListPageSchema, RunSnapshotSchema, SubmitInputSchema,
} from '@centralign/shared';
import type { RunSnapshot } from '@centralign/shared';

export class ApiError extends Error {
  constructor(message: string, readonly status = 0, readonly code = 'NETWORK_ERROR', readonly retryable = false) { super(message); this.name = 'ApiError'; }
}
type Schema<T> = { parse(value: unknown): T };
const invalid = () => new ApiError('The service returned an invalid response. Refresh the page or retry.', 0, 'INVALID_RESPONSE');
const base = '/api/v1';
const pathId = (id: string) => { if (!id || id.length > 200) throw new ApiError('A valid run or record ID is required.', 400, 'VALIDATION_ERROR'); return encodeURIComponent(id); };
async function bytes(response: Response, max: number): Promise<Uint8Array> {
  const reader = response.body?.getReader(); if (!reader) throw invalid(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > max) { await reader.cancel(); throw invalid(); } chunks.push(item.value); } }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0; for (const item of chunks) { result.set(item, offset); offset += item.byteLength; } return result;
}
async function checkedFetch(path: string, init: RequestInit, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(8000); const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    const response = await fetch(`${base}${path}`, { ...init, signal: combined, cache: 'no-store', headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (!response.ok) {
      let body: unknown; try { body = JSON.parse(new TextDecoder().decode(await bytes(response, 16000))) as unknown; } catch { throw new ApiError(`The request failed (HTTP ${response.status}). Please refresh and retry.`, response.status, 'HTTP_ERROR', response.status >= 500); }
      const parsed = ErrorResponseSchema.safeParse(body);
      if (!parsed.success) throw invalid();
      const safeMessages: Record<string, string> = {
        CONFIGURATION_ERROR: 'Live execution is unavailable until the selected provider is configured on the backend: GEMINI_API_KEY for Gemini, or OPENAI_API_KEY for OpenAI. Your request was not started.',
        NOT_FOUND: 'This run or artifact could not be found. It may belong to a different local workspace.',
        INTERNAL_ERROR: 'The service could not complete the request. Please retry.',
        CONFLICT: path.includes('/artifacts/') ? 'Artifact bytes or source metadata failed verification. The file was not returned.' : 'The persisted state changed or the decision expired. Review the refreshed state before retrying.',
        VALIDATION_ERROR: 'The request was not accepted. Check the required fields and current record, then retry.',
      };
      throw new ApiError(safeMessages[parsed.data.error.code] ?? 'The service is temporarily unavailable. Please retry.', response.status, parsed.data.error.code, response.status >= 500 && parsed.data.error.code !== 'CONFIGURATION_ERROR');
    }
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) throw new ApiError('Request cancelled.', 0, 'ABORTED');
    if (timeout.aborted) throw new ApiError('The service did not respond in time. Retrying is available.', 0, 'TIMEOUT', true);
    throw new ApiError('Connection interrupted. Check the backend connection and retry.', 0, 'NETWORK_ERROR', true);
  }
}
async function json<T>(path: string, schema: Schema<T>, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await checkedFetch(path, { method: body === undefined ? 'GET' : 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, signal);
  let content: Uint8Array;
  try { content = await bytes(response, 2097152); }
  catch (failure) {
    if (failure instanceof ApiError) throw failure;
    if (signal?.aborted) throw new ApiError('Request cancelled.', 0, 'ABORTED');
    if (failure instanceof Error && ['TimeoutError', 'AbortError'].includes(failure.name)) throw new ApiError('The service did not respond in time. Retrying is available.', 0, 'TIMEOUT', true);
    throw new ApiError('Connection interrupted while reading the response. Please retry.', 0, 'NETWORK_ERROR', true);
  }
  try { return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)) as unknown); }
  catch { throw invalid(); }
}
export const runsApi = {
  create: (objective: string, signal?: AbortSignal) => json('/runs', CreateRunResponseSchema, CreateRunRequestSchema.parse({ objective }), signal),
  list: (cursor: string | null = null, signal?: AbortSignal) => json(`/runs?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, RunListPageSchema, undefined, signal),
  get: (id: string, signal?: AbortSignal) => json(`/runs/${pathId(id)}`, RunSnapshotSchema, undefined, signal),
  events: (id: string, after: number, signal?: AbortSignal) => json(`/runs/${pathId(id)}/events?after=${after}&limit=50`, RunEventsPageSchema, undefined, signal),
  decide: (id: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', note: string, signal?: AbortSignal) => json(`/runs/${pathId(id)}/approvals/${pathId(approvalId)}/decision`, DecisionResponseSchema, ApprovalDecisionRequestSchema.parse({ decision, note: note || null }), signal),
  answer: (id: string, questionId: string, answer: string, choiceId: string | null, signal?: AbortSignal) => json(`/runs/${pathId(id)}/input`, AcceptedResponseSchema, SubmitInputSchema.parse({ questionId, answer, choiceId }), signal),
  cancel: (id: string, signal?: AbortSignal) => json(`/runs/${pathId(id)}/cancel`, AcceptedResponseSchema, {}, signal),
};
export type RunsApi = typeof runsApi;
export function artifactUrl(runId: string, artifactId: string) { return `${base}/runs/${pathId(runId)}/artifacts/${pathId(artifactId)}/content`; }
export async function fetchArtifact(runId: string, artifact: RunSnapshot['artifacts'][number], signal?: AbortSignal) {
  const response = await checkedFetch(`/runs/${pathId(runId)}/artifacts/${pathId(artifact.id)}/content`, { method: 'GET' }, signal);
  const content = await bytes(response, 524288); const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(content).buffer)), (part) => part.toString(16).padStart(2, '0')).join('');
  if (hash !== artifact.contentHash || response.headers.get('etag') !== `"sha256-${hash}"` || !response.headers.get('content-disposition')?.startsWith('attachment;')) throw new ApiError('Artifact content verification failed. This file cannot be presented as verified.', 409, 'CONFLICT');
  return { content, mimeType: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' };
}
