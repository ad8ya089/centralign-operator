import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RunSnapshotSchema } from '@centralign/shared';
import { createOnboardingTestModel, ONBOARDING_OBJECTIVE } from '../src/agent/testing/onboarding-model.js';
import { sha256 } from '../src/persistence/json.js';
import { agentFixture } from './agent-helpers.js';

it('dynamically onboards through the real tools, pauses for exact approval, and completes only after read-back verification', async () => {
  const model = createOnboardingTestModel(); const fixture = agentFixture({ provider: model });
  try {
    const accepted = await fixture.app.inject({ method: 'POST', url: '/api/v1/runs', payload: { objective: ONBOARDING_OBJECTIVE } });
    expect(accepted.statusCode).toBe(202);
    const id = (accepted.json() as { id: string }).id; await fixture.service.waitForIdle(id);
    const waiting = fixture.service.snapshot(id);
    expect(waiting.run.status).toBe('WAITING_APPROVAL'); expect(waiting.pendingApprovals).toHaveLength(1);
    expect(fixture.db.prepare('SELECT count(*) AS count FROM sandbox_outbox').get()).toEqual({ count: 0 });
    expect(waiting.artifacts).toHaveLength(1);
    expect(sha256(readFileSync(join(fixture.workspace, waiting.artifacts[0]!.path)))).toBe(waiting.artifacts[0]!.contentHash);
    const approval = waiting.pendingApprovals[0]!;
    const decision = await fixture.app.inject({ method: 'POST', url: `/api/v1/runs/${id}/approvals/${approval.id}/decision`, payload: { decision: 'APPROVED', note: 'Explicit approval in an isolated integration test' } });
    expect(decision.statusCode).toBe(202); await fixture.service.waitForIdle(id);
    const fetched = await fixture.app.inject({ method: 'GET', url: `/api/v1/runs/${id}` });
    const final = RunSnapshotSchema.parse(fetched.json());
    expect(final.run.status).toBe('COMPLETED'); expect(final.finalResult?.outstanding).toEqual([]); expect(final.finalResult?.verified).toHaveLength(7);
    expect(final.finalResult?.warnings.join(' ')).toContain('Activation remains blocked');
    expect(fixture.db.prepare('SELECT count(*) AS count FROM projects').get()).toEqual({ count: 1 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM tasks').get()).toEqual({ count: 2 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM sandbox_outbox').get()).toEqual({ count: 1 });
    expect(fixture.db.prepare('SELECT status FROM customers').get()).toEqual({ status: 'BLOCKED' });
    expect(model.requests.filter((request) => request.phase === 'act').length).toBeGreaterThan(8);
    expect(model.requests.some((request) => JSON.stringify(request.context).includes('project-exec-'))).toBe(true);
    const events = fixture.service.events(id, 0, 100).events;
    expect(events.some((event) => event.type === 'APPROVAL_REQUESTED')).toBe(true);
    expect(events.some((event) => event.type === 'VERIFICATION_PASSED')).toBe(true);
    expect(final.budgets.modelCalls).toBe(model.requests.length);
  } finally { await fixture.close(); }
}, 20000);
