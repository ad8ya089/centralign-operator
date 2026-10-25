import { expect, it, vi } from 'vitest';
import { GoalSpecificationSchema, PlanSchema } from '@centralign/shared';
import { FakeModelProvider } from '../src/agent/fake-model-provider.js';
import { AgentFault } from '../src/agent/contracts.js';
import type { ToolExecutionPort } from '../src/agent/contracts.js';
import { createToolLayer } from '../src/tools/layer.js';
import { completionDecision, createOnboardingTestModel, ONBOARDING_OBJECTIVE, onboardingResponse, toolDecision } from '../src/agent/testing/onboarding-model.js';
import { agentFixture } from './agent-helpers.js';

const goal = GoalSpecificationSchema.parse({ summary: 'Resolve the requested customer', intent: 'GENERAL', entities: [{ name: 'Acme Logistics', type: 'customer', unresolved: true }], deliverables: [{ id: 'customer', description: 'Find the customer', category: 'CUSTOMER', minCount: 1, sourceRequired: false }], constraints: [], questions: [] });
const plan = PlanSchema.parse({ summary: 'Resolve account', milestones: [{ id: 'resolve', description: 'Find account', deliverableIds: ['customer'], prerequisites: [] }], blocked: [] });
const search = { decision: toolDecision('search_customers', { query: 'Acme Logistics' }, ['customer']) };
const complete = { decision: completionDecision };
async function run(script: ConstructorParameters<typeof FakeModelProvider>[0], environment: Record<string, string> = {}) {
  const provider = new FakeModelProvider(script); const f = agentFixture({ provider }, environment);
  const id = f.service.create({ objective: 'Find Acme Logistics customer' }).id; await f.service.waitForIdle(id);
  return { ...f, provider, id, snapshot: () => f.service.snapshot(id) };
}

