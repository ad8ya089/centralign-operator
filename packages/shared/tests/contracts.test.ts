import { describe, expect, it } from 'vitest';
import {
  APPROVAL_STATUSES, RUN_STATUSES, STEP_STATUSES, ApprovalRecordSchema, ErrorResponseSchema,
  HealthResponseSchema, JsonObjectSchema, JsonValueSchema, MemoryEntryRecordSchema, RelativePathSchema,
  RunRecordSchema, RunStepRecordSchema, canTransitionApproval, canTransitionRun, canTransitionStep,
  parseStoredJson, transitionRun, transitionStep,
} from '../src/index.js';
import type { RunRecord, RunStepRecord } from '../src/index.js';

const at = '2026-10-25T10:00:00.000Z';
const later = '2026-10-25T10:01:00.000Z';
const run: RunRecord = { id: 'r1', objective: 'Onboard fictional Acme', status: 'CREATED', createdAt: at, updatedAt: at, completedAt: null, metadata: {}, version: 0 };
const step: RunStepRecord = { id: 's1', runId: 'r1', stepIndex: 0, description: 'Check prerequisites', status: 'READY', input: {}, output: null, attemptCount: 0, createdAt: at, updatedAt: at, startedAt: null, completedAt: null, error: null };

describe('run state rules', () => {
  it.each([
    ['CREATED', 'UNDERSTANDING'], ['UNDERSTANDING', 'PLANNED'], ['PLANNED', 'RUNNING'],
    ['RUNNING', 'WAITING_APPROVAL'], ['WAITING_APPROVAL', 'RUNNING'], ['WAITING_INPUT', 'UNDERSTANDING'],
    ['RUNNING', 'VERIFYING'], ['VERIFYING', 'RUNNING'], ['VERIFYING', 'COMPLETED'], ['VERIFYING', 'PARTIAL'],
  ] as const)('accepts %s -> %s', (from, to) => expect(canTransitionRun(from, to)).toBe(true));

  it.each([
    ['CREATED', 'RUNNING'], ['RUNNING', 'COMPLETED'], ['UNDERSTANDING', 'COMPLETED'], ['CREATED', 'CREATED'],
  ] as const)('rejects %s -> %s', (from, to) => expect(canTransitionRun(from, to)).toBe(false));

  it.each(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'] as const)('protects terminal %s', (from) => {
    for (const to of RUN_STATUSES) expect(canTransitionRun(from, to)).toBe(false);
  });

  it('returns a validated new version and leaves the original intact', () => {
    const result = transitionRun(run, 'UNDERSTANDING', later);
    expect(result).toMatchObject({ status: 'UNDERSTANDING', version: 1, updatedAt: later, completedAt: null });
    expect(run.status).toBe('CREATED');
    expect(result).not.toBe(run);
  });

  it('preserves all state after an invalid transition', () => {
    const before = JSON.stringify(run);
    expect(() => transitionRun(run, 'COMPLETED', later)).toThrow('Invalid run transition');
    expect(JSON.stringify(run)).toBe(before);
  });

  it('timestamps a terminal result only after verification', () => {
    const result = transitionRun({ ...run, status: 'VERIFYING' }, 'COMPLETED', later);
    expect(result.completedAt).toBe(later);
    expect(RunRecordSchema.safeParse({ ...run, status: 'COMPLETED' }).success).toBe(false);
  });
});

