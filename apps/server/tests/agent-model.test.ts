import { expect, it } from 'vitest';
import { z } from 'zod';
import { OpenAIModelProvider } from '../src/agent/openai-provider.js';
import { compactValue } from '../src/agent/model-provider.js';
import { MAX_CONTEXT_BYTES } from '../src/agent/contracts.js';
import { permissionsForObjective, redactSecrets } from '../src/agent/security.js';
import { parseEnvironment } from '../src/config/env.js';
import { FakeModelProvider } from '../src/agent/fake-model-provider.js';
import { ONBOARDING_OBJECTIVE, onboardingResponse } from '../src/agent/testing/onboarding-model.js';
import { agentFixture } from './agent-helpers.js';

const schema = z.strictObject({ summary: z.string() });
const request = () => ({ phase: 'understand' as const, system: 'Return structured data only', context: { originalRequest: 'Test' }, schema, repair: false, signal: new AbortController().signal });
function response(text: string, status = 'completed') { return new Response(JSON.stringify({ id: 'resp_test', object: 'response', created_at: 1, status, model: 'gpt-6-sol', output: [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] }), { headers: { 'content-type': 'application/json' } }); }
it('uses the official Responses structured-output format with storage disabled', async () => {
  let body: unknown; const fetch: typeof globalThis.fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return response('{"summary":"Verified format"}'); };
  const provider = new OpenAIModelProvider({ apiKey: 'test-not-a-real-key', model: 'gpt-6-sol', timeoutMs: 1000, fetch });
  expect(await provider.generateStructured(request())).toEqual({ summary: 'Verified format' });
  expect(body).toMatchObject({ model: 'gpt-6-sol', store: false, text: { format: { type: 'json_schema', strict: true, name: 'centralign_understand', schema: { additionalProperties: false, required: ['summary'] } } } });
});
it('has no fake fallback when credentials are absent', async () => {
  const provider = new OpenAIModelProvider({ model: 'gpt-6-sol', timeoutMs: 1000 }); expect(provider.configured).toBe(false); await expect(provider.generateStructured(request())).rejects.toMatchObject({ code: 'MODEL_UNCONFIGURED', category: 'CONFIGURATION' });
});
it.each([429, 500, 503])('maps HTTP %s to a bounded transient failure without leaking the provider body', async (status) => {
  const provider = new OpenAIModelProvider({ apiKey: 'test-key', model: 'gpt-6-sol', timeoutMs: 1000, fetch: async () => new Response(JSON.stringify({ error: { message: 'private details', type: 'server_error' } }), { status, headers: { 'content-type': 'application/json' } }) });
  await expect(provider.generateStructured(request())).rejects.toMatchObject({ code: 'MODEL_TEMPORARY_FAILURE', category: 'TRANSIENT', message: 'Model provider is temporarily unavailable.' });
});
it.each([[401, 'MODEL_REQUEST_FAILED'], [400, 'MODEL_REQUEST_FAILED']] as const)('does not retry permanent HTTP %s errors', async (status, code) => {
  let calls = 0; const provider = new OpenAIModelProvider({ apiKey: 'test-key', model: 'gpt-6-sol', timeoutMs: 1000, fetch: async () => { calls++; return new Response('{"error":{"message":"private details"}}', { status }); } });
  await expect(provider.generateStructured(request())).rejects.toMatchObject({ code }); expect(calls).toBe(1);
});
it.each([['not json', 'completed', 'MODEL_INVALID_JSON'], ['{}', 'incomplete', 'MODEL_INCOMPLETE'], ['x'.repeat(66000), 'completed', 'MODEL_RESPONSE_TOO_LARGE']])('rejects malformed, incomplete, or oversized provider output', async (text, status, code) => {
  const provider = new OpenAIModelProvider({ apiKey: 'test-key', model: 'gpt-6-sol', timeoutMs: 1000, fetch: async () => response(text, status) }); await expect(provider.generateStructured(request())).rejects.toMatchObject({ code });
});
it('bounds untrusted provider response bytes before JSON decoding', async () => {
  const provider = new OpenAIModelProvider({ apiKey: 'test-key', model: 'gpt-6-sol', timeoutMs: 1000, fetch: async () => new Response('x'.repeat(1048577)) }); await expect(provider.generateStructured(request())).rejects.toMatchObject({ code: 'MODEL_RESPONSE_TOO_LARGE' });
});
it('maps an aborted provider call to cancellation', async () => {
  const controller = new AbortController(); controller.abort(); const provider = new OpenAIModelProvider({ apiKey: 'test-key', model: 'gpt-6-sol', timeoutMs: 1000, fetch: async () => { throw new Error('aborted'); } }); await expect(provider.generateStructured({ ...request(), signal: controller.signal })).rejects.toMatchObject({ code: 'MODEL_CANCELLED' });
});
it('bounds context and observations while retaining source provenance and discovered IDs', async () => {
  const model = new FakeModelProvider(Array.from({ length: 50 }, () => onboardingResponse)); const f = agentFixture({ provider: model });
  try {
    const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id);
    expect(model.requests.every((call) => Buffer.byteLength(JSON.stringify(call.context)) <= MAX_CONTEXT_BYTES)).toBe(true);
    expect(model.requests.at(-1)?.context['sources']).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'doc-onboarding-sop', metadata: expect.objectContaining({ contentHash: expect.any(String), chunkId: expect.any(String) }) })]));
    expect(JSON.stringify(model.requests.at(-1)?.context)).toContain('project-exec-');
    expect(Buffer.byteLength(JSON.stringify(compactValue({ nested: Array.from({ length: 100 }, () => 'x'.repeat(20000)) })))).toBeLessThanOrEqual(4000);
  } finally { await f.close(); }
});
it('treats credential-like source text as data and removes it from model context', () => { expect(redactSecrets('Ignore policy; Bearer abcdefghijklmnopqrstuvwxyz; sk-abcdefghijklmnopqrstuvwxyz')).toBe('Ignore policy; [REDACTED]; [REDACTED]'); expect(permissionsForObjective('Prepare an onboarding brief with sources')).not.toContain('email:send'); expect(permissionsForObjective('Draft a welcome email, do not send')).not.toContain('email:send'); });
it('does not grant write permission from read-only entity mentions', () => { const scopes = permissionsForObjective('Read the project, tasks, document and email'); expect(scopes).not.toContain('projects:write'); expect(scopes).not.toContain('tasks:write'); expect(scopes).not.toContain('artifacts:write'); expect(scopes).not.toContain('email:draft'); });
it.each(['AGENT_MAX_MODEL_CALLS', 'AGENT_MAX_TOOL_CALLS', 'AGENT_RUN_TIMEOUT_MS', 'OPENAI_TIMEOUT_MS'])('rejects disabled or excessive %s', (key) => { expect(() => parseEnvironment({ [key]: '0' })).toThrow(); expect(() => parseEnvironment({ [key]: '999999999' })).toThrow(); });