it('repairs malformed structured output once and preserves the original request', async () => {
  const f = await run([{ invalid: true }, goal, plan, search, complete]);
  try { expect(f.snapshot().run.status).toBe('COMPLETED'); expect(f.provider.requests[1]?.repair).toBe(true); expect(f.snapshot().budgets.recoveries).toBe(1); }
  finally { await f.close(); }
});
it('fails after the one allowed schema repair without creating tool effects', async () => {
  const f = await run([{}, {}, goal]);
  try { expect(f.snapshot().run.status).toBe('FAILED'); expect(f.provider.requests).toHaveLength(2); expect(f.snapshot().steps).toEqual([]); }
  finally { await f.close(); }
});
it('repairs a plan that omits a required deliverable', async () => {
  const f = await run([goal, { ...plan, milestones: [{ ...plan.milestones[0], deliverableIds: ['invented'] }] }, plan, search, complete]);
  try { expect(f.snapshot().run.status).toBe('COMPLETED'); expect(f.provider.requests[2]?.repair).toBe(true); }
  finally { await f.close(); }
});
it('never accepts a model completion assertion without independent required evidence', async () => {
  const f = await run([goal, plan, complete], { AGENT_MAX_REPLANS: '0' });
  try { expect(f.snapshot().run.status).toBe('FAILED'); expect(f.snapshot().finalResult?.outstanding[0]?.deliverableId).toBe('customer'); }
  finally { await f.close(); }
});
it('rejects unknown tools, invented trust fields, and scope escalation before execution', async () => {
  const f = await run([goal, plan,
    { decision: toolDecision('arbitrary_http', { url: 'https://example.com' }) },
    { decision: toolDecision('search_customers', { query: 'Acme Logistics', grantedScopes: ['email:send'] }, ['customer']) },
    { decision: toolDecision('create_project', { customerId: 'invented', name: 'Injected' }, ['customer']) },
    search, complete]);
  try { expect(f.snapshot().run.status).toBe('COMPLETED'); expect(f.snapshot().steps).toHaveLength(1); expect(f.db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 0 }); }
  finally { await f.close(); }
});
it.each([['AGENT_MAX_MODEL_CALLS', '2', 2], ['AGENT_MAX_TOOL_CALLS', '1', 4]] as const)('enforces persisted %s', async (key, value, calls) => {
  const f = await run([goal, plan, search, search, complete], { [key]: value });
  try { expect(f.snapshot().run.status).not.toBe('COMPLETED'); expect(f.snapshot().budgets.modelCalls).toBe(calls); }
  finally { await f.close(); }
});
it('bounds model rate-limit retries and records their classification', async () => {
  const fault = () => new AgentFault('MODEL_TEMPORARY_FAILURE', 'Rate limited', 'TRANSIENT');
  const f = await run([fault(), fault(), fault(), goal]);
  try { expect(f.snapshot().run.status).toBe('FAILED'); expect(f.provider.requests).toHaveLength(3); expect(f.snapshot().budgets.recoveries).toBe(2); }
  finally { await f.close(); }
});
it('times out a provider that ignores cancellation and bounds retries', async () => {
  const f = await run([() => new Promise(() => {}), () => new Promise(() => {}), () => new Promise(() => {})], { OPENAI_TIMEOUT_MS: '100' });
  try { expect(f.snapshot().run.status).toBe('FAILED'); expect(f.snapshot().budgets.modelCalls).toBe(3); }
  finally { await f.close(); }
});
it('aborts an active model request on persisted cancellation', async () => {
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
  const provider = new FakeModelProvider([() => { started(); return new Promise(() => {}); }]); const f = agentFixture({ provider });
  try { const id = f.service.create({ objective: 'Find Acme Logistics customer' }).id; await ready; f.service.cancel(id); await f.service.waitForIdle(id); expect(f.service.snapshot(id).run.status).toBe('CANCELLED'); expect(f.service.snapshot(id).cancelRequested).toBe(true); expect(provider.requests[0]?.signal.aborted).toBe(true); }
  finally { await f.close(); }
});
it('preserves safe single-flight ownership and rejects a stale durable lease', async () => {
  let started!: () => void; let release!: (value: unknown) => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const provider = new FakeModelProvider([() => { started(); return new Promise((resolve) => { release = resolve; }); }]); const f = agentFixture({ provider });
  try {
    const id = f.service.create({ objective: 'Find Acme Logistics customer' }).id; await ready;
    f.service.kick(id); f.service.kick(id); expect(f.service.store.lease(id, 'second-owner', 60000)).toBe(false);
    f.db.prepare("UPDATE agent_runs SET lease_owner='replacement',lease_expires_at=? WHERE run_id=?").run(new Date(Date.now() + 60000).toISOString(), id);
    release(goal); await f.service.waitForIdle(id); expect(provider.requests).toHaveLength(1); expect(f.service.snapshot(id).goal).toBeNull();
  } finally { await f.close(); }
});
it('reconciles an actual committed write whose response was lost, with no duplicate project', async () => {
  let actual: ReturnType<typeof createToolLayer>; let lost = false;
  const executor: ToolExecutionPort = { execute: async (name, args, context) => { const result = await actual.executor.execute(name, args, context); if (name === 'create_project' && result.ok && !lost) { lost = true; throw new Error('Response lost after commit'); } return result; } };
  const f = agentFixture({ provider: createOnboardingTestModel(), executor }); actual = createToolLayer(f.db, f.config);
  try { const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id); expect(f.service.snapshot(id).run.status).toBe('WAITING_APPROVAL'); expect(lost).toBe(true); expect(f.db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 }); expect(f.service.store.steps(id).find((step) => step.description && step.output && JSON.stringify(step.output).includes('project-exec-'))?.status).toBe('SUCCEEDED'); }
  finally { await actual.close(); await f.close(); }
});
it('suppresses a repeated logical write even when the model proposes a new action', async () => {
  let projectArgs: unknown; let repeated = false;
  const provider = new FakeModelProvider(Array.from({ length: 50 }, () => (request: Parameters<typeof onboardingResponse>[0]) => {
    const value = onboardingResponse(request) as { decision?: { toolName?: string; argumentsJson?: string } };
    if (request.phase === 'act' && value.decision?.toolName === 'create_project') projectArgs = JSON.parse(value.decision.argumentsJson!);
    else if (request.phase === 'act' && value.decision?.toolName === 'create_task' && !repeated) { repeated = true; return { decision: toolDecision('create_project', projectArgs, ['project']) }; }
    return value;
  })); const f = agentFixture({ provider });
  try { const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id); expect(f.service.snapshot(id).run.status).toBe('WAITING_APPROVAL'); expect(f.db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 }); expect(f.service.events(id, 0, 100).events.some((event) => event.type === 'DUPLICATE_ACTION')).toBe(true); }
  finally { await f.close(); }
});
it.each(['TRANSIENT', 'PERMISSION', 'VALIDATION'] as const)('only retries a classified safe read (%s)', async (category) => {
  let actual: ReturnType<typeof createToolLayer>; let calls = 0;
  const executor: ToolExecutionPort = { execute: async (name, args, context) => { calls++; if (calls === 1 || category !== 'TRANSIENT') return { ok: false, executionId: null, error: { category, code: 'TEST_FAILURE', message: 'Injected failure', retryability: category === 'TRANSIENT' ? 'SAFE_READ' : 'NEVER' } }; return actual.executor.execute(name, args, context); } };
  const f = agentFixture({ provider: new FakeModelProvider([goal, plan, search, complete]), executor }, { AGENT_MAX_REPLANS: '0' }); actual = createToolLayer(f.db, f.config);
  try { const id = f.service.create({ objective: 'Find Acme Logistics customer' }).id; await f.service.waitForIdle(id); expect(calls).toBe(category === 'TRANSIENT' ? 2 : 1); expect(f.service.snapshot(id).run.status).toBe(category === 'TRANSIENT' ? 'COMPLETED' : 'FAILED'); const failures = f.service.events(id, 0, 100).events.filter((event) => event.type === 'TOOL_EXECUTION_FAILED'); expect(failures).toHaveLength(1); expect(failures[0]!.payload['error']).toMatchObject({ code: 'TEST_FAILURE', category }); }
  finally { await actual.close(); await f.close(); }
});
it('stops when the overall deadline expires', async () => {
  let now = Date.now(); const provider = new FakeModelProvider([() => { now += 2000; return goal; }]); const f = agentFixture({ provider, clock: () => new Date(now) }, { AGENT_RUN_TIMEOUT_MS: '1000' });
  try { const id = f.service.create({ objective: 'Find Acme Logistics customer' }).id; await f.service.waitForIdle(id); expect(f.service.snapshot(id).run.status).toBe('FAILED'); expect(f.service.snapshot(id).finalResult?.summary).toContain('RUN_DEADLINE'); }
  finally { await f.close(); }
});
it('contains unexpected provider errors without leaking their text', async () => {
  const f = await run([new Error('private transport details')]);
  try { expect(JSON.stringify(f.snapshot())).not.toContain('private transport details'); expect(f.snapshot().run.status).toBe('FAILED'); }
  finally { await f.close(); }
});
it('keeps cancellation pending for an unknown write and requires authoritative reconciliation', async () => {
  let actual: ReturnType<typeof createToolLayer>; let committedResult: unknown; let key: string | null = null; let projectCalls = 0;
  const executor: ToolExecutionPort = { execute: async (name, args, context) => {
    const result = await actual.executor.execute(name, args, context);
    if (name === 'create_project' && result.ok) {
      projectCalls++; key = context.idempotencyKey; committedResult = { data: result.data, evidence: result.evidence };
      f.db.prepare("UPDATE tool_executions SET status='UNKNOWN_OUTCOME',result_json=NULL WHERE id=?").run(result.executionId);
      return { ok: false, executionId: result.executionId, error: { category: 'UNKNOWN_OUTCOME', code: 'INJECTED_UNCERTAINTY', message: 'Outcome requires authoritative reconciliation', retryability: 'RECONCILE' } };
    }
    return result;
  } };
  const f = agentFixture({ provider: createOnboardingTestModel(), executor }); actual = createToolLayer(f.db, f.config);
  try {
    const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id); expect(f.service.snapshot(id).run.status).toBe('WAITING_INPUT');
    f.service.cancel(id); await f.service.waitForIdle(id); expect(f.service.snapshot(id).run.status).toBe('WAITING_INPUT'); expect(projectCalls).toBe(1);
    const question = f.service.snapshot(id).pendingQuestions[0]!;
    expect(() => f.service.input(id, { questionId: question.id, answer: 'It succeeded' })).toThrow('Authoritative');
    f.db.prepare("UPDATE tool_executions SET status='SUCCEEDED',result_json=? WHERE idempotency_key=?").run(JSON.stringify(committedResult), key);
    f.service.input(id, { questionId: question.id, answer: 'Authoritative ledger has been reconciled' }); await f.service.waitForIdle(id);
    expect(f.service.snapshot(id).run.status).toBe('CANCELLED'); expect(f.service.snapshot(id).finalResult?.verified.some((item) => item.deliverableId === 'project')).toBe(true); expect(projectCalls).toBe(1);
  } finally { await actual.close(); await f.close(); }
});

