import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailDraftRecordSchema, OutboxRecordSchema } from '@centralign/shared';
import type { EmailDraftRecord, SendEmailAction } from '@centralign/shared';
import { canonicalSendAction } from '../src/tools/catalog.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { z } from 'zod';
import { AT } from './helpers.js';
import { success, toolFixture } from './tool-helpers.js';

export function approveDraft(fixture: ReturnType<typeof toolFixture>, draft: EmailDraftRecord, options: { status?: string; action?: SendEmailAction; expiresAt?: string | null; decidedAt?: string; id?: string } = {}): string {
  const status = options.status ?? 'APPROVED';
  const id = options.id ?? 'approval-test';
  fixture.db.prepare('INSERT INTO approvals (id,run_id,step_id,action_json,policy_reason,status,requested_at,expires_at,decided_at,decision_maker,decision_note) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'r1', 's1', JSON.stringify(options.action ?? canonicalSendAction(draft)), 'Exact sandbox test action', status, '2026-10-25T09:59:00.000Z', options.expiresAt ?? null, status === 'PENDING' ? null : options.decidedAt ?? AT, status === 'PENDING' ? null : 'human-test-reviewer', null);
  return id;
}

describe('exact approval for local sandbox email', () => {
  let fixture: ReturnType<typeof toolFixture>;
  let draft: EmailDraftRecord;
  beforeEach(async () => {
    fixture = toolFixture();
    draft = success(await fixture.executor.execute('create_email_draft', { customerId: 'customer-acme-logistics', recipient: 'mira.sen@acme-logistics.example.test', subject: 'Welcome to Harborline', body: 'Your questionnaire remains pending.' }, fixture.context('draft-key')), EmailDraftRecordSchema);
  });
  afterEach(() => { vi.unstubAllGlobals(); fixture.cleanup(); });
  it('persists a real draft and independently reads it back', async () => {
    expect(draft.status).toBe('DRAFT');
    expect(success(await fixture.executor.execute('get_email_draft', { id: draft.id }, fixture.context()), EmailDraftRecordSchema)).toEqual(draft);
    expect(await fixture.executor.execute('create_email_draft', { customerId: 'customer-acme-logistics', recipient: draft.recipient, subject: draft.subject, body: draft.body }, fixture.context('draft-key'))).toMatchObject({ ok: true, replayed: true });
  });
  it.each(['PENDING', 'REJECTED', 'EXPIRED', 'CANCELLED'])('denies %s approvals without queuing anything', async (status) => {
    const approvalId = approveDraft(fixture, draft, { status });
    expect(await fixture.executor.execute('send_email', { draftId: draft.id, approvalId }, fixture.context('denied-send'))).toMatchObject({ ok: false, error: { category: 'PERMISSION' } });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM sandbox_outbox').get()).toEqual({ count: 0 });
    expect(fixture.db.prepare('SELECT status FROM email_drafts').get()).toEqual({ status: 'DRAFT' });
  });
  it('denies missing approval, missing send permission, and caller approval claims', async () => {
    expect(await fixture.executor.execute('send_email', { draftId: draft.id, approvalId: 'missing' }, fixture.context('missing-approval'))).toMatchObject({ ok: false, error: { code: 'APPROVAL_REQUIRED' } });
    const approvalId = approveDraft(fixture, draft);
    expect(await fixture.executor.execute('send_email', { draftId: draft.id, approvalId }, fixture.context('no-scope', { grantedScopes: ['email:read'] }))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await fixture.executor.execute('send_email', { draftId: draft.id, approvalId, approved: true }, fixture.context('claim'))).toMatchObject({ ok: false, error: { category: 'VALIDATION' } });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM sandbox_outbox').get()).toEqual({ count: 0 });
  });
  it('enforces consequential-action approval in the common wrapper before invoking a handler', async () => {
    const registry = new ToolRegistry();
    let called = false;
    registry.register({ metadata: { name: 'send_email', description: 'A deliberately untrusted test handler behind the common policy boundary.', risk: 'external_side_effect', requiredScopes: ['email:send'], timeoutMs: 1000, retry: 'idempotent_local', changesPersistentState: true, persistence: 'sqlite' }, inputSchema: z.strictObject({ draftId: z.string(), approvalId: z.string() }), resultSchema: z.string(), handler: () => { called = true; return { data: 'Must not execute', evidence: [] }; } });
    const executor = new ToolExecutor(fixture.db, registry, fixture.workspace);
    expect(await executor.execute('send_email', { draftId: draft.id, approvalId: 'missing' }, fixture.context('common-policy'))).toMatchObject({ ok: false, error: { code: 'APPROVAL_REQUIRED' } });
    expect(called).toBe(false);
  });
  it.each(['recipient', 'subject', 'body', 'draftId', 'type'])('denies an approval with mismatched %s', async (field) => {
    const action = { ...canonicalSendAction(draft), [field]: field === 'recipient' ? 'different@example.test' : 'different-material-value' } as SendEmailAction;
    const approvalId = approveDraft(fixture, draft, { action });
    expect(await fixture.executor.execute('send_email', { draftId: draft.id, approvalId }, fixture.context('mismatch'))).toMatchObject({ ok: false, error: { code: 'APPROVAL_INVALID' } });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM sandbox_outbox').get()).toEqual({ count: 0 });
  });
  it('invalidates approval when the persisted draft body changes', async () => {
    const approvalId = approveDraft(fixture, draft);
    fixture.db.prepare('UPDATE email_drafts SET body=? WHERE id=?').run('Changed after approval', draft.id);
    expect(await fixture.executor.execute('send_email', { draftId: draft.id, approvalId }, fixture.context('changed-body'))).toMatchObject({ ok: false, error: { code: 'APPROVAL_INVALID' } });
  });
  it.each([
    { expiresAt: '2026-10-25T09:59:59.000Z' }, { decidedAt: 'invalid-timestamp' }, { decidedAt: '2026-10-25T11:00:00.000Z' },
  ])('denies expired or invalid decision metadata %#', async (options) => {
    const approvalId = approveDraft(fixture, draft, options);
    expect(await fixture.executor.execute('send_email', { draftId: draft.id, approvalId }, fixture.context('invalid-decision'))).toMatchObject({ ok: false, error: { code: 'APPROVAL_INVALID' } });
  });
  it('queues exactly one approved sandbox message and performs no fetch or external delivery', async () => {
    const network = vi.fn(() => { throw new Error('External network must not be used'); }); vi.stubGlobal('fetch', network);
    const approvalId = approveDraft(fixture, draft);
    const input = { draftId: draft.id, approvalId };
    const [first, second] = await Promise.all([fixture.executor.execute('send_email', input, fixture.context('send-key')), fixture.executor.execute('send_email', input, fixture.context('send-key'))]);
    const outbox = success(first, OutboxRecordSchema);
    expect(second).toMatchObject({ ok: true, replayed: true, data: outbox });
    expect(success(await fixture.executor.execute('get_outbox_message', { id: outbox.id }, fixture.context()), OutboxRecordSchema)).toEqual(outbox);
    expect(outbox.status).toBe('SANDBOX_QUEUED'); expect(network).not.toHaveBeenCalled();
    expect(fixture.db.prepare('SELECT count(*) AS count FROM sandbox_outbox').get()).toEqual({ count: 1 });
    expect(await fixture.executor.execute('send_email', input, fixture.context('different-send-key'))).toMatchObject({ ok: false, error: { code: 'DRAFT_ALREADY_QUEUED' } });
  });
  it('rolls back draft state if an outbox transaction fails', async () => {
    const approvalId = approveDraft(fixture, draft);
    fixture.db.exec("CREATE TRIGGER inject_outbox_failure BEFORE INSERT ON sandbox_outbox BEGIN SELECT RAISE(ABORT,'Injected fault'); END;");
    expect(await fixture.executor.execute('send_email', { draftId: draft.id, approvalId }, fixture.context('outbox-fault'))).toMatchObject({ ok: false, error: { retryability: 'NEVER' } });
    expect(fixture.db.prepare('SELECT status FROM email_drafts').get()).toEqual({ status: 'DRAFT' });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM sandbox_outbox').get()).toEqual({ count: 0 });
  });
});
