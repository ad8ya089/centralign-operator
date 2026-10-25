import type { z } from 'zod';
import type { JsonObject } from '@centralign/shared';
import type { ToolOutcome, ExecutionContext } from '../tools/contracts.js';

export class AgentFault extends Error {
  constructor(readonly code: string, message: string, readonly category: 'CONFIGURATION' | 'VALIDATION' | 'TRANSIENT' | 'PERMANENT' | 'BUDGET' | 'CANCELLED' | 'CONFLICT' = 'PERMANENT') { super(message); this.name = 'AgentFault'; }
}
export interface StructuredModelRequest {
  readonly phase: 'understand' | 'plan' | 'act'; readonly system: string; readonly context: JsonObject;
  readonly schema: z.ZodType; readonly repair: boolean; readonly signal: AbortSignal;
}
export interface ModelProvider { readonly configured: boolean; generateStructured(request: StructuredModelRequest): Promise<unknown> }
export interface ToolExecutionPort { execute(name: string, input: unknown, context: ExecutionContext): Promise<ToolOutcome> }
export interface RuntimeBudgets { maxModelCalls: number; maxToolCalls: number; maxRecoveries: number; maxReplans: number; runTimeoutMs: number; modelTimeoutMs: number }
export const MAX_OBSERVATION_BYTES = 4000;
export const MAX_CONTEXT_BYTES = 64000;
export const MAX_MODEL_OUTPUT_BYTES = 65536;
export const MAX_ARTIFACT_BYTES = 32768;
