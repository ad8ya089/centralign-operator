import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GoalSpecificationSchema, JsonObjectSchema, NextActionEnvelopeSchema, PlanSchema, QuestionProposalSchema, parseStoredJson } from '@centralign/shared';
import type { FinalResult, JsonObject, NextAction, QuestionProposal } from '@centralign/shared';
import { ToolOutcomeSchema } from '../tools/contracts.js';
import type { ExecutionContext, ToolOutcome } from '../tools/contracts.js';
import type { ToolRegistry } from '../tools/registry.js';
import { BusinessStore } from '../tools/business-store.js';
import { canonicalSendAction } from '../tools/policy.js';
import { canonicalJson, sha256 } from '../persistence/json.js';
import { AgentFault, MAX_ARTIFACT_BYTES } from './contracts.js';
import type { ModelProvider, ToolExecutionPort } from './contracts.js';
import { RunStore } from './run-store.js';
import type { StoredAction } from './run-store.js';
import { StructuredDecisions } from './model-provider.js';
import { IndependentVerifier } from './verifier.js';
import { validateGoal, validatePlan } from './planner.js';
import { categoryTool, rejectSecrets } from './security.js';
import type { SensitiveValues } from './security.js';
import { pauseForBackoff, retryableRead } from './recovery.js';
import { normalizeName } from '../context/knowledge.js';

