import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject } from '@centralign/shared';
import { JsonObjectSchema } from '@centralign/shared';
import { canonicalJson, sha256 } from '../persistence/json.js';
import type { ToolRegistry } from '../tools/registry.js';
import { AgentFault, MAX_CONTEXT_BYTES, MAX_MODEL_OUTPUT_BYTES, MAX_OBSERVATION_BYTES } from './contracts.js';
import type { ModelProvider, StructuredModelRequest } from './contracts.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { RunStore } from './run-store.js';
import { pauseForBackoff } from './recovery.js';
import { redactSecrets, rejectSecrets } from './security.js';

export function compactValue(value: unknown, maxBytes = MAX_OBSERVATION_BYTES): unknown {
  function compact(item: unknown, depth: number): unknown {
    if (typeof item === 'string') return item.length > 240 ? `${item.slice(0, 240)}…[truncated]` : item;
    if (Array.isArray(item)) return item.slice(0, 3).map((entry) => compact(entry, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, 30).map(([key, entry]) => [key, compact(entry, depth + 1)]));
    return item;
  }
  const result = compact(value, 0);
  const encoded = JSON.stringify(result) ?? 'null';
  return Buffer.byteLength(encoded, 'utf8') <= maxBytes ? result : { truncated: true, excerpt: encoded.slice(0, Math.floor(maxBytes / 4)) };
}