it('rechecks a renewed lease at its wake time and recovers after the final expiration', async () => {
  let now = Date.now(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const model = new FakeModelProvider([goal, plan, search, complete]); const f = agentFixture({ provider: model, clock: () => new Date(now) });
  try {
    const id = f.service.store.create('Find Acme Logistics customer', 'local-operator', permissionsForTest(), f.service.budgets);
    expect(f.service.store.lease(id, 'other-worker', 100)).toBe(true); await f.service.recover();
    f.db.prepare('UPDATE agent_runs SET lease_expires_at=? WHERE run_id=?').run(new Date(now + 250).toISOString(), id);
    now += 111; await vi.advanceTimersByTimeAsync(111); expect(model.requests).toHaveLength(0);
    now += 150; await vi.advanceTimersByTimeAsync(150); await f.service.waitForIdle(id);
    expect(f.service.snapshot(id).run.status).toBe('COMPLETED'); expect(model.requests).toHaveLength(4);
  } finally { await f.close(); vi.useRealTimers(); }
});
function permissionsForTest(): ('knowledge:read' | 'customers:read')[] { return ['knowledge:read', 'customers:read']; }

it.each(['read', 'committed-write'] as const)('cancels during %s and reports actual committed effects', async (point) => {
  let actual: ReturnType<typeof createToolLayer>; let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; }); let writes = 0;
  const executor: ToolExecutionPort = { execute: async (name, args, context) => {
    if (point === 'read' && name === 'search_company_knowledge') { started(); await new Promise<void>((resolve) => context.signal!.addEventListener('abort', () => resolve(), { once: true })); return { ok: false, executionId: null, error: { code: 'CANCELLED', category: 'TRANSIENT', retryability: 'SAFE_READ', message: 'Read cancelled' } }; }
    const value = await actual.executor.execute(name, args, context);
    if (name === 'create_project' && value.ok) { writes++; if (point === 'committed-write') f.service.cancel(context.runId); }
    return value;
  } };
  const model = createOnboardingTestModel(); const f = agentFixture({ provider: model, executor }); actual = createToolLayer(f.db, f.config);
  try {
    const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id;
    if (point === 'read') { await ready; f.service.cancel(id); }
    await f.service.waitForIdle(id); const snapshot = f.service.snapshot(id);
    expect(snapshot.run.status).toBe('CANCELLED'); expect(writes).toBe(point === 'read' ? 0 : 1);
    expect(f.db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: writes });
    expect(f.db.prepare('SELECT count(*) AS n FROM sandbox_outbox').get()).toEqual({ n: 0 });
    if (point === 'committed-write') expect(snapshot.finalResult?.verified.some((item) => item.deliverableId === 'project')).toBe(true);
  } finally { await actual.close(); await f.close(); }
});