const terminal = new Set(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']);
export class AgentRuntime {
  readonly verifier: IndependentVerifier;
  private readonly decisions: StructuredDecisions;
  constructor(readonly store: RunStore, private readonly registry: ToolRegistry, private readonly executor: ToolExecutionPort, provider: ModelProvider, workspaceRoot: string, private readonly secret?: SensitiveValues) {
    this.decisions = new StructuredDecisions(store, provider, registry, secret); this.verifier = new IndependentVerifier(store, workspaceRoot);
  }
  private guard(runId: string, owner: string, signal: AbortSignal, allowCancel = false): void {
    this.store.assertLease(runId, owner);
    const state = this.store.state(runId);
    if (signal.aborted || !allowCancel && state.cancel_requested) throw new AgentFault('CANCELLED', 'Execution was interrupted or cancellation was requested.', 'CANCELLED');
    if (Date.parse(state.deadline_at) <= this.store.clock().getTime()) throw new AgentFault('RUN_DEADLINE', 'Overall run deadline exhausted.', 'BUDGET');
    if (terminal.has(this.store.run(runId).status)) throw new AgentFault('RUN_TERMINAL', 'Terminal runs cannot execute.', 'CONFLICT');
  }
  private feedback(runId: string, code: string, message: string): void { this.store.feedback(runId, { code, message }); }
  private recoverBudget(runId: string, kind: string, stepId: string): void {
    this.store.counter(runId, 'recoveries', this.store.state(runId).budgets.maxRecoveries);
    this.store.event(runId, 'RECOVERY_ATTEMPTED', { kind }, stepId);
  }
  private final(runId: string, reason: string, cancelled = false): void {
    if (terminal.has(this.store.run(runId).status)) return;
    const verification = this.verifier.goal(runId);
    let result: FinalResult = verification.result;
    result = { ...result, summary: `${cancelled ? 'Cancelled. ' : ''}${reason} ${result.summary}`.slice(0, 1000) };
    const partial = result.verified.length > 0;
    if (!cancelled && partial && this.store.run(runId).status === 'RUNNING') this.store.moveRun(runId, 'VERIFYING', 'Establishing partial completion');
    const status = cancelled ? 'CANCELLED' : partial && ['VERIFYING', 'WAITING_INPUT', 'WAITING_APPROVAL'].includes(this.store.run(runId).status) ? 'PARTIAL' : 'FAILED';
    this.store.transaction(() => { this.store.final(runId, result); this.store.moveRun(runId, status, reason); this.store.event(runId, 'RUN_FINISHED', { status, verifiedDeliverableIds: result.verified.map((item) => item.deliverableId), outstandingDeliverableIds: result.outstanding.map((item) => item.deliverableId), reason }); });
  }
  private question(runId: string, question: QuestionProposal): void {
    rejectSecrets(JSON.stringify(question), this.secret);
    if (question.topic === 'CUSTOMER_IDENTITY') for (const choice of question.choices) new BusinessStore(this.store.db).customer(choice.id);
    this.store.question(runId, question);
  }
  private record(action: StoredAction, outcome: ToolOutcome): void {
    this.store.transaction(() => {
      const safe = ToolOutcomeSchema.parse(outcome);
      this.store.db.prepare('UPDATE run_steps SET output_json=?,error_json=?,updated_at=? WHERE id=?').run(JSON.stringify(safe), safe.ok ? null : JSON.stringify({ code: safe.error.code, message: safe.error.message, retryable: safe.error.retryability === 'SAFE_READ', details: { category: safe.error.category, retryability: safe.error.retryability } }), this.store.now(), action.step_id);
      if (safe.executionId && this.store.db.prepare('SELECT 1 FROM tool_executions WHERE id=? AND run_id=? AND step_id=?').get(safe.executionId, action.run_id, action.step_id)) this.store.db.prepare('UPDATE agent_steps SET execution_id=? WHERE step_id=?').run(safe.executionId, action.step_id);
    });
  }
  private verifyAndObserve(action: StoredAction, outcome: Extract<ToolOutcome, { ok: true }>): void {
    this.record(action, outcome);
    const check = this.verifier.step(action, outcome); this.store.check(action.run_id, check, action.step_id);
    if (!check.passed) {
      this.store.moveStep(action.step_id, 'BLOCKED', check.explanation);
      this.store.db.prepare('UPDATE agent_steps SET blocked_reason=? WHERE step_id=?').run(check.explanation, action.step_id);
      this.feedback(action.run_id, 'VERIFICATION_FAILED', check.explanation); return;
    }
    this.store.moveStep(action.step_id, 'SUCCEEDED', 'Independent verification passed');
    const data = outcome.data;
    if (action.tool_name === 'search_customers') {
      const resolution = z.object({ resolution: z.enum(['NONE', 'UNIQUE', 'AMBIGUOUS']), candidates: z.array(z.object({ id: z.string(), companyName: z.string() })) }).parse(data);
      if (resolution.resolution === 'UNIQUE' && resolution.candidates.length === 1) {
        const customer = new BusinessStore(this.store.db).customer(resolution.candidates[0]!.id);
        const state = this.store.state(action.run_id); const original = normalizeName(this.store.run(action.run_id).objective);
        const matchesRequest = state.goal?.entities.some((entity) => original.includes(normalizeName(entity.name)) && normalizeName(customer.companyName).includes(normalizeName(entity.name))) ?? false;
        if (matchesRequest) this.store.db.prepare('UPDATE agent_runs SET resolved_customer_id=? WHERE run_id=?').run(customer.id, action.run_id);
        else this.question(action.run_id, { text: 'Confirm which customer the original request refers to.', reason: 'A candidate record cannot silently replace the referenced entity.', topic: 'CUSTOMER_IDENTITY', choices: [{ id: customer.id, label: customer.companyName }] });
      } else this.question(action.run_id, { text: resolution.resolution === 'NONE' ? 'No matching customer was found. Identify an existing customer to use.' : 'Several customers match. Which account should be used?', reason: 'Customer identity must be resolved before business writes.', topic: 'CUSTOMER_IDENTITY', choices: resolution.candidates.map((item) => ({ id: item.id, label: item.companyName })) });
    }
  }
  private committed(action: StoredAction): Extract<ToolOutcome, { ok: true }> | null {
    const row = action.idempotency_key
      ? this.store.db.prepare('SELECT id,run_id,step_id,tool_name,actor_id,arguments_hash,status,result_json FROM tool_executions WHERE idempotency_key=?').get(action.idempotency_key)
      : this.store.db.prepare('SELECT id,run_id,step_id,tool_name,actor_id,arguments_hash,status,result_json FROM tool_executions WHERE run_id=? AND step_id=? ORDER BY rowid DESC LIMIT 1').get(action.run_id, action.step_id);
    if (!row) return null;
    const stored = z.object({ id: z.string(), run_id: z.string(), step_id: z.string(), tool_name: z.string(), actor_id: z.string().nullable(), arguments_hash: z.string().nullable(), status: z.string(), result_json: z.string().nullable() }).parse(row);
    if (stored.status !== 'SUCCEEDED' || !stored.result_json || stored.run_id !== action.run_id || stored.step_id !== action.step_id || stored.tool_name !== action.tool_name || stored.actor_id !== this.store.state(action.run_id).actor_id || stored.arguments_hash !== sha256(canonicalJson(parseStoredJson(action.arguments_json, JsonObjectSchema)))) return null;
    const value = this.registry.resolve(action.tool_name).parseValue(JSON.parse(stored.result_json) as unknown);
    return { ok: true, executionId: stored.id, ...value, replayed: true };
  }
  private preconditions(runId: string, name: string, args: JsonObject): void {
    const state = this.store.state(runId); const business = new BusinessStore(this.store.db); const metadata = this.registry.resolve(name).metadata;
    if (!metadata.requiredScopes.every((scope) => state.scopes.includes(scope))) throw new AgentFault('PERMISSION_DENIED', 'The original request does not authorize this capability.', 'VALIDATION');
    if (metadata.changesPersistentState) {
      const businessWrite = ['create_project', 'create_task', 'create_email_draft', 'send_email'].includes(name);
      if (businessWrite && !state.resolved_customer_id) throw new AgentFault('CUSTOMER_UNRESOLVED', 'Resolve the customer through company/customer tools before business writes.', 'VALIDATION');
      if (businessWrite) {
        const sourceIds = new Set<string>();
        for (const step of this.store.steps(runId).filter((item) => item.status === 'SUCCEEDED')) {
          const outcome = ToolOutcomeSchema.safeParse(step.output);
          if (outcome.success && outcome.data.ok) for (const evidence of outcome.data.evidence) if (evidence.kind === 'document') sourceIds.add(evidence.id);
        }
        if (!sourceIds.size || state.goal?.intent === 'ONBOARDING' && (!sourceIds.has('doc-security-policy') || !sourceIds.has('doc-onboarding-sop'))) throw new AgentFault('CONTEXT_REQUIRED', 'Read the relevant SOP and security policy before onboarding writes.', 'VALIDATION');
      }
      if (name === 'create_project' || name === 'create_email_draft') if (args['customerId'] !== state.resolved_customer_id) throw new AgentFault('CUSTOMER_MISMATCH', 'The proposed customer does not match the resolved account.', 'VALIDATION');
      if (name === 'create_task' && business.project(z.string().parse(args['projectId'])).customerId !== state.resolved_customer_id) throw new AgentFault('CUSTOMER_MISMATCH', 'The project belongs to a different customer.', 'VALIDATION');
      if (name === 'send_email' && business.draft(z.string().parse(args['draftId'])).customerId !== state.resolved_customer_id) throw new AgentFault('CUSTOMER_MISMATCH', 'The draft belongs to a different customer.', 'VALIDATION');
      if (name === 'write_artifact' && Buffer.byteLength(z.string().parse(args['content']), 'utf8') > MAX_ARTIFACT_BYTES) throw new AgentFault('ARTIFACT_LIMIT', 'Runtime artifacts are limited to 32 KiB.', 'VALIDATION');
      if (name === 'create_email_draft' && z.string().parse(args['body']).length > 10000) throw new AgentFault('DRAFT_LIMIT', 'Runtime email drafts are limited to 10,000 characters.', 'VALIDATION');
    }
  }
  private pauseApproval(action: StoredAction): void {
    const args = parseStoredJson(action.arguments_json, JsonObjectSchema);
    const canonical = canonicalSendAction(new BusinessStore(this.store.db).draft(z.string().parse(args['draftId'])));
    rejectSecrets(JSON.stringify(canonical), this.secret);
    this.store.transaction(() => {
      const id = action.approval_id ?? randomUUID();
      if (!action.approval_id) this.store.db.prepare("INSERT INTO approvals(id,run_id,step_id,action_json,policy_reason,status,requested_at,expires_at) VALUES(?,?,?,?,?,'PENDING',?,?)").run(id, action.run_id, action.step_id, canonicalJson(canonical), 'Explicit approval is required for this exact sandbox send action.', this.store.now(), this.store.state(action.run_id).deadline_at);
      const actualArgs = { draftId: canonical.draftId, approvalId: id };
      this.store.db.prepare('UPDATE agent_steps SET approval_id=?,arguments_json=? WHERE step_id=?').run(id, JSON.stringify(actualArgs), action.step_id);
      this.store.db.prepare('UPDATE run_steps SET input_json=? WHERE id=?').run(JSON.stringify(actualArgs), action.step_id);
      this.store.moveStep(action.step_id, 'WAITING_APPROVAL', 'Exact action is awaiting a human decision');
      this.store.moveRun(action.run_id, 'WAITING_APPROVAL', 'Sandbox send requires approval');
      this.store.event(action.run_id, 'APPROVAL_REQUESTED', { approvalId: id, actionHash: sha256(canonicalJson(canonical)), toolName: 'send_email' }, action.step_id);
      this.store.event(action.run_id, 'RUNTIME_PAUSED', { reason: 'WAITING_APPROVAL', approvalId: id }, action.step_id);
    });
  }
  private async execute(action: StoredAction, owner: string, signal: AbortSignal): Promise<void> {
    if (this.store.step(action.step_id).status === 'WAITING_APPROVAL') {
      const approval = this.store.approvals(action.run_id).find((item) => item.id === action.approval_id);
      if (approval?.status !== 'APPROVED') {
        this.store.moveStep(action.step_id, 'BLOCKED', 'Approval was rejected, expired, or cancelled');
        this.store.db.prepare('UPDATE agent_steps SET blocked_reason=? WHERE step_id=?').run('Approval was rejected, expired, or cancelled.', action.step_id);
        this.final(action.run_id, 'The required action was not approved.'); return;
      }
      this.store.moveStep(action.step_id, 'READY', 'Persisted exact action was approved');
    }
    let attempts = 0;
    while (true) {
      this.guard(action.run_id, owner, signal);
      const state = this.store.state(action.run_id); const metadata = this.registry.resolve(action.tool_name).metadata;
      this.store.counter(action.run_id, 'tool_calls', state.budgets.maxToolCalls);
      if (this.store.step(action.step_id).status !== 'RUNNING') this.store.moveStep(action.step_id, 'RUNNING', 'Executing one validated business action');
      const context: ExecutionContext = { runId: action.run_id, stepId: action.step_id, actorId: state.actor_id, grantedScopes: state.scopes, idempotencyKey: action.idempotency_key, deadline: Date.parse(state.deadline_at), signal, clock: this.store.clock,
        assertAuthority: () => { this.guard(action.run_id, owner, signal); } };
      let outcome: ToolOutcome;
      try { outcome = ToolOutcomeSchema.parse(await this.executor.execute(action.tool_name, this.store.step(action.step_id).input, context)); }
      catch { outcome = { ok: false, executionId: null, error: { category: metadata.changesPersistentState ? 'UNKNOWN_OUTCOME' : 'PERMANENT', code: 'TOOL_RESPONSE_LOST', message: 'The tool response was interrupted; persisted state must be inspected.', retryability: metadata.changesPersistentState ? 'RECONCILE' : 'NEVER' } }; }
      this.store.assertLease(action.run_id, owner); this.record(action, outcome);
      if (outcome.ok) { this.verifyAndObserve(action, outcome); return; }
      if (outcome.error.category === 'UNKNOWN_OUTCOME') {
        this.store.event(action.run_id, 'TOOL_EXECUTION_UNKNOWN_OUTCOME', { code: outcome.error.code, executionId: outcome.executionId }, action.step_id);
        this.recoverBudget(action.run_id, 'reconcile_uncertain_action', action.step_id);
        const committed = this.committed(action);
        if (committed) { this.verifyAndObserve(action, committed); return; }
        if (metadata.persistence === 'filesystem' && !signal.aborted) {
          // The existing executor permits only matching, already-owned bytes to be adopted for an uncertain file result.
          const row = this.store.db.prepare('SELECT status FROM tool_executions WHERE idempotency_key=?').get(action.idempotency_key) as { status: string } | undefined;
          if (row && ['RUNNING', 'PENDING', 'UNKNOWN_OUTCOME'].includes(row.status)) {
            this.store.counter(action.run_id, 'tool_calls', state.budgets.maxToolCalls);
            const reconciled = await this.executor.execute(action.tool_name, this.store.step(action.step_id).input, context);
            if (reconciled.ok) { this.verifyAndObserve(action, reconciled); return; }
          }
        }
        this.store.moveStep(action.step_id, 'BLOCKED', 'The write outcome remains unreconciled');
        this.store.db.prepare('UPDATE agent_steps SET blocked_reason=? WHERE step_id=?').run('UNKNOWN_OUTCOME', action.step_id);
        this.question(action.run_id, { text: 'An action outcome is unresolved. Reconcile its persisted execution before continuing.', reason: 'A potentially committed write must never be repeated blindly.', topic: 'RECONCILIATION', choices: [] }); return;
      }
      if (retryableRead(outcome, metadata.changesPersistentState) && attempts < 2 && !signal.aborted) {
        this.recoverBudget(action.run_id, 'safe_read_retry', action.step_id);
        this.store.moveStep(action.step_id, 'RETRYING', outcome.error.code);
        this.store.event(action.run_id, 'RETRY_SCHEDULED', { attempt: attempts + 1, code: outcome.error.code }, action.step_id);
        await pauseForBackoff(attempts++, signal); continue;
      }
      const blocked = outcome.error.category === 'PERMISSION';
      this.store.moveStep(action.step_id, blocked ? 'BLOCKED' : 'FAILED', outcome.error.message);
      this.store.db.prepare('UPDATE agent_steps SET blocked_reason=? WHERE step_id=?').run(outcome.error.message, action.step_id);
      this.feedback(action.run_id, outcome.error.code, outcome.error.message); return;
    }
  }
  private async recoverStep(action: StoredAction, owner: string, signal: AbortSignal): Promise<void> {
    const committed = this.committed(action);
    if (committed) { this.store.event(action.run_id, 'RECOVERY_ATTEMPTED', { kind: 'restore_committed_result' }, action.step_id); this.verifyAndObserve(action, committed); return; }
    const metadata = this.registry.resolve(action.tool_name).metadata;
    const row = this.store.db.prepare('SELECT status,error_json FROM tool_executions WHERE run_id=? AND step_id=? ORDER BY rowid DESC LIMIT 1').get(action.run_id, action.step_id) as { status: string; error_json: string | null } | undefined;
    if (row && ['FAILED', 'CANCELLED'].includes(row.status)) {
      const prior = ToolOutcomeSchema.safeParse(this.store.step(action.step_id).output);
      if (!prior.success || prior.data.ok || !retryableRead(prior.data, metadata.changesPersistentState)) {
        this.store.moveStep(action.step_id, 'FAILED', 'A non-retryable persisted failure survived interruption');
        this.feedback(action.run_id, 'PREVIOUS_FAILURE', 'The persisted failed action was not retried.'); return;
      }
    }
    if (!metadata.changesPersistentState || metadata.persistence === 'sqlite' && !row) {
      // Read effects are safe to retry. SQLite local writes cannot commit without their success ledger in the same transaction.
      this.recoverBudget(action.run_id, 'resume_interrupted_local_action', action.step_id);
      if (!metadata.changesPersistentState) this.store.db.prepare("UPDATE tool_executions SET status='CANCELLED',updated_at=?,completed_at=? WHERE run_id=? AND step_id=? AND status='RUNNING'").run(this.store.now(), this.store.now(), action.run_id, action.step_id);
      this.store.moveStep(action.step_id, 'RETRYING', 'Interrupted action was reconciled as safe to resume');
      await this.execute(action, owner, signal); return;
    }
    if (metadata.persistence === 'filesystem' && row && ['RUNNING', 'PENDING', 'UNKNOWN_OUTCOME'].includes(row.status)) {
      this.recoverBudget(action.run_id, 'reconcile_interrupted_artifact', action.step_id);
      await this.execute(action, owner, signal); return;
    }
    this.store.moveStep(action.step_id, 'BLOCKED', 'Interrupted mutation needs authoritative reconciliation');
    this.store.db.prepare("UPDATE agent_steps SET blocked_reason='UNKNOWN_OUTCOME' WHERE step_id=?").run(action.step_id);
    this.question(action.run_id, { text: 'Interrupted mutation requires reconciliation before resumption.', reason: 'No committed result could be established without another write.', topic: 'RECONCILIATION', choices: [] });
  }
  private cancellation(runId: string): void {
    for (const action of this.store.actions(runId)) {
      const step = this.store.step(action.step_id);
      if (!['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(step.status) && this.registry.resolve(action.tool_name).metadata.changesPersistentState) {
        const committed = this.committed(action);
        if (committed) {
          if (['BLOCKED', 'WAITING_APPROVAL'].includes(step.status)) this.store.moveStep(step.id, 'READY', 'Restoring a committed effect before cancellation');
          if (this.store.step(step.id).status !== 'RUNNING') this.store.moveStep(step.id, 'RUNNING', 'Reading back a committed effect before cancellation');
          this.verifyAndObserve(action, committed);
        }
        else {
          const row = this.store.db.prepare('SELECT status FROM tool_executions WHERE idempotency_key=?').get(action.idempotency_key) as { status: string } | undefined;
          if (row && ['UNKNOWN_OUTCOME', 'RUNNING', 'PENDING'].includes(row.status) || this.registry.resolve(action.tool_name).metadata.persistence === 'filesystem') {
            if (step.status !== 'BLOCKED') this.store.moveStep(step.id, 'BLOCKED', 'Cancellation is waiting for write reconciliation');
            this.store.db.prepare("UPDATE agent_steps SET blocked_reason='UNKNOWN_OUTCOME' WHERE step_id=?").run(step.id);
            this.question(runId, { text: 'Cancellation is pending until the interrupted write is reconciled.', reason: 'Cancellation cannot pretend to reverse or erase an uncertain committed effect.', topic: 'RECONCILIATION', choices: [] }); return;
          }
        }
      }
      if (!['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(this.store.step(step.id).status)) this.store.moveStep(step.id, 'CANCELLED', 'Cancellation requested');
    }
    this.store.db.prepare("UPDATE approvals SET status='CANCELLED',decided_at=?,decision_maker='local-runtime',decision_note='Run cancelled' WHERE run_id=? AND status='PENDING'").run(this.store.now(), runId);
    this.store.db.prepare("UPDATE agent_questions SET status='CANCELLED' WHERE run_id=? AND status='PENDING'").run(runId);
    this.final(runId, 'No new actions were started after cancellation was observed.', true);
  }
  private async decide(runId: string, owner: string, signal: AbortSignal): Promise<NextAction> {
    const state = this.store.state(runId); const adapting = state.feedback_json !== null;
    if (adapting) this.store.counter(runId, 'replans', state.budgets.maxReplans);
    const result = await this.decisions.request(runId, 'act', NextActionEnvelopeSchema, signal, () => this.guard(runId, owner, signal));
    this.store.feedback(runId, null);
    if (result.decision.revisedPlan) {
      if (!adapting) this.store.counter(runId, 'replans', state.budgets.maxReplans);
      validatePlan(result.decision.revisedPlan, state.goal!); this.store.savePlan(runId, result.decision.revisedPlan);
    }
    return result.decision;
  }
  private propose(runId: string, decision: Extract<NextAction, { kind: 'tool' }>): StoredAction | null {
    const tool = this.registry.resolve(decision.toolName); const raw = parseStoredJson(decision.argumentsJson, JsonObjectSchema);
    rejectSecrets(decision.argumentsJson, this.secret);
    const args = decision.toolName === 'send_email'
      ? JsonObjectSchema.parse(z.strictObject({ draftId: z.string().min(1) }).parse(raw))
      : JsonObjectSchema.parse(tool.prepare(raw).input);
    const goal = this.store.state(runId).goal!;
    for (const id of decision.deliverableIds) {
      const deliverable = goal.deliverables.find((item) => item.id === id);
      if (!deliverable || !categoryTool[deliverable.category].includes(decision.toolName) && !(deliverable.category === 'EMAIL_SEND' && decision.toolName === 'create_email_draft')) throw new AgentFault('DELIVERABLE_MISMATCH', 'Action does not correspond to its claimed deliverable.', 'VALIDATION');
    }
    if (tool.metadata.changesPersistentState && !decision.deliverableIds.length) throw new AgentFault('UNREQUESTED_WRITE', 'A mutating action must support a required deliverable.', 'VALIDATION');
    this.preconditions(runId, decision.toolName, args);
    const material = decision.toolName === 'send_email' ? canonicalSendAction(new BusinessStore(this.store.db).draft(z.string().parse(args['draftId']))) : args;
    const operationHash = tool.metadata.changesPersistentState ? sha256(canonicalJson({ tool: decision.toolName, arguments: material })) : null;
    if (operationHash) {
      const prior = this.store.findOperation(runId, operationHash);
      if (prior) {
        this.store.link(prior.step_id, runId, decision.deliverableIds);
        this.store.event(runId, 'DUPLICATE_ACTION', { originalStepId: prior.step_id, status: this.store.step(prior.step_id).status, toolName: decision.toolName });
        this.feedback(runId, 'DUPLICATE_ACTION', 'The same operation already exists; its recorded result is reused and no new effect is permitted.'); return null;
      }
    }
    const action = this.store.propose(runId, decision.toolName, args, decision.purpose, decision.expectedOutcome, decision.deliverableIds, operationHash, raw);
    if (decision.toolName === 'send_email') { this.pauseApproval(action); return null; }
    return action;
  }
  async process(runId: string, parentSignal: AbortSignal): Promise<void> {
    const initial = this.store.state(runId); if (terminal.has(this.store.run(runId).status)) return;
    const owner = randomUUID(); const leaseDuration = Math.max(60000, initial.budgets.modelTimeoutMs * 2 + 10000);
    if (!this.store.lease(runId, owner, leaseDuration)) return;
    const controller = new AbortController(); const abort = () => controller.abort(); parentSignal.addEventListener('abort', abort, { once: true });
    const heartbeat = setInterval(() => { try { if (!this.store.heartbeat(runId, owner, leaseDuration) || this.store.state(runId).cancel_requested) controller.abort(); } catch { controller.abort(); } }, 1000); heartbeat.unref();
    try {
      this.store.event(runId, 'RUNTIME_RESUMED', { reason: 'Runtime owns the durable run lease' });
      this.store.db.prepare("UPDATE agent_model_calls SET status='INTERRUPTED',error_code='PROCESS_RESTART',completed_at=? WHERE run_id=? AND status='STARTED'").run(this.store.now(), runId);
      while (!terminal.has(this.store.run(runId).status)) {
        const state = this.store.state(runId);
        if (state.cancel_requested) { this.cancellation(runId); return; }
        if (['WAITING_APPROVAL', 'WAITING_INPUT'].includes(this.store.run(runId).status)) return;
        this.guard(runId, owner, controller.signal);
        const status = this.store.run(runId).status;
        if (status === 'CREATED') { this.store.moveRun(runId, 'UNDERSTANDING', 'Interpreting the original request'); continue; }
        if (status === 'UNDERSTANDING') {
          if (!state.goal) {
            const goal = await this.decisions.request(runId, 'understand', GoalSpecificationSchema, controller.signal, () => this.guard(runId, owner, controller.signal), (candidate) => validateGoal(candidate, this.store.run(runId).objective, state.scopes, this.registry));
            this.store.saveGoal(runId, goal); continue;
          }
          const unanswered = state.goal.questions.find((question) => !this.store.questions(runId).some((stored) => stored.status === 'ANSWERED' && stored.text === question.text && stored.topic === question.topic));
          if (unanswered) { this.question(runId, unanswered); return; }
          if (!this.store.plan(runId).plan) {
            const plan = await this.decisions.request(runId, 'plan', PlanSchema, controller.signal, () => this.guard(runId, owner, controller.signal), (candidate) => validatePlan(candidate, state.goal!)); this.store.savePlan(runId, plan);
          }
          this.store.moveRun(runId, 'PLANNED', 'A validated initial plan is persisted'); continue;
        }
        if (status === 'PLANNED') { this.store.moveRun(runId, 'RUNNING', 'Selecting actions from live observations'); continue; }
        if (status === 'VERIFYING') {
          const verification = this.verifier.goal(runId);
          if (verification.complete) {
            this.store.transaction(() => { this.store.final(runId, verification.result); this.store.moveRun(runId, 'COMPLETED', 'All required independent checks passed'); this.store.event(runId, 'RUN_FINISHED', { status: 'COMPLETED', verifiedDeliverableIds: verification.result.verified.map((item) => item.deliverableId) }); }); return;
          }
          this.feedback(runId, 'GOAL_INCOMPLETE', verification.result.outstanding.map((item) => `${item.deliverableId}: ${item.reason}`).join('; ').slice(0, 1000));
          this.store.moveRun(runId, 'RUNNING', 'Final verification found missing work; bounded adaptation is required'); continue;
        }
        const unfinished = this.store.actions(runId).find((action) => ['READY', 'RUNNING', 'RETRYING', 'WAITING_APPROVAL'].includes(this.store.step(action.step_id).status));
        if (unfinished) {
          if (this.store.step(unfinished.step_id).status === 'RUNNING') await this.recoverStep(unfinished, owner, controller.signal);
          else await this.execute(unfinished, owner, controller.signal);
          continue;
        }
        const decision = await this.decide(runId, owner, controller.signal);
        if (decision.kind === 'complete') { this.store.moveRun(runId, 'VERIFYING', 'Model proposed completion; independent verification must decide'); continue; }
        if (decision.kind === 'question') { this.question(runId, QuestionProposalSchema.parse(decision.question)); return; }
        try {
          const action = this.propose(runId, decision);
          if (action) await this.execute(action, owner, controller.signal);
        } catch (error) {
          if (error instanceof AgentFault && ['BUDGET', 'CANCELLED', 'CONFLICT'].includes(error.category)) throw error;
          const code = error instanceof AgentFault ? error.code : 'ACTION_INVALID';
          this.store.event(runId, 'STEP_PROPOSED', { rejected: true, toolName: decision.toolName, code }); this.feedback(runId, code, 'The candidate action was rejected before an unvalidated or unauthorized side effect. Select a permitted, schema-valid alternative.');
        }
      }
    } catch (error) {
      if (error instanceof AgentFault && error.category === 'CONFLICT') return;
      if (this.store.state(runId).cancel_requested) this.cancellation(runId);
      else if (parentSignal.aborted) this.store.event(runId, 'RUNTIME_PAUSED', { reason: 'Server shutdown; persisted work will be reconciled on startup' });
      else this.final(runId, error instanceof AgentFault ? `${error.code}: ${error.message}` : 'Runtime failed safely after an unexpected internal error.');
    } finally { clearInterval(heartbeat); parentSignal.removeEventListener('abort', abort); this.store.release(runId, owner); }
  }
}
