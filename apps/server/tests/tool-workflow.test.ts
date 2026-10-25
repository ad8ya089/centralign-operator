import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { EmailDraftRecordSchema, KnowledgeHitSchema, OutboxRecordSchema, ProjectRecordSchema, TaskRecordSchema } from '@centralign/shared';
import { canonicalSendAction } from '../src/tools/catalog.js';
import { ArtifactResultSchema } from '../src/tools/artifacts.js';
import { sha256 } from '../src/persistence/json.js';
import { AT } from './helpers.js';
import { success, toolFixture } from './tool-helpers.js';

it('runs the deterministic tool layer without an LLM or HTTP executor, then independently reads back its real effects', async () => {
  const fixture = toolFixture();
  try {
    const { executor, context, db } = fixture;
    const knowledge = success(await executor.execute('search_company_knowledge', { query: 'security questionnaire', limit: 5 }, context()), z.object({ hits: z.array(KnowledgeHitSchema) }));
    expect(knowledge.hits.length).toBeGreaterThan(0);
    const project = success(await executor.execute('create_project', { customerId: 'customer-acme-logistics', name: 'Acme onboarding' }, context('workflow-project')), ProjectRecordSchema);
    const task = success(await executor.execute('create_task', { projectId: project.id, title: 'Collect security questionnaire', description: 'Activation remains blocked until security review.' }, context('workflow-task')), TaskRecordSchema);
    expect(success(await executor.execute('get_project', { id: project.id }, context()), ProjectRecordSchema)).toEqual(project);
    expect(success(await executor.execute('list_project_tasks', { projectId: project.id }, context()), z.array(TaskRecordSchema))).toEqual([task]);
    expect(await executor.execute('create_task', { projectId: 'missing', title: 'Invalid' }, context('missing-project'))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await executor.execute('create_project', { customerId: 'missing', name: 'Invalid' }, context('missing-customer'))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await executor.execute('create_task', { projectId: project.id, title: task.title, description: task.description }, context('workflow-task'))).toMatchObject({ ok: true, replayed: true });
    const source = knowledge.hits[0]!;
    const artifact = success(await executor.execute('write_artifact', { filename: 'onboarding-brief.md', content: `# Acme onboarding\n\nQuestionnaire pending.\n\nSource: ${source.sourcePath}#${source.chunkId}`, mimeType: 'text/markdown', sources: [{ documentId: source.documentId, contentHash: source.contentHash, chunkId: source.chunkId }] }, context('workflow-artifact')), ArtifactResultSchema);
    expect(sha256(readFileSync(join(fixture.workspace, artifact.path)))).toBe(artifact.contentHash);
    const draft = success(await executor.execute('create_email_draft', { customerId: project.customerId, projectId: project.id, recipient: 'mira.sen@acme-logistics.example.test', subject: 'Welcome to Harborline', body: 'Please complete the security questionnaire before activation.' }, context('workflow-draft')), EmailDraftRecordSchema);
    // Explicit trusted test fixture decision, confined to this disposable database. No approval tool/UI exists.
    db.prepare('INSERT INTO approvals (id,run_id,step_id,action_json,policy_reason,status,requested_at,decided_at,decision_maker) VALUES (?,?,?,?,?,?,?,?,?)').run('workflow-approval', 'r1', 's1', JSON.stringify(canonicalSendAction(draft)), 'Isolated workflow test', 'APPROVED', AT, AT, 'test-human');
    const outbox = success(await executor.execute('send_email', { draftId: draft.id, approvalId: 'workflow-approval' }, context('workflow-send')), OutboxRecordSchema);
    expect(success(await executor.execute('get_outbox_message', { id: outbox.id }, context()), OutboxRecordSchema)).toEqual(outbox);
    expect(db.prepare('SELECT status FROM customers WHERE id=?').get(project.customerId)).toEqual({ status: 'BLOCKED' });
    expect(db.prepare('SELECT tool_name,status FROM tool_executions WHERE idempotency_key=?').get('workflow-send')).toEqual({ tool_name: 'send_email', status: 'SUCCEEDED' });
  } finally { fixture.cleanup(); }
});
