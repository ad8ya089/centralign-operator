import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { AgentFault, MAX_MODEL_OUTPUT_BYTES } from './contracts.js';
import type { ModelProvider, StructuredModelRequest } from './contracts.js';

export interface OpenAIProviderOptions { apiKey?: string; model: string; timeoutMs: number; fetch?: typeof globalThis.fetch }
export class OpenAIModelProvider implements ModelProvider {
  readonly configured: boolean;
  private readonly client: OpenAI | null;
  constructor(private readonly options: OpenAIProviderOptions) {
    this.configured = Boolean(options.apiKey);
    const transport = options.fetch ?? globalThis.fetch;
    const boundedFetch: typeof globalThis.fetch = async (url, init) => {
      const response = await transport(url, init);
      if (!response.body) return response;
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const item = await reader.read(); if (item.done) break;
          size += item.value.byteLength;
          if (size > 1048576) { await reader.cancel(); throw new AgentFault('MODEL_RESPONSE_TOO_LARGE', 'Provider response exceeded the transport limit.'); }
          chunks.push(item.value);
        }
      } finally { reader.releaseLock(); }
      return new Response(new Uint8Array(Buffer.concat(chunks)).buffer, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    this.client = options.apiKey ? new OpenAI({ apiKey: options.apiKey, timeout: options.timeoutMs, maxRetries: 0, fetch: boundedFetch }) : null;
  }
  async generateStructured(request: StructuredModelRequest): Promise<unknown> {
    if (!this.client) throw new AgentFault('MODEL_UNCONFIGURED', 'Set OPENAI_API_KEY before submitting a live run.', 'CONFIGURATION');
    try {
      const response = await this.client.responses.create({
        model: this.options.model, store: false, max_output_tokens: 8192,
        input: [{ role: 'system', content: request.system }, { role: 'user', content: JSON.stringify(request.context) }],
        text: { format: zodTextFormat(request.schema, `centralign_${request.phase}`) },
      }, { signal: request.signal, timeout: this.options.timeoutMs });
      if (response.status !== 'completed' || !response.output_text) throw new AgentFault('MODEL_INCOMPLETE', 'Provider refused or did not complete a structured response.');
      if (Buffer.byteLength(response.output_text, 'utf8') > MAX_MODEL_OUTPUT_BYTES) throw new AgentFault('MODEL_RESPONSE_TOO_LARGE', 'Structured model response exceeded its size limit.');
      try { return JSON.parse(response.output_text) as unknown; }
      catch { throw new AgentFault('MODEL_INVALID_JSON', 'Provider did not return valid JSON.', 'VALIDATION'); }
    } catch (error) {
      if (request.signal.aborted) throw new AgentFault('MODEL_CANCELLED', 'Model request was cancelled.', 'CANCELLED');
      if (error instanceof AgentFault) throw error;
      if (error instanceof OpenAI.APIConnectionTimeoutError) throw new AgentFault('MODEL_TIMEOUT', 'Model request timed out.', 'TRANSIENT');
      if (error instanceof OpenAI.APIError && (error.status === 429 || (error.status ?? 0) >= 500)) throw new AgentFault('MODEL_TEMPORARY_FAILURE', 'Model provider is temporarily unavailable.', 'TRANSIENT');
      if (error instanceof OpenAI.APIConnectionError) throw new AgentFault('MODEL_CONNECTION_FAILED', 'Model provider connection failed.', 'TRANSIENT');
      throw new AgentFault('MODEL_REQUEST_FAILED', 'Model provider request failed; check configuration and account access.');
    }
  }
}
