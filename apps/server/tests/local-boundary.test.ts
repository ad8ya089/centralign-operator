import { expect, it } from 'vitest';
import { ErrorResponseSchema } from '@centralign/shared';
import { agentFixture } from './agent-helpers.js';
import { createOnboardingTestModel, ONBOARDING_OBJECTIVE } from '../src/agent/testing/onboarding-model.js';

it('accepts explicit loopback hosts and local browser origins including IPv6', async () => {
  const f = agentFixture();
  try {
    for (const host of ['localhost', 'localhost:5173', '127.0.0.1:3001', '127.2.3.4:4000', '[::1]:3001']) {
      for (const origin of [undefined, 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
        expect((await f.app.inject({ url: '/api/v1/health', headers: { host, ...(origin ? { origin } : {}) } })).statusCode).toBe(200);
      }
    }
  } finally { await f.close(); }
});

it('blocks hostile hosts and cross-site mutations before a run or decision can be written', async () => {
  const f = agentFixture({ provider: createOnboardingTestModel() });
  try {
    for (const host of ['evil.test:3001', 'localhost.evil.test', '0.0.0.0:3001', '127.0.0.999', '127.1', 'localhost:99999', 'localhost@evil.test', '[::]:3001']) {
      const response = await f.app.inject({ method: 'POST', url: '/api/v1/runs', headers: { host, origin: 'http://localhost:5173', 'x-forwarded-host': 'localhost:3001' }, payload: { objective: ONBOARDING_OBJECTIVE } });
      expect(response.statusCode).toBe(403); expect(ErrorResponseSchema.parse(response.json()).error.code).toBe('FORBIDDEN');
    }
    expect(f.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
    const id = f.service.create({ objective: ONBOARDING_OBJECTIVE }).id; await f.service.waitForIdle(id);
    const approval = f.service.snapshot(id).pendingApprovals[0]!;
    for (const origin of ['https://evil.test', 'null', 'http://localhost.evil.test', 'http://localhost@evil.test', 'file:///private', 'http://localhost:5173/path']) {
      // A simple cross-site POST needs no CORS preflight. Origin must be checked on the mutation itself.
      expect((await f.app.inject({ method: 'POST', url: `/api/v1/runs/${id}/cancel`, headers: { origin, 'content-type': 'text/plain' }, payload: '' })).statusCode).toBe(403);
      expect((await f.app.inject({ method: 'POST', url: `/api/v1/runs/${id}/approvals/${approval.id}/decision`, headers: { origin }, payload: { decision: 'APPROVED' } })).statusCode).toBe(403);
    }
    expect(f.service.snapshot(id).run.status).toBe('WAITING_APPROVAL'); expect(f.service.snapshot(id).cancelRequested).toBe(false);
    expect(f.service.snapshot(id).pendingApprovals[0]!.status).toBe('PENDING'); expect(f.db.prepare('SELECT count(*) AS n FROM sandbox_outbox').get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});
