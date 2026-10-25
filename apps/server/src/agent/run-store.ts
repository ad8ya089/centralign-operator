import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ApprovalRecordSchema, ArtifactRecordSchema, FinalResultSchema, GoalSpecificationSchema, JsonObjectSchema, PendingQuestionSchema, PlanSchema, QuestionProposalSchema, RunEventRecordSchema, RunRecordSchema, RunSnapshotSchema, RunStepRecordSchema, VerificationCheckSchema, parseStoredJson, transitionRun, transitionStep } from '@centralign/shared';
import type { EventType, FinalResult, GoalSpecification, JsonObject, Plan, QuestionProposal, RunStatus, RunStepRecord, StepStatus, VerificationCheck } from '@centralign/shared';
import { PermissionScopeSchema } from '../tools/contracts.js';
import type { PermissionScope } from '../tools/contracts.js';
import { canonicalJson, sha256 } from '../persistence/json.js';
import { AgentFault } from './contracts.js';
import type { RuntimeBudgets } from './contracts.js';

export const BudgetSchema = z.strictObject({ maxModelCalls: z.number().int().min(1).max(200), maxToolCalls: z.number().int().min(1).max(200), maxRecoveries: z.number().int().min(0).max(5), maxReplans: z.number().int().min(0).max(20), runTimeoutMs: z.number().int().min(1000).max(86400000), modelTimeoutMs: z.number().int().min(100).max(120000) });
const StateRow = z.object({ run_id: z.string(), actor_id: z.string(), granted_scopes_json: z.string(), budgets_json: z.string(), goal_json: z.string().nullable(), resolved_customer_id: z.string().nullable(), model_calls: z.number(), tool_calls: z.number(), recoveries: z.number(), replans: z.number(), deadline_at: z.string(), cancel_requested: z.number(), lease_owner: z.string().nullable(), lease_expires_at: z.string().nullable(), feedback_json: z.string().nullable(), final_result_json: z.string().nullable() });
const ActionRow = z.object({ step_id: z.string(), run_id: z.string(), tool_name: z.string(), arguments_json: z.string(), operation_hash: z.string().nullable(), idempotency_key: z.string().nullable(), approval_id: z.string().nullable(), execution_id: z.string().nullable(), blocked_reason: z.string().nullable(), expected_outcome: z.string() });
export type StoredAction = z.infer<typeof ActionRow>;

