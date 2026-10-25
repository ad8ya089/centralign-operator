import { z } from 'zod';
import { loadConfig } from '../config/env.js';
import { createModelProvider } from '../agent/provider-factory.js';
import { AgentFault } from '../agent/contracts.js';
import type { ModelUsage } from '../agent/contracts.js';
import { sha256 } from '../persistence/json.js';

let provider: ReturnType<typeof createModelProvider> | undefined; const started = performance.now(); let usage: ModelUsage | null = null;
try {
  provider = createModelProvider(loadConfig());
  const schema = z.strictObject({ status: z.literal('ok'), echo: z.literal('centralign-synthetic-check') });
  const value = schema.parse(await provider.generateStructured({ phase: 'understand', system: 'Return exactly the requested JSON object. This is a synthetic connectivity check. No tools or business work are permitted.', context: { synthetic: true, instruction: 'Return status ok and echo centralign-synthetic-check.' }, schema, repair: false, signal: new AbortController().signal, maxOutputTokens: 512, onUsage: (value) => { usage = value; } }));
  console.log(JSON.stringify({ provider: provider.name, model: provider.model, status: 'PASSED', response: value, responseHash: sha256(JSON.stringify(value)), latencyMs: Math.round(performance.now() - started), usage, businessToolsCalled: 0 }));
} catch (error) {
  const fault = error instanceof AgentFault ? error : new AgentFault(provider ? 'SMOKE_FAILED' : 'CONFIGURATION_ERROR', provider ? 'The live provider did not return a validated synthetic response.' : 'Provider configuration is invalid.', provider ? 'PERMANENT' : 'CONFIGURATION');
  console.error(JSON.stringify({ provider: provider?.name ?? 'unconfigured', model: provider?.model ?? null, status: 'FAILED', code: fault.code, category: fault.category, message: fault.message, latencyMs: Math.round(performance.now() - started), businessToolsCalled: 0 })); process.exitCode = 1;
}
