import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { GoalSpecificationSchema } from '@centralign/shared';
import { createOnboardingTestModel, demoGoal, ONBOARDING_OBJECTIVE } from '../src/agent/testing/onboarding-model.js';
import { FakeModelProvider } from '../src/agent/fake-model-provider.js';
import type { ToolExecutionPort } from '../src/agent/contracts.js';
import { createToolLayer } from '../src/tools/layer.js';
import { agentFixture } from './agent-helpers.js';

it.each(['missing bytes', 'changed bytes', 'incorrect stored hash', 'incorrect MIME', 'wrong owner', 'missing citation', 'stale source', 'changed project', 'changed task', 'changed draft'])( 'fresh verification rejects %s and prevents final completion', async (scenario) => {
  const f = agentFixture({ provider: createOnboardingTestModel() }, { AGENT_MAX_REPLANS: '0' });
  try {
    const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id); const waiting = f.service.snapshot(id); expect(waiting.run.status).toBe('WAITING_APPROVAL');
    const artifact = waiting.artifacts[0]!; const path = join(f.workspace, artifact.path);
    if (scenario === 'missing bytes') unlinkSync(path);
    if (scenario === 'changed bytes') writeFileSync(path, 'Forged success');
    if (scenario === 'incorrect stored hash') f.db.prepare('UPDATE artifacts SET content_hash=? WHERE id=?').run('0'.repeat(64), artifact.id);
    if (scenario === 'incorrect MIME') f.db.prepare("UPDATE artifacts SET mime_type='text/plain' WHERE id=?").run(artifact.id);
    if (scenario === 'wrong owner') f.db.prepare('UPDATE artifacts SET step_id=NULL WHERE id=?').run(artifact.id);
    if (scenario === 'missing citation') f.db.prepare("UPDATE artifacts SET metadata_json=json_set(metadata_json,'$.sources',json('[]')) WHERE id=?").run(artifact.id);
    if (scenario === 'stale source') f.db.prepare("UPDATE company_documents SET content_hash=? WHERE id='doc-onboarding-sop'").run('0'.repeat(64));
    if (scenario === 'changed project') f.db.prepare("UPDATE projects SET name='Incorrect project'").run();
    if (scenario === 'changed task') f.db.prepare("UPDATE tasks SET title='Incorrect task'").run();
    if (scenario === 'changed draft') f.db.prepare("UPDATE email_drafts SET body='Changed after human preview'").run();
    f.service.decision(id, waiting.pendingApprovals[0]!.id, { decision: 'APPROVED' }); await f.service.waitForIdle(id);
    const snapshot = f.service.snapshot(id); expect(snapshot.run.status).toBe('PARTIAL'); expect(snapshot.finalResult?.outstanding.length).toBeGreaterThan(0); expect(snapshot.verification.some((check) => !check.passed)).toBe(true);
    if (scenario === 'changed draft') expect(f.db.prepare('SELECT count(*) AS n FROM sandbox_outbox').get()).toEqual({ n: 0 });
  } finally { await f.close(); }
}, 20000);
it.each(['missing outbox', 'changed message', 'invalid approval'] as const)('read-back rejects %s after a previously successful send', async (scenario) => {
  const f = agentFixture({ provider: createOnboardingTestModel() });
  try {
    const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id); f.service.decision(id, f.service.snapshot(id).pendingApprovals[0]!.id, { decision: 'APPROVED' }); await f.service.waitForIdle(id); expect(f.service.snapshot(id).run.status).toBe('COMPLETED');
    if (scenario === 'missing outbox') f.db.prepare('DELETE FROM sandbox_outbox').run();
    if (scenario === 'changed message') f.db.prepare("UPDATE sandbox_outbox SET body='Different message'").run();
    if (scenario === 'invalid approval') f.db.prepare("UPDATE approvals SET action_json=json_set(action_json,'$.recipient','wrong@example.test')").run();
    const actual = f.service.runtime.verifier.goal(id); expect(actual.complete).toBe(false); expect(actual.result.outstanding.some((item) => item.deliverableId === 'welcome')).toBe(true);
  } finally { await f.close(); }
});
it('does not equate successful tool output with a persisted business effect', async () => {
  let layer: ReturnType<typeof createToolLayer>;
  const executor: ToolExecutionPort = { execute: async (name, args, context) => { const result = await layer.executor.execute(name, args, context); if (name === 'create_project' && result.ok) f.db.prepare('DELETE FROM projects').run(); return result; } };
  const f = agentFixture({ provider: createOnboardingTestModel(), executor }, { AGENT_MAX_REPLANS: '0' }); layer = createToolLayer(f.db, f.config);
  try { const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id); expect(f.service.snapshot(id).run.status).toBe('PARTIAL'); expect(f.service.snapshot(id).finalResult?.outstanding.some((item) => item.deliverableId === 'project')).toBe(true); expect(f.service.snapshot(id).verification.some((check) => !check.passed && check.explanation.includes('read-back'))).toBe(true); }
  finally { await layer.close(); await f.close(); }
});
it('requires explicit activation readiness independently of prepared materials', async () => {
  const goal = GoalSpecificationSchema.parse({ ...demoGoal, deliverables: [...demoGoal.deliverables, { id: 'activation', category: 'ACTIVATION_READINESS', description: 'Customer is ready to activate', minCount: 1, sourceRequired: false }] });
  const f = agentFixture({ provider: new FakeModelProvider([goal]) }, { AGENT_MAX_REPLANS: '0' });
  try { const id = f.service.store.create(`${ONBOARDING_OBJECTIVE} Verify activation readiness.`, 'local-operator', [], f.service.budgets); f.service.store.saveGoal(id, goal); const customerId = (f.db.prepare('SELECT id FROM customers').get() as { id: string }).id; f.db.prepare('UPDATE agent_runs SET resolved_customer_id=? WHERE run_id=?').run(customerId, id); const result = f.service.runtime.verifier.goal(id); expect(result.complete).toBe(false); expect(result.result.outstanding.find((item) => item.deliverableId === 'activation')).toBeDefined(); expect(result.result.warnings.join(' ')).toContain('Activation remains blocked'); }
  finally { await f.close(); }
});