describe('step and approval state rules', () => {
  it.each([
    ['PENDING', 'READY'], ['READY', 'RUNNING'], ['RUNNING', 'SUCCEEDED'], ['RUNNING', 'RETRYING'],
    ['RETRYING', 'RUNNING'], ['RUNNING', 'BLOCKED'], ['BLOCKED', 'READY'], ['WAITING_APPROVAL', 'READY'],
  ] as const)('accepts %s -> %s', (from, to) => expect(canTransitionStep(from, to)).toBe(true));

  it.each([['PENDING', 'SUCCEEDED'], ['READY', 'SUCCEEDED'], ['WAITING_APPROVAL', 'SUCCEEDED'], ['READY', 'READY']] as const)(
    'rejects %s -> %s', (from, to) => expect(canTransitionStep(from, to)).toBe(false));

  it.each(['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'] as const)('protects terminal %s', (from) => {
    for (const to of STEP_STATUSES) expect(canTransitionStep(from, to)).toBe(false);
  });

  it('increments attempt count when execution starts and preserves invalid state', () => {
    const running = transitionStep(step, 'RUNNING', later);
    expect(running).toMatchObject({ attemptCount: 1, startedAt: later, status: 'RUNNING' });
    const before = JSON.stringify(step);
    expect(() => transitionStep(step, 'SUCCEEDED', later)).toThrow('Invalid step transition');
    expect(JSON.stringify(step)).toBe(before);
    expect(RunStepRecordSchema.parse(running)).toEqual(running);
  });

  it('makes resolved approvals irreversible in the shared contract', () => {
    expect(canTransitionApproval('PENDING', 'APPROVED')).toBe(true);
    expect(canTransitionApproval('REJECTED', 'APPROVED')).toBe(false);
    for (const from of APPROVAL_STATUSES.filter((status) => status !== 'PENDING')) {
      for (const to of APPROVAL_STATUSES) expect(canTransitionApproval(from, to)).toBe(false);
    }
  });

  it('requires attribution for a human approval decision', () => {
    const pending = { id: 'a1', runId: 'r1', stepId: null, action: { recipient: 'fictional@example.test' }, policyReason: 'Outbound email', status: 'PENDING', requestedAt: at, expiresAt: null, decidedAt: null, decisionMaker: null, decisionNote: null };
    expect(ApprovalRecordSchema.safeParse(pending).success).toBe(true);
    expect(ApprovalRecordSchema.safeParse({ ...pending, status: 'APPROVED', decidedAt: later }).success).toBe(false);
  });
});

describe('runtime data boundaries', () => {
  it('accepts nested JSON and rejects non-JSON values', () => {
    const value = { items: [null, true, 4.2, 'text', { nested: false }] };
    expect(JsonValueSchema.parse(value)).toEqual(value);
    for (const invalid of [undefined, NaN, Infinity, () => 1, new Date(), { field: undefined }, { amount: 1n }]) {
      expect(JsonValueSchema.safeParse(invalid).success).toBe(false);
    }
    expect(JsonObjectSchema.safeParse([]).success).toBe(false);
  });

  it('validates database JSON instead of trusting parsed data', () => {
    expect(parseStoredJson('{"ok":true}', JsonObjectSchema)).toEqual({ ok: true });
    expect(() => parseStoredJson('[]', JsonObjectSchema)).toThrow();
    expect(() => parseStoredJson('{broken', JsonObjectSchema)).toThrow();
  });

  it('accepts consistent health payloads with UTC timestamps', () => {
    expect(HealthResponseSchema.parse({ status: 'healthy', database: 'connected', service: 'centralign-operator', timestamp: at }).status).toBe('healthy');
    expect(HealthResponseSchema.parse({ status: 'degraded', database: 'unavailable', service: 'centralign-operator', timestamp: at }).status).toBe('degraded');
  });

  it.each([
    { status: 'healthy', database: 'unavailable', service: 'centralign-operator', timestamp: at },
    { status: 'healthy', database: 'connected', service: 'other', timestamp: at },
    { status: 'healthy', database: 'connected', service: 'centralign-operator', timestamp: '2026-10-25T10:00:00+05:30' },
    { status: 'healthy', database: 'connected', service: 'centralign-operator', timestamp: at, extra: true },
  ])('rejects ambiguous health payload %#', (body) => expect(HealthResponseSchema.safeParse(body).success).toBe(false));

  it('validates reusable structured errors', () => {
    expect(ErrorResponseSchema.safeParse({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'request-1', details: null }, timestamp: at }).success).toBe(true);
    expect(ErrorResponseSchema.safeParse({ error: 'Oops' }).success).toBe(false);
  });

  it('rejects unsafe portable paths', () => {
    expect(RelativePathSchema.parse('fixtures/company/onboarding-sop.md')).toBe('fixtures/company/onboarding-sop.md');
    for (const path of ['../secret', '/secret', 'C:/secret', 'folder/../secret', 'folder\\secret', 'a//b']) expect(RelativePathSchema.safeParse(path).success).toBe(false);
  });

  it('does not let a provisional memory masquerade as approved policy', () => {
    const memory = { id: 'm1', scope: 'COMPANY', scopeId: null, content: 'A lesson', sourceReferences: [], trustStatus: 'PROVISIONAL', createdAt: at, updatedAt: at, reviewedAt: null, reviewedBy: null };
    expect(MemoryEntryRecordSchema.safeParse(memory).success).toBe(true);
    expect(MemoryEntryRecordSchema.safeParse({ ...memory, trustStatus: 'APPROVED' }).success).toBe(false);
    expect(MemoryEntryRecordSchema.safeParse({ ...memory, trustStatus: 'APPROVED', reviewedAt: later, reviewedBy: 'reviewer-1' }).success).toBe(true);
  });
});