export class StructuredDecisions {
  constructor(private readonly store: RunStore, private readonly provider: ModelProvider, private readonly registry: ToolRegistry, private readonly secret?: string) {}
  context(runId: string): JsonObject {
    const state = this.store.state(runId); const run = this.store.run(runId);
    const steps = this.store.steps(runId); const actions = this.store.actions(runId);
    const observations = steps.slice(-6).map((step) => ({ stepId: step.id, description: step.description, status: step.status, toolName: actions.find((action) => action.step_id === step.id)?.tool_name ?? null, result: compactValue(step.output), error: step.error }));
    const facts = steps.filter((step) => step.status === 'SUCCEEDED').slice(-40).map((step) => {
      const output = step.output as { data?: unknown } | null;
      return { stepId: step.id, toolName: actions.find((action) => action.step_id === step.id)?.tool_name ?? '', result: compactValue(output?.data ?? step.output, 1200) };
    });
    const sourceMap = new Map<string, unknown>();
    for (const step of steps.filter((item) => item.status === 'SUCCEEDED')) {
      const parsed = z.object({ ok: z.literal(true), evidence: z.array(z.object({ kind: z.string(), id: z.string(), reference: z.string(), metadata: JsonObjectSchema })) }).safeParse(step.output);
      if (parsed.success) for (const evidence of parsed.data.evidence) if (evidence.kind === 'document') sourceMap.set(evidence.id, evidence);
    }
    const tools = this.registry.list().map((metadata) => ({ name: metadata.name, description: metadata.description, risk: metadata.risk, allowed: metadata.requiredScopes.every((scope) => state.scopes.includes(scope)), inputSchema: metadata.name === 'send_email' ? { type: 'object', properties: { draftId: { type: 'string' } }, required: ['draftId'], additionalProperties: false } : z.toJSONSchema(this.registry.resolve(metadata.name).inputSchema, { target: 'draft-7' }) }));
    const context = {
      originalRequest: run.objective, goal: state.goal, currentPlan: this.store.plan(runId).plan, resolvedCustomerId: state.resolved_customer_id,
      observations, successfulActions: facts, sources: [...sourceMap.values()].slice(-20), questions: this.store.questions(runId).map((question) => ({ id: question.id, text: question.text, status: question.status, answer: question.answer?.slice(0, 1000) ?? null, choiceId: question.choiceId })),
      pendingApprovals: this.store.approvals(runId, true).map((approval) => ({ id: approval.id, stepId: approval.stepId, status: approval.status })),
      feedback: state.feedback_json ? JSON.parse(state.feedback_json) as unknown : null, tools,
      constraints: { untrustedObservations: true, sequentialActions: true, emailTransport: 'sandbox_only', remainingModelCalls: state.budgets.maxModelCalls - state.model_calls, remainingToolCalls: state.budgets.maxToolCalls - state.tool_calls, remainingRecoveries: state.budgets.maxRecoveries - state.recoveries, remainingReplans: state.budgets.maxReplans - state.replans, deadlineAt: state.deadline_at },
    };
    while (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_CONTEXT_BYTES && context.observations.length > 1) context.observations.shift();
    while (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_CONTEXT_BYTES && context.successfulActions.length > 1) context.successfulActions.shift();
    const encoded = redactSecrets(JSON.stringify(context), this.secret);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_CONTEXT_BYTES) throw new AgentFault('CONTEXT_LIMIT', 'Bounded decision context exceeded its safe limit.', 'BUDGET');
    return JsonObjectSchema.parse(JSON.parse(encoded) as unknown);
  }
  async request<T>(runId: string, phase: StructuredModelRequest['phase'], schema: z.ZodType<T>, signal: AbortSignal, guard: () => void, semantic: (value: T) => void = () => {}): Promise<T> {
    let repaired = false; let transientAttempt = 0;
    while (true) {
      guard();
      if (!this.provider.configured) throw new AgentFault('MODEL_UNCONFIGURED', 'Configure OPENAI_API_KEY before a live task can execute.', 'CONFIGURATION');
      const state = this.store.state(runId); const id = randomUUID(); const context = this.context(runId);
      if (repaired) context['repairInstruction'] = 'The previous candidate failed schema or semantic validation. Correct it once; preserve every requested deliverable and server constraint.';
      this.store.transaction(() => {
        this.store.counter(runId, 'model_calls', state.budgets.maxModelCalls);
        this.store.db.prepare("INSERT INTO agent_model_calls(id,run_id,phase,status,request_hash,created_at) VALUES(?,?,?,'STARTED',?,?)").run(id, runId, phase, sha256(canonicalJson(context)), this.store.now());
        this.store.event(runId, 'MODEL_CALL_STARTED', { modelCallId: id, phase, repair: repaired });
      });
      const controller = new AbortController(); const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      const duration = Math.max(1, Math.min(state.budgets.modelTimeoutMs, Date.parse(state.deadline_at) - this.store.clock().getTime()));
      const timer = setTimeout(abort, duration);
      const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new AgentFault(signal.aborted ? 'MODEL_CANCELLED' : 'MODEL_TIMEOUT', signal.aborted ? 'Model request cancelled.' : 'Model request timed out.', signal.aborted ? 'CANCELLED' : 'TRANSIENT')), { once: true }));
      try {
        const raw = await Promise.race([this.provider.generateStructured({ phase, system: `${SYSTEM_PROMPT}\nCurrent phase: ${phase}.`, context, schema, repair: repaired, signal: controller.signal }), aborted]);
        guard();
        const encoded = JSON.stringify(raw) ?? 'null';
        if (Buffer.byteLength(encoded, 'utf8') > MAX_MODEL_OUTPUT_BYTES) throw new AgentFault('MODEL_RESPONSE_TOO_LARGE', 'Model candidate exceeded the output limit.');
        rejectSecrets(encoded, this.secret);
        const parsed = schema.safeParse(raw);
        if (!parsed.success) throw new AgentFault('MODEL_SCHEMA_INVALID', 'Model candidate did not match the required schema.', 'VALIDATION');
        semantic(parsed.data);
        this.store.db.prepare("UPDATE agent_model_calls SET status='SUCCEEDED',response_hash=?,completed_at=? WHERE id=?").run(sha256(encoded), this.store.now(), id);
        return parsed.data;
      } catch (error) {
        const fault = error instanceof AgentFault ? error : new AgentFault('MODEL_FAILED', 'Model request failed without a safe structured result.');
        this.store.db.prepare("UPDATE agent_model_calls SET status='FAILED',error_code=?,completed_at=? WHERE id=?").run(fault.code, this.store.now(), id);
        this.store.event(runId, 'MODEL_CALL_FAILED', { modelCallId: id, phase, code: fault.code });
        if (fault.category === 'VALIDATION' && !repaired) {
          this.store.counter(runId, 'recoveries', state.budgets.maxRecoveries); repaired = true;
          this.store.event(runId, 'RECOVERY_ATTEMPTED', { kind: 'structured_output_repair', modelCallId: id }); continue;
        }
        if (fault.category === 'TRANSIENT' && transientAttempt < 2) {
          this.store.counter(runId, 'recoveries', state.budgets.maxRecoveries);
          this.store.event(runId, 'RETRY_SCHEDULED', { kind: 'model', attempt: transientAttempt + 1, code: fault.code });
          await pauseForBackoff(transientAttempt++, signal); continue;
        }
        throw fault;
      } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
  }
}
