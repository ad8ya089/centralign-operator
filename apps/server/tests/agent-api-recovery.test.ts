import { expect, it } from 'vitest';
import { GoalSpecificationSchema, JsonObjectSchema, PlanSchema, RunSnapshotSchema } from '@centralign/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/persistence/database.js';
import { RunService } from '../src/agent/run-service.js';
import { FakeModelProvider } from '../src/agent/fake-model-provider.js';
import { createOnboardingTestModel, ONBOARDING_OBJECTIVE, completionDecision, toolDecision } from '../src/agent/testing/onboarding-model.js';
import { createToolLayer } from '../src/tools/layer.js';
import { permissionsForObjective } from '../src/agent/security.js';
import { agentFixture } from './agent-helpers.js';

it('starts without credentials and rejects live submission without creating a run', async () => {
  const f = agentFixture();
  try { expect((await f.app.inject('/api/v1/health')).statusCode).toBe(200); const reply = await f.app.inject({ method: 'POST', url: '/api/v1/runs', payload: { objective: 'Find a customer' } }); expect(reply.statusCode).toBe(503); expect(reply.json().error.code).toBe('CONFIGURATION_ERROR'); expect(f.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 }); }
  finally { await f.close(); }
});
it.each([{ objective: '' }, { objective: '   ' }, { objective: 'x'.repeat(8001) }, { objective: 'Read', provider: 'fake' }, { objective: 'sk-123456789012345678901234567890' }])('rejects malformed or secret-bearing task bodies', async (payload) => {
  const f = agentFixture({ provider: new FakeModelProvider([]) });
  try { expect((await f.app.inject({ method: 'POST', url: '/api/v1/runs', payload })).statusCode).toBe(400); expect(f.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 }); }
  finally { await f.close(); }
});
it('keeps request whitespace and serves bounded nonoverlapping cursor pages', async () => {
  const f = agentFixture({ provider: createOnboardingTestModel() });
  try {
    const objective = `  ${ONBOARDING_OBJECTIVE}\n`; const id = f.service.create({ objective }).id; await f.service.waitForIdle(id);
    expect(RunSnapshotSchema.parse((await f.app.inject(`/api/v1/runs/${id}`)).json()).run.objective).toBe(objective);
    let cursor = 0; const ids: string[] = [];
    while (true) { const page = f.service.events(id, cursor, 7); ids.push(...page.events.map((event) => event.id)); if (page.nextCursor === null) break; expect(page.nextCursor).toBeGreaterThan(cursor); cursor = page.nextCursor; }
    expect(new Set(ids).size).toBe(ids.length); expect(f.db.prepare('SELECT count(*) AS n FROM run_events WHERE run_id=?').get(id)).toEqual({ n: ids.length });
    expect((await f.app.inject(`/api/v1/runs/${id}/events?after=-1`)).statusCode).toBe(400);
    expect((await f.app.inject('/api/v1/runs/absent')).statusCode).toBe(404);
    expect((await f.app.inject({ method: 'POST', url: '/api/v1/tools/execute', payload: {} })).statusCode).toBe(404);
  } finally { await f.close(); }
});
it.each(['APPROVED', 'REJECTED'] as const)('persists %s with idempotent repeats and conflicting decisions rejected', async (decision) => {
  const f = agentFixture({ provider: createOnboardingTestModel() });
  try {
    const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id); const approval = f.service.snapshot(id).pendingApprovals[0]!;
    const payload = { decision, note: 'Human test decision' }; expect(f.service.decision(id, approval.id, payload).repeated).toBe(false); expect(f.service.decision(id, approval.id, payload).repeated).toBe(true);
    const response = await f.app.inject({ method: 'POST', url: `/api/v1/runs/${id}/approvals/${approval.id}/decision`, payload: { decision: decision === 'APPROVED' ? 'REJECTED' : 'APPROVED' } }); expect(response.statusCode).toBe(409);
    await f.service.waitForIdle(id); const result = f.service.snapshot(id);
    expect(result.run.status).toBe(decision === 'APPROVED' ? 'COMPLETED' : 'PARTIAL'); expect(f.db.prepare('SELECT count(*) AS n FROM sandbox_outbox').get()).toEqual({ n: decision === 'APPROVED' ? 1 : 0 });
    expect(f.service.store.approvals(id)[0]?.decisionMaker).toBe('local-user');
  } finally { await f.close(); }
});
it('retains exact approval and all progress across process restart', async () => {
  const f = agentFixture({ provider: createOnboardingTestModel() }); let restarted: ReturnType<typeof createApp> | undefined;
  try {
    const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id); const before = f.service.snapshot(id); await f.app.close();
    const model = createOnboardingTestModel(); const db = openDatabase(f.path); restarted = createApp({ database: db, config: f.config, logging: false, agent: { provider: model } }); await restarted.ready();
    const service = restarted.getDecorator<RunService>('runService'); await service.waitForIdle(id); expect(model.requests).toHaveLength(0); expect(service.snapshot(id).pendingApprovals).toEqual(before.pendingApprovals);
    service.decision(id, before.pendingApprovals[0]!.id, { decision: 'APPROVED' }); await service.waitForIdle(id);
    expect(service.snapshot(id).run.status).toBe('COMPLETED'); expect(service.snapshot(id).steps).toHaveLength(before.steps.length); expect(db.prepare('SELECT count(*) AS n FROM sandbox_outbox').get()).toEqual({ n: 1 });
  } finally { await restarted?.close(); await f.close(); }
});
it('pauses on no customer match, rejects stale input, and resumes only from a specific answer after restart', async () => {
  const goal = GoalSpecificationSchema.parse({ summary: 'Resolve customer', intent: 'GENERAL', entities: [{ name: 'Acme Logistics', type: 'customer', unresolved: true }], deliverables: [{ id: 'customer', category: 'CUSTOMER', description: 'Resolve account', minCount: 1, sourceRequired: false }], constraints: [], questions: [] });
  const plan = PlanSchema.parse({ summary: 'Find customer', milestones: [{ id: 'find', description: 'Resolve', deliverableIds: ['customer'], prerequisites: [] }], blocked: [] });
  const f = agentFixture({ provider: new FakeModelProvider([goal, plan, { decision: toolDecision('search_customers', { query: 'nonexistent' }, ['customer']) }]) }); let restarted: ReturnType<typeof createApp> | undefined;
  try {
    const customerId = (f.db.prepare('SELECT id FROM customers LIMIT 1').get() as { id: string }).id;
    const id = f.service.create({ objective: 'Find Acme Logistics customer' }).id; await f.service.waitForIdle(id); const question = f.service.snapshot(id).pendingQuestions[0]!; expect(f.service.snapshot(id).run.status).toBe('WAITING_INPUT'); await f.app.close();
    const model = new FakeModelProvider([{ decision: toolDecision('get_customer_record', { id: customerId }, ['customer']) }, { decision: completionDecision }]); restarted = createApp({ database: openDatabase(f.path), config: f.config, logging: false, agent: { provider: model } }); await restarted.ready(); const service = restarted.getDecorator<RunService>('runService');
    expect(service.snapshot(id).pendingQuestions[0]?.id).toBe(question.id); expect(model.requests).toHaveLength(0);
    expect((await restarted.inject({ method: 'POST', url: `/api/v1/runs/${id}/input`, payload: { questionId: 'stale', answer: 'Use the customer', choiceId: customerId } })).statusCode).toBe(409);
    expect((await restarted.inject({ method: 'POST', url: `/api/v1/runs/${id}/input`, payload: { questionId: question.id, answer: 'Use the customer' } })).statusCode).toBe(400);
    service.input(id, { questionId: question.id, answer: 'Use this observed account', choiceId: customerId }); await service.waitForIdle(id); expect(service.snapshot(id).run.status).toBe('COMPLETED'); expect(model.requests[0]?.context['questions']).toEqual(expect.arrayContaining([expect.objectContaining({ answer: 'Use this observed account', choiceId: customerId })]));
  } finally { await restarted?.close(); await f.close(); }
});
it('reconstructs a committed local mutation after a crash before step success was persisted', async () => {
  const f = agentFixture({ provider: new FakeModelProvider([{ decision: completionDecision }]) }); const layer = createToolLayer(f.db, f.config);
  try {
    const store = f.service.store; const objective = 'Create Acme Logistics project'; const id = store.create(objective, 'local-operator', permissionsForObjective(objective), f.service.budgets);
    const goal = GoalSpecificationSchema.parse({ summary: 'Create project', intent: 'PROJECT_SETUP', entities: [], deliverables: [{ id: 'project', category: 'PROJECT', description: 'Create project', minCount: 1, sourceRequired: false }], constraints: [], questions: [] });
    store.moveRun(id, 'UNDERSTANDING', 'Test recovery'); store.saveGoal(id, goal); store.savePlan(id, { summary: 'Create project', milestones: [{ id: 'project', description: 'Create', deliverableIds: ['project'], prerequisites: [] }], blocked: [] }); store.moveRun(id, 'PLANNED', 'Plan saved'); store.moveRun(id, 'RUNNING', 'Begin');
    const customerId = (f.db.prepare('SELECT id FROM customers LIMIT 1').get() as { id: string }).id; f.db.prepare('UPDATE agent_runs SET resolved_customer_id=? WHERE run_id=?').run(customerId, id);
    const raw = { customerId, name: 'Recovered project' }; const args = JsonObjectSchema.parse(layer.registry.resolve('create_project').prepare(raw).input);
    const action = store.propose(id, 'create_project', args, 'Create project', 'One project', ['project'], 'test-recovery-operation', raw); store.moveStep(action.step_id, 'RUNNING', 'Crash window');
    expect((await layer.executor.execute('create_project', raw, { runId: id, stepId: action.step_id, actorId: 'local-operator', grantedScopes: permissionsForObjective(objective), idempotencyKey: action.idempotency_key, deadline: Date.now() + 30000 })).ok).toBe(true);
    expect(store.step(action.step_id).output).toBeNull(); await f.service.recover(); await f.service.waitForIdle(id);
    expect(f.service.snapshot(id).run.status).toBe('COMPLETED'); expect(f.service.snapshot(id).budgets.toolCalls).toBe(0); expect(f.db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 });
  } finally { await layer.close(); await f.close(); }
});
it('cancels a waiting approval without creating an outbox message', async () => {
  const f = agentFixture({ provider: createOnboardingTestModel() });
  try { const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id); const response = await f.app.inject({ method: 'POST', url: `/api/v1/runs/${id}/cancel`, payload: {} }); expect(response.statusCode).toBe(202); await f.service.waitForIdle(id); expect(f.service.snapshot(id).run.status).toBe('CANCELLED'); expect(f.service.store.approvals(id)[0]?.status).toBe('CANCELLED'); expect(f.db.prepare('SELECT count(*) AS n FROM sandbox_outbox').get()).toEqual({ n: 0 }); }
  finally { await f.close(); }
});
it('rejects expired approvals and client-supplied decision identity', async () => {
  let now = Date.now(); const f = agentFixture({ provider: createOnboardingTestModel(), clock: () => new Date(now) });
  try { const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id); const approval = f.service.snapshot(id).pendingApprovals[0]!; const url = `/api/v1/runs/${id}/approvals/${approval.id}/decision`; expect((await f.app.inject({ method: 'POST', url, payload: { decision: 'APPROVED', decisionMaker: 'forged' } })).statusCode).toBe(400); now += f.service.budgets.runTimeoutMs + 1; expect((await f.app.inject({ method: 'POST', url, payload: { decision: 'APPROVED' } })).statusCode).toBe(409); expect(f.db.prepare('SELECT count(*) AS n FROM sandbox_outbox').get()).toEqual({ n: 0 }); }
  finally { await f.close(); }
});
