import { ApiError, GoogleGenAI } from '@google/genai';
import type { Fetch } from '@google/genai';
import { z } from 'zod';
import { AgentFault, MAX_MODEL_OUTPUT_BYTES } from './contracts.js';
import type { ModelProvider, StructuredModelRequest } from './contracts.js';
import { rejectSecrets } from './security.js';

export interface GeminiProviderOptions { apiKey?: string; model: string; timeoutMs: number; fetch?: Fetch }
/** Translate only schema syntax. Zod and the runtime retain all application checks. */
export function geminiJsonSchema(schema: z.ZodType): unknown {
  const ignored = new Set(['$schema', '$id', 'pattern', 'minLength', 'maxLength', 'minProperties', 'maxProperties']);
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (ignored.has(key)) continue;
      if (key === 'properties' || key === '$defs' || key === 'definitions') result[key] = Object.fromEntries(Object.entries(z.record(z.string(), z.unknown()).parse(item)).map(([name, child]) => [name, visit(child)]));
      else if (key === 'const') result['enum'] = [item];
      else result[key === 'oneOf' ? 'anyOf' : key] = visit(item);
    }
    return result;
  }
  return visit(z.toJSONSchema(schema, { target: 'draft-7', cycles: 'throw', reused: 'inline' }));
}
function retryDelay(body: unknown, header?: string | null): number | null {
  if (header) { const seconds = Number(header); if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000); const date = Date.parse(header); if (Number.isFinite(date)) return Math.max(0, date - Date.now()); }
  const parsed = z.object({ error: z.object({ details: z.array(z.record(z.string(), z.unknown())).optional() }) }).safeParse(body);
  for (const detail of parsed.success ? parsed.data.error.details ?? [] : []) {
    if (String(detail['@type']).endsWith('RetryInfo') && typeof detail['retryDelay'] === 'string') { const match = /^(\d+(?:\.\d+)?)s$/.exec(detail['retryDelay']); if (match) return Math.ceil(Number(match[1]) * 1000); }
  }
  return null;
}
export function geminiHttpFault(status: number, body: unknown, retryAfter?: string | null): AgentFault {
  const detail = JSON.stringify(body)?.toLowerCase() ?? '';
  if ([401, 403].includes(status) || /api_key_invalid|api key not valid/.test(detail)) return new AgentFault('MODEL_AUTH_FAILED', 'Gemini authentication or project access failed. Check the configured key and permissions.', 'CONFIGURATION');
  if (status === 404) return new AgentFault('MODEL_NOT_FOUND', 'The configured Gemini model or endpoint is unavailable.', 'CONFIGURATION');
  if (status === 429) {
    const delay = retryDelay(body, retryAfter);
    if (/perday|per_day|daily|"quotavalue"\s*:\s*"?0\b|limit:\s*0\b/.test(detail) || delay === null) return new AgentFault('MODEL_QUOTA_EXHAUSTED', 'Gemini quota is exhausted or no safe short retry is available. Check project limits before retrying.');
    return new AgentFault('MODEL_RATE_LIMITED', 'Gemini rate limited this request. A bounded provider-directed retry may be attempted.', 'TRANSIENT', delay);
  }
  if (status === 408 || status === 504) return new AgentFault('MODEL_TIMEOUT', 'Gemini request timed out.', 'TRANSIENT', retryDelay(body, retryAfter) ?? 0);
  if (status >= 500) return new AgentFault('MODEL_TEMPORARY_FAILURE', 'Gemini is temporarily unavailable.', 'TRANSIENT', retryDelay(body, retryAfter) ?? 0);
  return new AgentFault('MODEL_REQUEST_INVALID', 'Gemini rejected the request or structured-output schema. Check the provider configuration.');
}
export class GeminiModelProvider implements ModelProvider {
  readonly name = 'gemini' as const;
  readonly configured: boolean;
  get model() { return this.options.model; }
  private readonly client: GoogleGenAI | null;
  constructor(private readonly options: GeminiProviderOptions) {
    this.configured = Boolean(options.apiKey); const transport = options.fetch ?? globalThis.fetch;
    const fetch: Fetch = async (url, init) => {
      const response = await transport(url, init); const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1048576) { await reader.cancel(); throw new AgentFault('MODEL_RESPONSE_TOO_LARGE', 'Gemini transport response exceeded its byte limit.'); } chunks.push(part.value); } } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks);
      if (!response.ok) { let body: unknown = null; try { body = JSON.parse(bytes.toString('utf8')) as unknown; } catch { /* Status still has a safe classification. */ } throw geminiHttpFault(response.status, body, response.headers.get('retry-after')); }
      return new Response(new Uint8Array(bytes).buffer, { status: response.status, headers: response.headers });
    };
    this.client = options.apiKey ? new GoogleGenAI({ apiKey: options.apiKey, vertexai: false, apiVersion: 'v1beta', httpOptions: { fetch, timeout: options.timeoutMs, retryOptions: { attempts: 1 } } }) : null;
  }
  async generateStructured(request: StructuredModelRequest): Promise<unknown> {
    if (!this.client) throw new AgentFault('MODEL_UNCONFIGURED', 'Configure GEMINI_API_KEY before submitting a live Gemini request.', 'CONFIGURATION');
    if (request.signal.aborted) throw new AgentFault('MODEL_CANCELLED', 'Gemini request cancelled.', 'CANCELLED');
    const controller = new AbortController(); const abort = () => controller.abort(); request.signal.addEventListener('abort', abort, { once: true });
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new AgentFault(request.signal.aborted ? 'MODEL_CANCELLED' : 'MODEL_TIMEOUT', request.signal.aborted ? 'Gemini request cancelled.' : 'Gemini request timed out.', request.signal.aborted ? 'CANCELLED' : 'TRANSIENT')), { once: true }));
    const timer = setTimeout(abort, this.options.timeoutMs);
    try {
      const response = await Promise.race([this.client.models.generateContent({ model: this.options.model, contents: JSON.stringify(request.context), config: {
        systemInstruction: request.system, responseMimeType: 'application/json', responseJsonSchema: geminiJsonSchema(request.schema),
        candidateCount: 1, maxOutputTokens: Math.min(8192, Math.max(128, request.maxOutputTokens ?? 8192)),
        automaticContinuation: false, automaticFunctionCalling: { disable: true }, thinkingConfig: { includeThoughts: false }, store: false, abortSignal: controller.signal,
      } }), aborted]);
      const usage = response.usageMetadata;
      if (usage) request.onUsage?.({ inputTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount ?? null, totalTokens: usage.totalTokenCount ?? null, thinkingTokens: usage.thoughtsTokenCount ?? null });
      if (response.candidates?.length !== 1 || response.candidates[0]?.finishReason !== 'STOP') throw new AgentFault('MODEL_INCOMPLETE', 'Gemini refused, truncated, or did not complete a single structured response.');
      let text = '';
      for (const part of response.candidates[0].content?.parts ?? []) {
        if (part.thought) continue;
        if (typeof part.text !== 'string' || part.functionCall) throw new AgentFault('MODEL_UNEXPECTED_CONTENT', 'Gemini returned unsupported non-text content; no tool was invoked.');
        text += part.text;
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_MODEL_OUTPUT_BYTES) throw new AgentFault('MODEL_RESPONSE_TOO_LARGE', 'Gemini structured output exceeded its byte limit.');
      rejectSecrets(text, this.options.apiKey);
      let raw: unknown; try { raw = JSON.parse(text) as unknown; } catch { throw new AgentFault('MODEL_INVALID_JSON', 'Gemini did not return valid JSON.', 'VALIDATION'); }
      const parsed = request.schema.safeParse(raw); if (!parsed.success) throw new AgentFault('MODEL_SCHEMA_INVALID', 'Gemini output did not match the required application schema.', 'VALIDATION');
      return parsed.data;
    } catch (error) {
      if (error instanceof AgentFault) throw error;
      if (request.signal.aborted) throw new AgentFault('MODEL_CANCELLED', 'Gemini request cancelled.', 'CANCELLED');
      if (controller.signal.aborted) throw new AgentFault('MODEL_TIMEOUT', 'Gemini request timed out.', 'TRANSIENT');
      if (error instanceof ApiError) { let body: unknown = null; try { body = JSON.parse(error.message) as unknown; } catch { /* Never expose raw provider messages. */ } throw geminiHttpFault(error.status, body); }
      throw new AgentFault('MODEL_CONNECTION_FAILED', 'Gemini request failed without a usable response.', 'TRANSIENT');
    } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
  }
}
