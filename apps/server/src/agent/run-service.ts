import { z } from 'zod';
import type Database from 'better-sqlite3';
import { ApprovalDecisionRequestSchema, CreateRunRequestSchema, FinalResultSchema, GoalSpecificationSchema, JsonObjectSchema, RunEventRecordSchema, RunEventsPageSchema, RunListPageSchema, SubmitInputSchema, UtcTimestampSchema, parseStoredJson } from '@centralign/shared';
import type { AppConfig } from '../config/env.js';
import { createToolLayer } from '../tools/layer.js';
import type { ModelProvider, RuntimeBudgets, ToolExecutionPort } from './contracts.js';
import { AgentFault } from './contracts.js';
import { OpenAIModelProvider } from './openai-provider.js';
import { permissionsForObjective, rejectSecrets } from './security.js';
import { RunStore } from './run-store.js';
import { AgentRuntime } from './runtime.js';
import { BusinessStore } from '../tools/business-store.js';

export interface RunServiceOptions { provider?: ModelProvider; executor?: ToolExecutionPort; clock?: () => Date; actorId?: string; decisionMaker?: string }
export class RunService {
  readonly store: RunStore;
  readonly runtime: AgentRuntime;
  readonly provider: ModelProvider;
  private readonly layer: ReturnType<typeof createToolLayer>;
  private readonly jobs = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private readonly wakes = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reruns = new Set<string>();
  private closed = false;
  private readonly actorId: string;
  private readonly decisionMaker: string;
  readonly budgets: RuntimeBudgets;
  constructor(db: Database.Database, private readonly config: AppConfig, options: RunServiceOptions = {}) {
    this.store = new RunStore(db, options.clock);
    this.layer = createToolLayer(db, config);
    this.provider = options.provider ?? new OpenAIModelProvider({ ...(config.OPENAI_API_KEY ? { apiKey: config.OPENAI_API_KEY } : {}), model: config.OPENAI_MODEL, timeoutMs: config.OPENAI_TIMEOUT_MS });
    this.runtime = new AgentRuntime(this.store, this.layer.registry, options.executor ?? this.layer.executor, this.provider, config.ARTIFACT_WORKSPACE_PATH, config.OPENAI_API_KEY);
    this.actorId = options.actorId ?? 'local-operator'; this.decisionMaker = options.decisionMaker ?? 'local-user';
    this.budgets = { maxModelCalls: config.AGENT_MAX_MODEL_CALLS, maxToolCalls: config.AGENT_MAX_TOOL_CALLS, maxRecoveries: config.AGENT_MAX_RECOVERY_ATTEMPTS, maxReplans: config.AGENT_MAX_REPLANS, runTimeoutMs: config.AGENT_RUN_TIMEOUT_MS, modelTimeoutMs: config.OPENAI_TIMEOUT_MS };
  }
  private configured(): void { if (!this.provider.configured) throw new AgentFault('MODEL_UNCONFIGURED', 'Live execution is unavailable. Configure OPENAI_API_KEY in the server environment.', 'CONFIGURATION'); }
  create(raw: unknown): { id: string; status: 'CREATED' } {
    const input = CreateRunRequestSchema.parse(raw); this.configured(); rejectSecrets(input.objective, this.config.OPENAI_API_KEY);
    if (this.closed) throw new AgentFault('SERVICE_STOPPED', 'Runtime is shutting down.', 'CONFLICT');
    const id = this.store.create(input.objective, this.actorId, permissionsForObjective(input.objective), this.budgets);
    this.kick(id); return { id, status: 'CREATED' };
  }
  snapshot(runId: string) { return this.store.snapshot(runId); }
  list(cursor: string | null, limit: number) {
    z.number().int().min(1).max(50).parse(limit);
    let before: { createdAt: string; id: string } | null = null;
    if (cursor) {
      try { before = z.strictObject({ createdAt: UtcTimestampSchema, id: z.string().min(1).max(200) }).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown); }
      catch { throw new AgentFault('INVALID_CURSOR', 'The recent-runs cursor is invalid.', 'VALIDATION'); }
    }
    const rows = this.store.db.prepare(`SELECT r.id,a.goal_json,a.final_result_json FROM runs r JOIN agent_runs a ON a.run_id=r.id ${before ? 'WHERE r.created_at < ? OR (r.created_at = ? AND r.id < ?)' : ''} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).all(...(before ? [before.createdAt, before.createdAt, before.id, limit + 1] : [limit + 1])) as { id: string; goal_json: string | null; final_result_json: string | null }[];
    const page = rows.slice(0, limit).map((row) => {
      const run = this.store.run(row.id); const final = row.final_result_json ? parseStoredJson(row.final_result_json, FinalResultSchema) : null;
      const goal = row.goal_json ? parseStoredJson(row.goal_json, GoalSpecificationSchema) : null;
      return { id: run.id, objective: run.objective, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, summary: final?.summary ?? goal?.summary ?? null, verifiedCount: final?.verified.length ?? 0, requiredCount: goal?.deliverables.length ?? 0, blocker: final?.outstanding[0]?.reason ?? (this.store.questions(row.id, true)[0]?.reason ?? null) };
    });
    const last = page.at(-1);
    return RunListPageSchema.parse({ runs: page, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url') : null });
  }
  events(runId: string, after = 0, limit = 50) {
    this.store.state(runId);
    z.number().int().min(0).parse(after); z.number().int().min(1).max(100).parse(limit);
    const rows = this.store.db.prepare('SELECT sequence,id,run_id,step_id,event_type,payload_json,created_at FROM run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(runId, after, limit + 1) as { sequence: number; id: string; run_id: string; step_id: string | null; event_type: string; payload_json: string; created_at: string }[];
    const page = rows.slice(0, limit);
    return RunEventsPageSchema.parse({ events: page.map((row) => RunEventRecordSchema.parse({ id: row.id, runId: row.run_id, stepId: row.step_id, type: row.event_type, payload: parseStoredJson(row.payload_json, JsonObjectSchema), createdAt: row.created_at })), cursor: page.at(-1)?.sequence ?? after, nextCursor: rows.length > limit ? page.at(-1)!.sequence : null });
  }
  resume(runId: string): void {
    this.configured(); const run = this.store.run(runId);
    if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(run.status)) throw new AgentFault('RUN_TERMINAL', 'Terminal runs cannot be resumed.', 'CONFLICT');
    if (this.store.questions(runId, true).length || this.store.approvals(runId, true).length) throw new AgentFault('HUMAN_DECISION_REQUIRED', 'Resolve the pending question or approval first.', 'CONFLICT');
    if (run.status === 'WAITING_INPUT' || run.status === 'WAITING_APPROVAL') this.store.moveRun(runId, this.store.plan(runId).plan ? 'RUNNING' : 'UNDERSTANDING', 'Persisted human response permits controlled resumption');
    this.kick(runId);
  }
  input(runId: string, raw: unknown) {
    this.configured(); const input = SubmitInputSchema.parse(raw); rejectSecrets(input.answer, this.config.OPENAI_API_KEY);
    this.store.transaction(() => {
      if (this.store.run(runId).status !== 'WAITING_INPUT') throw new AgentFault('INPUT_STATE_CONFLICT', 'Run is not waiting for this input.', 'CONFLICT');
      const question = this.store.questions(runId, true).find((item) => item.id === input.questionId);
      if (!question) throw new AgentFault('QUESTION_NOT_PENDING', 'The question is missing, stale, or belongs to another run.', 'CONFLICT');
      if (question.topic === 'CUSTOMER_IDENTITY') {
        if (!input.choiceId || question.choices.length > 0 && !question.choices.some((choice) => choice.id === input.choiceId)) throw new AgentFault('INVALID_CUSTOMER_CHOICE', 'Select an existing candidate customer explicitly.', 'VALIDATION');
        new BusinessStore(this.store.db).customer(input.choiceId);
        this.store.db.prepare('UPDATE agent_runs SET resolved_customer_id=? WHERE run_id=?').run(input.choiceId, runId);
      }
      if (question.topic === 'RECONCILIATION') {
        const unresolved = this.store.actions(runId).filter((action) => action.blocked_reason === 'UNKNOWN_OUTCOME');
        if (unresolved.some((action) => !this.store.db.prepare("SELECT 1 FROM tool_executions WHERE idempotency_key=? AND status IN ('SUCCEEDED','FAILED','CANCELLED')").get(action.idempotency_key))) throw new AgentFault('OUTCOME_UNRESOLVED', 'Authoritative execution reconciliation is still required; a free-text answer cannot establish success.', 'CONFLICT');
        for (const action of unresolved) {
          const ledger = this.store.db.prepare('SELECT status FROM tool_executions WHERE idempotency_key=?').get(action.idempotency_key) as { status: string };
          this.store.moveStep(action.step_id, ledger.status === 'SUCCEEDED' ? 'READY' : 'FAILED', 'Authoritative ledger reconciliation is available');
          this.store.db.prepare('UPDATE agent_steps SET blocked_reason=NULL WHERE step_id=?').run(action.step_id);
        }
      }
      this.store.db.prepare("UPDATE agent_questions SET status='ANSWERED',answer=?,choice_id=?,answered_at=?,answered_by=? WHERE id=? AND status='PENDING'").run(input.answer, input.choiceId, this.store.now(), this.decisionMaker, question.id);
      this.store.event(runId, 'CLARIFICATION_ANSWERED', { questionId: question.id, answeredBy: this.decisionMaker });
      this.store.moveRun(runId, this.store.plan(runId).plan ? 'RUNNING' : 'UNDERSTANDING', 'Clarification persisted');
    });
    this.kick(runId); return { accepted: true };
  }
  decision(runId: string, approvalId: string, raw: unknown): { accepted: true; repeated: boolean } {
    const input = ApprovalDecisionRequestSchema.parse(raw); rejectSecrets(input.note ?? '', this.config.OPENAI_API_KEY);
    let repeated = false;
    this.store.transaction(() => {
      this.store.state(runId);
      const approval = this.store.approvals(runId).find((item) => item.id === approvalId);
      if (!approval) throw new AgentFault('APPROVAL_NOT_FOUND', 'Approval not found for this run.', 'VALIDATION');
      if (approval.status !== 'PENDING') {
        if (approval.status === input.decision && approval.decisionNote === input.note && approval.decisionMaker === this.decisionMaker) { repeated = true; return; }
        throw new AgentFault('APPROVAL_CONFLICT', 'A resolved approval cannot be changed.', 'CONFLICT');
      }
      this.configured();
      if (this.store.run(runId).status !== 'WAITING_APPROVAL' || !approval.stepId || this.store.step(approval.stepId).status !== 'WAITING_APPROVAL') throw new AgentFault('APPROVAL_STATE_CONFLICT', 'Approval is not associated with the pending action.', 'CONFLICT');
      if (approval.expiresAt && Date.parse(approval.expiresAt) <= this.store.clock().getTime()) throw new AgentFault('APPROVAL_EXPIRED', 'Approval has expired.', 'CONFLICT');
      this.store.db.prepare("UPDATE approvals SET status=?,decided_at=?,decision_maker=?,decision_note=? WHERE id=? AND status='PENDING'").run(input.decision, this.store.now(), this.decisionMaker, input.note, approvalId);
      this.store.event(runId, 'APPROVAL_DECIDED', { approvalId, decision: input.decision, decisionMaker: this.decisionMaker }, approval.stepId);
      this.store.moveRun(runId, 'RUNNING', 'Human decision persisted; runtime will revalidate the exact action');
    });
    if (!repeated) this.kick(runId);
    return { accepted: true, repeated };
  }
  cancel(runId: string) {
    this.store.transaction(() => {
      const run = this.store.run(runId); this.store.state(runId);
      if (run.status === 'CANCELLED') return;
      if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(run.status)) throw new AgentFault('RUN_TERMINAL', 'Completed terminal runs cannot be cancelled.', 'CONFLICT');
      if (!this.store.state(runId).cancel_requested) { this.store.db.prepare('UPDATE agent_runs SET cancel_requested=1 WHERE run_id=?').run(runId); this.store.event(runId, 'RUN_CANCEL_REQUESTED', { requestedBy: this.decisionMaker }); }
    });
    this.jobs.get(runId)?.controller.abort(); this.kick(runId); return { accepted: true };
  }
  kick(runId: string): void {
    if (this.closed) return;
    if (this.jobs.has(runId)) { this.reruns.add(runId); return; }
    const controller = new AbortController();
    // Defer until the accepted HTTP response and durable write transaction have returned.
    const task = Promise.resolve().then(() => this.runtime.process(runId, controller.signal)).catch(() => {
      try { this.store.event(runId, 'RUNTIME_PAUSED', { reason: 'Background error was contained; lease expiry permits startup recovery.' }); } catch { /* The durable lease remains the recovery boundary if SQLite is unavailable. */ }
    }).finally(() => {
      this.jobs.delete(runId);
      if (this.reruns.delete(runId)) this.kick(runId);
    });
    this.jobs.set(runId, { controller, task });
  }
  async waitForIdle(runId: string): Promise<void> { while (this.jobs.has(runId)) await this.jobs.get(runId)!.task; }
  async recover(): Promise<void> {
    const rows = this.store.db.prepare("SELECT r.id,a.lease_expires_at,a.cancel_requested,r.status FROM runs r JOIN agent_runs a ON a.run_id=r.id WHERE r.status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED')").all() as { id: string; lease_expires_at: string | null; cancel_requested: number; status: string }[];
    for (const row of rows) {
      if (['WAITING_INPUT', 'WAITING_APPROVAL'].includes(row.status) && !row.cancel_requested) continue;
      const delay = row.lease_expires_at ? Date.parse(row.lease_expires_at) - this.store.clock().getTime() : 0;
      if (delay > 0) {
        if (!this.wakes.has(row.id)) { const timer = setTimeout(() => { this.wakes.delete(row.id); this.kick(row.id); }, Math.min(delay + 10, 250000)); timer.unref(); this.wakes.set(row.id, timer); }
      } else this.kick(row.id);
    }
  }
  async close(): Promise<void> {
    this.closed = true; for (const timer of this.wakes.values()) clearTimeout(timer); this.wakes.clear();
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.values()].map((job) => job.task)); await this.layer.close();
  }
}
