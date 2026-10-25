import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ExecutionErrorSchema, IdentifierSchema, RunEventRecordSchema, parseStoredJson } from '@centralign/shared';
import type { EventType, JsonValue } from '@centralign/shared';
import { canonicalJson, sha256 } from '../persistence/json.js';
import { ArtifactStore } from './artifacts.js';
import { PermissionScopeSchema } from './contracts.js';
import type { ExecutionContext, HandlerContext, ToolOutcome, ToolValue } from './contracts.js';
import { ToolFault } from './errors.js';
import type { PreparedToolInvocation, RegisteredTool, ToolRegistry } from './registry.js';
import type { RestrictedBrowser } from '../browser/adapter.js';
import { enforceRiskPolicy } from './policy.js';

const ContextSchema = z.strictObject({ runId: IdentifierSchema.max(200), stepId: IdentifierSchema.max(200), actorId: IdentifierSchema.max(200), grantedScopes: z.array(PermissionScopeSchema), idempotencyKey: z.string().min(1).max(300).nullable(), deadline: z.number().finite() });
const LedgerSchema = z.object({ id: z.string(), run_id: z.string(), step_id: z.string(), actor_id: z.string().nullable(), tool_name: z.string(), arguments_hash: z.string().nullable(), status: z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN_OUTCOME', 'CANCELLED']), result_json: z.string().nullable(), error_json: z.string().nullable() });
type Ledger = z.infer<typeof LedgerSchema>;

export class ToolExecutor {
  private readonly artifacts: ArtifactStore;
  constructor(private readonly db: Database.Database, private readonly registry: ToolRegistry, workspaceRoot: string, private readonly browser?: RestrictedBrowser) { this.artifacts = new ArtifactStore(workspaceRoot); }

  private assertActive(runId: string, stepId: string): void {
    const row = this.db.prepare('SELECT r.status AS runStatus,s.status AS stepStatus FROM runs r JOIN run_steps s ON s.run_id=r.id WHERE r.id=? AND s.id=?').get(runId, stepId);
    if (!z.object({ runStatus: z.enum(['UNDERSTANDING', 'RUNNING', 'VERIFYING']), stepStatus: z.literal('RUNNING') }).safeParse(row).success) throw new ToolFault('INACTIVE_EXECUTION_CONTEXT', 'Tools require an active run and a running step that belongs to it.', 'PERMISSION');
  }

  private event(context: HandlerContext, type: EventType, payload: unknown): void {
    const event = RunEventRecordSchema.parse({ id: randomUUID(), runId: context.runId, stepId: context.stepId, type, payload, createdAt: context.now() });
    this.db.prepare('INSERT INTO run_events (id,run_id,step_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)').run(event.id, event.runId, event.stepId, event.type, JSON.stringify(event.payload), event.createdAt);
  }
  private insert(tool: RegisteredTool, context: HandlerContext, key: string, input: JsonValue, hash: string): void {
    const now = context.now();
    this.db.prepare(`INSERT INTO tool_executions (id,run_id,step_id,tool_name,idempotency_key,arguments_json,status,attempt_number,created_at,updated_at,started_at,actor_id,arguments_hash)
      VALUES (?,?,?,?,?,?,'RUNNING',1,?,?,?,?,?)`).run(context.executionId, context.runId, context.stepId, tool.metadata.name, key, canonicalJson(input), now, now, now, context.actorId, hash);
    this.event(context, 'TOOL_EXECUTION_STARTED', { executionId: context.executionId, toolName: tool.metadata.name });
  }
  private finish(context: HandlerContext, value: ToolValue<JsonValue>, replayed = false): ToolOutcome {
    this.db.prepare("UPDATE tool_executions SET status='SUCCEEDED',result_json=?,error_json=NULL,updated_at=?,completed_at=? WHERE id=?").run(JSON.stringify(value), context.now(), context.now(), context.executionId);
    this.event(context, 'TOOL_EXECUTION_SUCCEEDED', { executionId: context.executionId, evidence: value.evidence });
    return { ok: true, executionId: context.executionId, ...value, replayed };
  }
  private replay(tool: RegisteredTool, invocation: PreparedToolInvocation, context: HandlerContext, hash: string, row: Ledger): ToolOutcome {
    if (row.tool_name !== tool.metadata.name || row.arguments_hash !== hash || row.run_id !== context.runId || row.step_id !== context.stepId || row.actor_id !== context.actorId) throw new ToolFault('IDEMPOTENCY_CONFLICT', 'The idempotency key is bound to different arguments or execution identity.');
    if (row.status === 'SUCCEEDED' && row.result_json !== null) {
      const stored: unknown = JSON.parse(row.result_json);
      return { ok: true, executionId: row.id, ...this.parseValue(tool, stored), replayed: true };
    }
    if (['RUNNING', 'PENDING', 'UNKNOWN_OUTCOME'].includes(row.status)) {
      if (invocation.reconcile && tool.metadata.persistence === 'filesystem') {
        const value = tool.parseValue(invocation.reconcile({ ...context, executionId: row.id }));
        return this.finish({ ...context, executionId: row.id }, value, true);
      }
      throw new ToolFault('UNRECONCILED_EXECUTION', 'The previous outcome must be reconciled before another write.', 'UNKNOWN_OUTCOME', 'RECONCILE');
    }
    const error = row.error_json === null ? null : parseStoredJson(row.error_json, ExecutionErrorSchema);
    const details = z.object({ category: z.enum(['VALIDATION', 'BUSINESS_RULE', 'PERMISSION', 'TRANSIENT', 'PERMANENT', 'UNKNOWN_OUTCOME']), retryability: z.enum(['NEVER', 'SAFE_READ', 'RECONCILE']) }).safeParse(error?.details);
    return { ok: false, executionId: row.id, error: { code: error?.code ?? 'PREVIOUS_FAILURE', message: error?.message ?? 'This operation previously failed; no automatic retry was attempted.', category: details.success ? details.data.category : 'PERMANENT', retryability: details.success ? details.data.retryability : 'NEVER' } };
  }
  private parseValue(tool: RegisteredTool, raw: unknown): ToolValue<JsonValue> {
    try { return tool.parseValue(raw); }
    catch { throw new ToolFault('INVALID_TOOL_RESULT', 'Tool returned a result that violates its declared schema.', 'PERMANENT'); }
  }
  async execute(name: string, rawInput: unknown, trustedContext: ExecutionContext): Promise<ToolOutcome> {
    let executionId: string | null = null;
    let context: HandlerContext | undefined;
    let tool: RegisteredTool | undefined;
    let input: JsonValue | undefined;
    let key = '';
    let hash = '';
    let enteredHandler = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let detach: (() => void) | undefined;
    try {
      tool = this.registry.resolve(name);
      const invocation = tool.prepare(rawInput);
      input = invocation.input;
      const validated = ContextSchema.parse({ runId: trustedContext.runId, stepId: trustedContext.stepId, actorId: trustedContext.actorId, grantedScopes: trustedContext.grantedScopes, idempotencyKey: trustedContext.idempotencyKey, deadline: trustedContext.deadline });
      const clock = trustedContext.clock ?? (() => new Date());
      if (typeof clock !== 'function' || !Number.isFinite(clock().getTime())) throw new ToolFault('INVALID_CONTEXT', 'Execution clock is invalid.', 'VALIDATION');
      this.assertActive(validated.runId, validated.stepId);
      trustedContext.assertAuthority?.();
      if (tool.metadata.requiredScopes.some((scope) => !validated.grantedScopes.includes(scope))) throw new ToolFault('PERMISSION_DENIED', 'Required server-granted permission scopes are missing.', 'PERMISSION');
      if (tool.metadata.risk === 'external_side_effect' && tool.metadata.name !== 'send_email') throw new ToolFault('RISK_POLICY_DENIED', 'This consequential operation has no approved server policy.', 'PERMISSION');
      if (tool.metadata.changesPersistentState && validated.idempotencyKey === null) throw new ToolFault('IDEMPOTENCY_KEY_REQUIRED', 'State-changing tools require a stable idempotency key.', 'VALIDATION');
      if (trustedContext.signal?.aborted) throw new ToolFault('CANCELLED', 'Execution was cancelled before the operation.', 'TRANSIENT', 'SAFE_READ');
      const duration = Math.min(tool.metadata.timeoutMs, validated.deadline - clock().getTime());
      if (duration <= 0) throw new ToolFault('DEADLINE_EXCEEDED', 'Execution deadline has passed.', 'TRANSIENT', 'SAFE_READ');
      const expires = performance.now() + duration;
      const controller = new AbortController();
      const cancel = () => { controller.abort(); };
      trustedContext.signal?.addEventListener('abort', cancel, { once: true });
      detach = () => { trustedContext.signal?.removeEventListener('abort', cancel); };
      key = tool.metadata.changesPersistentState ? validated.idempotencyKey! : `read:${randomUUID()}`;
      executionId = tool.metadata.changesPersistentState ? `exec-${sha256(key)}` : randomUUID();
      hash = sha256(canonicalJson(input));
      context = { db: this.db, runId: validated.runId, stepId: validated.stepId, actorId: validated.actorId, executionId, signal: controller.signal, deadline: validated.deadline, now: () => clock().toISOString(), artifacts: this.artifacts, browser: this.browser };
      const checkDeadline = () => {
        if (controller.signal.aborted || clock().getTime() >= validated.deadline || performance.now() >= expires) throw new ToolFault('TIMEOUT', 'Tool timed out or was cancelled.', 'TRANSIENT', tool!.metadata.changesPersistentState ? 'NEVER' : 'SAFE_READ');
      };
      const currentTool = tool;
      const currentContext = context;
      const currentInput = input;
      if (tool.metadata.changesPersistentState) {
        return this.db.transaction(() => {
          this.assertActive(currentContext.runId, currentContext.stepId);
          trustedContext.assertAuthority?.();
          const existing = this.db.prepare('SELECT * FROM tool_executions WHERE idempotency_key=?').get(key);
          checkDeadline();
          if (existing) {
            const result = this.replay(currentTool, invocation, currentContext, hash, LedgerSchema.parse(existing));
            checkDeadline();
            return result;
          }
          enforceRiskPolicy(currentTool.metadata, currentInput, currentContext);
          this.insert(currentTool, currentContext, key, currentInput, hash);
          checkDeadline(); enteredHandler = true;
          const raw = invocation.invoke(currentContext);
          if (raw instanceof Promise) { void raw.catch(() => {}); throw new ToolFault('ASYNC_WRITE_FORBIDDEN', 'Local write handlers must be synchronous and transaction-bound.', 'PERMANENT'); }
          const value = this.parseValue(currentTool, raw);
          checkDeadline();
          return this.finish(currentContext, value);
        }).immediate();
      }
      this.db.transaction(() => { this.insert(currentTool, currentContext, key, currentInput, hash); }).immediate();
      enteredHandler = true;
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => { reject(new ToolFault('TIMEOUT', 'Tool timed out or was cancelled.', 'TRANSIENT', 'SAFE_READ')); }, { once: true });
      });
      timeout = setTimeout(() => { controller.abort(); }, duration);
      const raw = await Promise.race([Promise.resolve().then(() => invocation.invoke(currentContext)), aborted]);
      const value = this.parseValue(currentTool, raw);
      checkDeadline();
      return this.db.transaction(() => this.finish(currentContext, value)).immediate();
    } catch (error) {
      const fault = error instanceof ToolFault ? error : error instanceof z.ZodError
        ? new ToolFault('VALIDATION_FAILED', 'Tool arguments or execution context failed validation.', 'VALIDATION')
        : new ToolFault('TOOL_FAILED', 'Tool failed; internal details were withheld.', 'PERMANENT');
      const knownBeforeFileWrite = ['STALE_SOURCE', 'ARTIFACT_CONFLICT', 'UNSAFE_ARTIFACT_PATH', 'UNRECONCILED_ARTIFACT'].includes(fault.code);
      const unknown = fault.category === 'UNKNOWN_OUTCOME' || (enteredHandler && tool?.metadata.persistence === 'filesystem' && !knownBeforeFileWrite);
      const failure: Extract<ToolOutcome, { ok: false }> = { ok: false, executionId, error: { category: unknown ? 'UNKNOWN_OUTCOME' : fault.category, code: fault.code, message: fault.message, retryability: unknown ? 'RECONCILE' : fault.retryability } };
      if (context && !enteredHandler) {
        try { if (!this.db.prepare('SELECT 1 FROM tool_executions WHERE id=?').get(context.executionId)) failure.executionId = null; }
        catch { failure.executionId = null; }
      }
      if (context && tool && input !== undefined && enteredHandler) {
        try {
          this.db.transaction(() => {
            const existing = this.db.prepare('SELECT id FROM tool_executions WHERE idempotency_key=?').get(key);
            if (existing && tool!.metadata.changesPersistentState) return; // Never overwrite a committed or previously uncertain execution.
            if (!existing) this.insert(tool!, context!, key, input!, hash);
            const persistedError = ExecutionErrorSchema.parse({ code: failure.error.code, message: failure.error.message, retryable: failure.error.retryability === 'SAFE_READ', details: { category: failure.error.category, retryability: failure.error.retryability } });
            this.db.prepare('UPDATE tool_executions SET status=?,error_json=?,updated_at=?,completed_at=? WHERE id=?').run(unknown ? 'UNKNOWN_OUTCOME' : 'FAILED', JSON.stringify(persistedError), context!.now(), context!.now(), context!.executionId);
            this.event(context!, unknown ? 'TOOL_EXECUTION_UNKNOWN_OUTCOME' : 'TOOL_EXECUTION_FAILED', { executionId: context!.executionId, error: persistedError });
          }).immediate();
        } catch {
          return { ok: false, executionId, error: { category: 'UNKNOWN_OUTCOME', code: 'LEDGER_UNAVAILABLE', message: 'Execution outcome could not be recorded; reconciliation is required.', retryability: 'RECONCILE' } };
        }
      }
      return failure;
    } finally { if (timeout !== undefined) clearTimeout(timeout); detach?.(); }
  }
}
