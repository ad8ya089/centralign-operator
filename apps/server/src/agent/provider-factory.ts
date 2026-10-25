import type { AppConfig } from '../config/env.js';
import { AgentFault } from './contracts.js';
import type { ModelProvider } from './contracts.js';
import { GeminiModelProvider } from './gemini-provider.js';
import { OpenAIModelProvider } from './openai-provider.js';
export const modelTimeout = (config: AppConfig) => config.MODEL_TIMEOUT_MS ?? config.OPENAI_TIMEOUT_MS;
export const providerKeyName = (config: AppConfig) => config.MODEL_PROVIDER === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
export function createModelProvider(config: AppConfig): ModelProvider {
  switch (config.MODEL_PROVIDER) {
    case 'gemini': return new GeminiModelProvider({ ...(config.GEMINI_API_KEY ? { apiKey: config.GEMINI_API_KEY } : {}), model: config.GEMINI_MODEL, timeoutMs: modelTimeout(config) });
    case 'openai': return new OpenAIModelProvider({ ...(config.OPENAI_API_KEY ? { apiKey: config.OPENAI_API_KEY } : {}), model: config.OPENAI_MODEL, timeoutMs: modelTimeout(config) });
    default: throw new AgentFault('MODEL_PROVIDER_INVALID', 'Select a supported production model provider.', 'CONFIGURATION');
  }
}