export class RunStore {
  constructor(readonly db: Database.Database, readonly clock: () => Date = () => new Date()) {}
  now(): string { return this.clock().toISOString(); }
  transaction<T>(operation: () => T): T { return this.db.transaction(operation).immediate(); }
  event(runId: string, type: EventType, payload: JsonObject, stepId: string | null = null): void {
    const record = RunEventRecordSchema.parse({ id: randomUUID(), runId, stepId, type, payload, createdAt: this.now() });
    this.db.prepare('INSERT INTO run_events(id,run_id,step_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(record.id, runId, stepId, type, JSON.stringify(record.payload), record.createdAt);
  }
  create(objective: string, actor: string, scopes: readonly PermissionScope[], budgets: RuntimeBudgets): string {
    return this.transaction(() => {
      const id = randomUUID(); const now = this.now();
      this.db.prepare("INSERT INTO runs(id,objective,status,created_at,updated_at,metadata_json,version) VALUES(?,?,'CREATED',?,?,'{}',0)").run(id, objective, now, now);
      this.db.prepare('INSERT INTO agent_runs(run_id,actor_id,granted_scopes_json,budgets_json,deadline_at) VALUES(?,?,?,?,?)').run(id, actor, JSON.stringify(scopes), JSON.stringify(BudgetSchema.parse(budgets)), new Date(this.clock().getTime() + budgets.runTimeoutMs).toISOString());
      this.event(id, 'RUN_CREATED', { objective }); return id;
    });
  }
  run(id: string) {
    const raw = this.db.prepare('SELECT id,objective,status,created_at AS createdAt,updated_at AS updatedAt,completed_at AS completedAt,metadata_json,version FROM runs WHERE id=?').get(id);
    if (!raw) throw new AgentFault('RUN_NOT_FOUND', 'Run not found.', 'VALIDATION');
    const row = z.record(z.string(), z.unknown()).parse(raw); const { metadata_json, ...record } = row;
    return RunRecordSchema.parse({ ...record, metadata: parseStoredJson(z.string().parse(metadata_json), JsonObjectSchema) });
  }
  state(id: string) {
    const row = StateRow.safeParse(this.db.prepare('SELECT * FROM agent_runs WHERE run_id=?').get(id));
    if (!row.success) throw new AgentFault('RUN_NOT_FOUND', 'Runtime run not found.', 'VALIDATION');
    return { ...row.data, budgets: parseStoredJson(row.data.budgets_json, BudgetSchema), scopes: parseStoredJson(row.data.granted_scopes_json, z.array(PermissionScopeSchema)), goal: row.data.goal_json ? parseStoredJson(row.data.goal_json, GoalSpecificationSchema) : null };
  }
  moveRun(id: string, to: RunStatus, reason: string): void {
    this.transaction(() => {
      const current = this.run(id); if (current.status === to) return;
      const next = transitionRun(current, to, this.now());
      if (this.db.prepare('UPDATE runs SET status=?,updated_at=?,completed_at=?,version=? WHERE id=? AND version=?').run(next.status, next.updatedAt, next.completedAt, next.version, id, current.version).changes !== 1) throw new AgentFault('RUN_CONFLICT', 'Concurrent run transition rejected.', 'CONFLICT');
      this.event(id, 'RUN_STATUS_CHANGED', { from: current.status, to, reason });
    });
  }
  step(id: string): RunStepRecord {
    const raw = this.db.prepare('SELECT id,run_id AS runId,step_index AS stepIndex,description,status,input_json,output_json,attempt_count AS attemptCount,created_at AS createdAt,updated_at AS updatedAt,started_at AS startedAt,completed_at AS completedAt,error_json FROM run_steps WHERE id=?').get(id);
    const row = z.record(z.string(), z.unknown()).parse(raw);
    const { input_json, output_json, error_json, ...fields } = row;
    return RunStepRecordSchema.parse({ ...fields, input: JSON.parse(z.string().parse(input_json)) as unknown, output: output_json === null ? null : JSON.parse(z.string().parse(output_json)) as unknown, error: error_json === null ? null : JSON.parse(z.string().parse(error_json)) as unknown });
  }
  steps(runId: string): RunStepRecord[] { return (this.db.prepare('SELECT id FROM run_steps WHERE run_id=? ORDER BY step_index LIMIT 200').all(runId) as { id: string }[]).map((row) => this.step(row.id)); }
  moveStep(id: string, to: StepStatus, reason: string): void {
    this.transaction(() => {
      const current = this.step(id); if (current.status === to) return;
      const next = transitionStep(current, to, this.now());
      this.db.prepare('UPDATE run_steps SET status=?,updated_at=?,started_at=?,completed_at=?,attempt_count=? WHERE id=?').run(next.status, next.updatedAt, next.startedAt, next.completedAt, next.attemptCount, id);
      this.event(next.runId, 'STEP_STATUS_CHANGED', { from: current.status, to, reason }, id);
    });
  }
  saveGoal(runId: string, goal: GoalSpecification): void {
    this.transaction(() => {
      if (this.state(runId).goal) throw new AgentFault('GOAL_IMMUTABLE', 'An existing goal cannot be replaced.', 'CONFLICT');
      this.db.prepare('UPDATE agent_runs SET goal_json=? WHERE run_id=?').run(JSON.stringify(GoalSpecificationSchema.parse(goal)), runId);
      for (const item of goal.deliverables) this.db.prepare('INSERT INTO agent_deliverables(run_id,id,specification_json) VALUES(?,?,?)').run(runId, item.id, JSON.stringify(item));
      this.event(runId, 'GOAL_UNDERSTOOD', { summary: goal.summary, deliverableIds: goal.deliverables.map((item) => item.id) });
    });
  }
  plan(runId: string): { revision: number; plan: Plan | null } {
    const row = this.db.prepare('SELECT revision,plan_json FROM agent_plan_revisions WHERE run_id=? ORDER BY revision DESC LIMIT 1').get(runId) as { revision: number; plan_json: string } | undefined;
    return row ? { revision: row.revision, plan: parseStoredJson(row.plan_json, PlanSchema) } : { revision: 0, plan: null };
  }
  savePlan(runId: string, plan: Plan): void {
    this.transaction(() => {
      const revision = this.plan(runId).revision + 1;
      this.db.prepare('INSERT INTO agent_plan_revisions(run_id,revision,plan_json,created_at) VALUES(?,?,?,?)').run(runId, revision, JSON.stringify(plan), this.now());
      this.event(runId, revision === 1 ? 'PLAN_CREATED' : 'PLAN_REVISED', { revision, summary: plan.summary });
    });
  }
  propose(runId: string, toolName: string, args: JsonObject, purpose: string, expected: string, deliverables: readonly string[], operationHash: string | null, rawArgs: JsonObject = args): StoredAction {
    return this.transaction(() => {
      const id = randomUUID(); const index = this.steps(runId).length; const now = this.now();
      this.db.prepare("INSERT INTO run_steps(id,run_id,step_index,description,status,input_json,created_at,updated_at) VALUES(?,?,?,?,'PENDING',?,?,?)").run(id, runId, index, purpose, JSON.stringify(rawArgs), now, now);
      this.db.prepare('INSERT INTO agent_steps(step_id,run_id,tool_name,arguments_json,operation_hash,idempotency_key,expected_outcome) VALUES(?,?,?,?,?,?,?)').run(id, runId, toolName, JSON.stringify(args), operationHash, operationHash ? `run:${runId}:action:${operationHash}` : null, expected);
      this.link(id, runId, deliverables);
      this.event(runId, 'STEP_PROPOSED', { toolName, purpose, expectedOutcome: expected, deliverableIds: [...deliverables] }, id);
      this.moveStep(id, 'READY', 'Validated action proposal'); return this.action(id);
    });
  }
  link(stepId: string, runId: string, deliverables: readonly string[]): void { for (const id of deliverables) this.db.prepare('INSERT OR IGNORE INTO agent_step_deliverables(run_id,step_id,deliverable_id) VALUES(?,?,?)').run(runId, stepId, id); }
  action(stepId: string): StoredAction { return ActionRow.parse(this.db.prepare('SELECT * FROM agent_steps WHERE step_id=?').get(stepId)); }
  actions(runId: string): StoredAction[] { return z.array(ActionRow).parse(this.db.prepare('SELECT a.* FROM agent_steps a JOIN run_steps s ON s.id=a.step_id WHERE a.run_id=? ORDER BY s.step_index').all(runId)); }
  findOperation(runId: string, hash: string): StoredAction | null { const row = this.db.prepare('SELECT * FROM agent_steps WHERE run_id=? AND operation_hash=?').get(runId, hash); return row ? ActionRow.parse(row) : null; }
  counter(runId: string, name: 'model_calls' | 'tool_calls' | 'recoveries' | 'replans', max: number): void {
    // Column names come only from this closed internal union, never model/user text.
    if (!this.db.prepare(`UPDATE agent_runs SET ${name}=${name}+1 WHERE run_id=? AND ${name}<?`).run(runId, max).changes) throw new AgentFault('BUDGET_EXHAUSTED', `${name} budget exhausted.`, 'BUDGET');
  }
  feedback(runId: string, feedback: JsonObject | null): void { this.db.prepare('UPDATE agent_runs SET feedback_json=? WHERE run_id=?').run(feedback === null ? null : JSON.stringify(feedback), runId); }
  check(runId: string, check: VerificationCheck, stepId: string | null = null, deliverableId: string | null = null): void {
    const value = VerificationCheckSchema.parse(check);
    this.transaction(() => {
      this.db.prepare('INSERT INTO agent_verifications(id,run_id,step_id,deliverable_id,kind,check_json,created_at) VALUES(?,?,?,?,?,?,?)').run(value.id, runId, stepId, deliverableId, stepId ? 'STEP' : 'GOAL', JSON.stringify(value), value.createdAt);
      this.event(runId, value.passed ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED', { checkId: value.id, targetId: value.targetId, explanation: value.explanation, evidenceIds: value.evidence.map((item) => item.id) }, stepId);
    });
  }
  question(runId: string, proposal: QuestionProposal): string {
    return this.transaction(() => {
      const parsed = QuestionProposalSchema.parse(proposal); const fingerprint = sha256(canonicalJson(parsed));
      const prior = this.db.prepare('SELECT id,status FROM agent_questions WHERE run_id=? AND fingerprint=?').get(runId, fingerprint) as { id: string; status: string } | undefined;
      if (prior?.status === 'ANSWERED') throw new AgentFault('QUESTION_ALREADY_ANSWERED', 'That clarification has already been answered.', 'VALIDATION');
      const id = prior?.id ?? randomUUID();
      if (!prior) this.db.prepare("INSERT INTO agent_questions(id,run_id,fingerprint,proposal_json,status,created_at) VALUES(?,?,?,?,'PENDING',?)").run(id, runId, fingerprint, JSON.stringify(parsed), this.now());
      this.moveRun(runId, 'WAITING_INPUT', parsed.reason);
      this.event(runId, 'CLARIFICATION_REQUESTED', { questionId: id, text: parsed.text, reason: parsed.reason });
      this.event(runId, 'RUNTIME_PAUSED', { reason: 'WAITING_INPUT', questionId: id }); return id;
    });
  }
  questions(runId: string, pendingOnly = false) {
    const rows = this.db.prepare(`SELECT * FROM agent_questions WHERE run_id=? ${pendingOnly ? "AND status='PENDING'" : ''} ORDER BY rowid DESC LIMIT ${pendingOnly ? 10 : 20}`).all(runId);
    return rows.map((raw) => { const row = z.object({ id: z.string(), proposal_json: z.string(), status: z.string(), answer: z.string().nullable(), choice_id: z.string().nullable(), created_at: z.string(), answered_at: z.string().nullable() }).parse(raw); return PendingQuestionSchema.parse({ ...parseStoredJson(row.proposal_json, QuestionProposalSchema), id: row.id, runId, status: row.status, answer: row.answer, choiceId: row.choice_id, createdAt: row.created_at, answeredAt: row.answered_at }); });
  }
  approvals(runId: string, pendingOnly = false) {
    return this.db.prepare(`SELECT id,run_id AS runId,step_id AS stepId,action_json,policy_reason AS policyReason,status,requested_at AS requestedAt,expires_at AS expiresAt,decided_at AS decidedAt,decision_maker AS decisionMaker,decision_note AS decisionNote FROM approvals WHERE run_id=? ${pendingOnly ? "AND status='PENDING'" : ''} ORDER BY requested_at,id LIMIT ${pendingOnly ? 10 : 200}`).all(runId).map((raw) => {
      const row = z.record(z.string(), z.unknown()).parse(raw); const { action_json, ...fields } = row;
      return ApprovalRecordSchema.parse({ ...fields, action: parseStoredJson(z.string().parse(action_json), JsonObjectSchema) });
    });
  }
  lease(runId: string, owner: string, duration: number): boolean {
    const now = this.now();
    return this.db.prepare('UPDATE agent_runs SET lease_owner=?,lease_expires_at=? WHERE run_id=? AND (lease_owner IS NULL OR lease_expires_at<=?)').run(owner, new Date(this.clock().getTime() + duration).toISOString(), runId, now).changes === 1;
  }
  assertLease(runId: string, owner: string): void { const state = this.state(runId); if (state.lease_owner !== owner || !state.lease_expires_at || Date.parse(state.lease_expires_at) <= this.clock().getTime()) throw new AgentFault('LEASE_LOST', 'Runtime ownership was lost.', 'CONFLICT'); }
  heartbeat(runId: string, owner: string, duration: number): boolean { return this.db.prepare('UPDATE agent_runs SET lease_expires_at=? WHERE run_id=? AND lease_owner=? AND lease_expires_at>?').run(new Date(this.clock().getTime() + duration).toISOString(), runId, owner, this.now()).changes === 1; }
  release(runId: string, owner: string): void { this.db.prepare('UPDATE agent_runs SET lease_owner=NULL,lease_expires_at=NULL WHERE run_id=? AND lease_owner=?').run(runId, owner); }
  snapshot(runId: string) {
    const state = this.state(runId); const plan = this.plan(runId); const steps = this.steps(runId);
    const checks = (this.db.prepare('SELECT check_json FROM agent_verifications WHERE run_id=? ORDER BY rowid DESC LIMIT 200').all(runId) as { check_json: string }[]).map((row) => parseStoredJson(row.check_json, VerificationCheckSchema));
    const artifacts = this.db.prepare('SELECT id,run_id AS runId,step_id AS stepId,name,path,mime_type AS mimeType,content_hash AS contentHash,metadata_json,created_at AS createdAt FROM artifacts WHERE run_id=? LIMIT 100').all(runId).map((raw) => { const row = z.record(z.string(), z.unknown()).parse(raw); const { metadata_json, ...fields } = row; return ArtifactRecordSchema.parse({ ...fields, metadata: parseStoredJson(z.string().parse(metadata_json), JsonObjectSchema) }); });
    const actions = this.actions(runId).map((action) => ({ stepId: action.step_id, toolName: action.tool_name, deliverableIds: (this.db.prepare('SELECT deliverable_id FROM agent_step_deliverables WHERE step_id=?').all(action.step_id) as { deliverable_id: string }[]).map((item) => item.deliverable_id), expectedOutcome: action.expected_outcome, executionId: action.execution_id, approvalId: action.approval_id, blockedReason: action.blocked_reason }));
    const milestones = (plan.plan?.milestones ?? []).map((milestone) => {
      const related = actions.filter((action) => action.deliverableIds.some((id) => milestone.deliverableIds.includes(id))).map((action) => this.step(action.stepId));
      const passed = milestone.deliverableIds.every((id) => checks.find((check) => check.targetId === id)?.passed === true);
      return { id: milestone.id, deliverableIds: milestone.deliverableIds, status: passed ? 'VERIFIED' : related.some((step) => step.status === 'WAITING_APPROVAL') ? 'WAITING_APPROVAL' : related.some((step) => step.status === 'BLOCKED') ? 'BLOCKED' : related.length ? 'IN_PROGRESS' : 'PENDING' };
    });
    const publicFields = (value: JsonObject): JsonObject => Object.fromEntries(Object.entries(value).filter(([key, entry]) => ['id', 'customerId', 'projectId', 'draftId', 'approvalId', 'name', 'title', 'filename', 'query', 'recipient', 'subject', 'mimeType', 'status', 'path', 'contentHash', 'sessionId', 'url'].includes(key) && (typeof entry === 'string' || typeof entry === 'number' || entry === null)));
    return RunSnapshotSchema.parse({ run: this.run(runId), goal: state.goal, plan: plan.plan, planRevision: plan.revision, resolvedCustomerId: state.resolved_customer_id, cancelRequested: Boolean(state.cancel_requested), actions, milestones,
      steps: steps.map((step) => ({ ...step, input: publicFields(step.input), output: step.output === null ? null : { stored: true }, error: step.error })),
      currentStepId: steps.find((step) => !['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(step.status))?.id ?? null,
      pendingQuestions: this.questions(runId, true), pendingApprovals: this.approvals(runId, true), verification: checks,
      finalResult: state.final_result_json ? parseStoredJson(state.final_result_json, FinalResultSchema) : null, artifacts,
      budgets: { modelCalls: state.model_calls, toolCalls: state.tool_calls, recoveries: state.recoveries, replans: state.replans, deadlineAt: state.deadline_at } });
  }
  final(runId: string, result: FinalResult): void { this.db.prepare('UPDATE agent_runs SET final_result_json=? WHERE run_id=?').run(JSON.stringify(FinalResultSchema.parse(result)), runId); }
}
