import { z } from 'zod';
import { CustomerRecordSchema, EmailDraftRecordSchema, IdentifierSchema, IndexedDocumentSchema, KnowledgeHitSchema, OutboxRecordSchema, ProjectRecordSchema, TaskRecordSchema, JsonObjectSchema } from '@centralign/shared';
import { readCompanyDocument, searchCompanyKnowledge, SearchKnowledgeInputSchema } from '../context/knowledge.js';
import { BusinessStore } from './business-store.js';
import { ArtifactInputSchema, ArtifactResultSchema } from './artifacts.js';
import { canonicalSendAction, validateApproval } from './policy.js';
export { canonicalSendAction } from './policy.js';
import { ToolFault } from './errors.js';
import { ToolRegistry } from './registry.js';
import type { Evidence, PermissionScope, ToolMetadata, ToolValue } from './contracts.js';

const Id = IdentifierSchema.max(200);
const IdInput = z.strictObject({ id: Id });
const label = z.string().trim().min(1).max(200);
const metadataSchema = JsonObjectSchema.default({});
const evidence = (kind: Evidence['kind'], id: string, metadata = {}): Evidence => ({ kind, id, reference: `${kind}:${id}`, metadata });
function metadata(name: string, description: string, scope: PermissionScope, persistence: ToolMetadata['persistence'] = 'none'): ToolMetadata {
  return { name, description, requiredScopes: [scope], risk: name === 'send_email' ? 'external_side_effect' : persistence === 'none' ? 'read' : 'reversible_write', timeoutMs: name.startsWith('browser_') ? 7000 : 3000, retry: persistence === 'none' ? 'safe_read' : persistence === 'sqlite' ? 'idempotent_local' : 'reconcile_before_retry', changesPersistentState: persistence !== 'none', persistence };
}
function value<T>(data: T, ref: Evidence): ToolValue<T> { return { data, evidence: [ref] }; }

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    metadata: metadata('search_company_knowledge', 'Search indexed company sources with traceable excerpts.', 'knowledge:read'), inputSchema: SearchKnowledgeInputSchema,
    resultSchema: z.strictObject({ hits: z.array(KnowledgeHitSchema), mode: z.enum(['fts5', 'text']) }),
    handler: (input, context) => {
      const data = searchCompanyKnowledge(context.db, input);
      return { data, evidence: data.hits.map((hit) => ({ kind: 'document' as const, id: hit.documentId, reference: `${hit.sourcePath}#${hit.chunkId}`, metadata: { contentHash: hit.contentHash, chunkId: hit.chunkId, trust: hit.trust } })) };
    },
  });
  registry.register({ metadata: metadata('read_company_document', 'Read an indexed company source by stable document ID.', 'knowledge:read'), inputSchema: IdInput, resultSchema: IndexedDocumentSchema,
    handler: (input, context) => { const data = readCompanyDocument(context.db, input.id); return value(data, evidence('document', data.id, { sourcePath: data.sourcePath, contentHash: data.contentHash, trust: data.trust })); } });
  registry.register({ metadata: metadata('search_customers', 'Resolve customer candidates without choosing ambiguous matches.', 'customers:read'),
    inputSchema: z.strictObject({ query: label.refine((query) => /[\p{L}\p{N}]/u.test(query), 'Query needs a word'), limit: z.number().int().min(1).max(20).default(10) }),
    resultSchema: z.strictObject({ resolution: z.enum(['NONE', 'UNIQUE', 'AMBIGUOUS']), matchCount: z.number().int().nonnegative(), candidates: z.array(CustomerRecordSchema) }),
    handler: (input, context) => { const data = new BusinessStore(context.db).searchCustomers(input.query, input.limit); return { data, evidence: data.candidates.map((customer) => evidence('customer', customer.id)) }; } });
  registry.register({ metadata: metadata('get_customer_record', 'Read a persisted customer record by its stable ID.', 'customers:read'), inputSchema: IdInput, resultSchema: CustomerRecordSchema,
    handler: (input, context) => value(new BusinessStore(context.db).customer(input.id), evidence('customer', input.id)) });
  registry.register({ metadata: metadata('create_project', 'Create an idempotent local project for an existing customer.', 'projects:write', 'sqlite'),
    inputSchema: z.strictObject({ customerId: Id, name: label, metadata: metadataSchema }), resultSchema: ProjectRecordSchema,
    handler: (input, context) => {
      const store = new BusinessStore(context.db); store.customer(input.customerId);
      const id = `project-${context.executionId}`;
      context.db.prepare('INSERT INTO projects (id,customer_id,name,status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, input.customerId, input.name, 'PLANNED', JSON.stringify(input.metadata), context.now(), context.now());
      return value(store.project(id), evidence('project', id));
    } });
  registry.register({ metadata: metadata('get_project', 'Read a project and its persisted customer relationship.', 'projects:read'), inputSchema: IdInput, resultSchema: ProjectRecordSchema,
    handler: (input, context) => value(new BusinessStore(context.db).project(input.id), evidence('project', input.id)) });
  registry.register({ metadata: metadata('create_task', 'Create an idempotent checklist task linked to a real project.', 'tasks:write', 'sqlite'),
    inputSchema: z.strictObject({ projectId: Id, title: label, description: z.string().max(10000).default(''), metadata: metadataSchema }), resultSchema: TaskRecordSchema,
    handler: (input, context) => {
      const store = new BusinessStore(context.db); store.project(input.projectId);
      const id = `task-${context.executionId}`;
      context.db.prepare('INSERT INTO tasks (id,project_id,title,description,status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, input.projectId, input.title, input.description, 'PENDING', JSON.stringify(input.metadata), context.now(), context.now());
      return value(store.task(id), evidence('task', id));
    } });
  registry.register({ metadata: metadata('list_project_tasks', 'Read persisted tasks for an existing project.', 'tasks:read'), inputSchema: z.strictObject({ projectId: Id, limit: z.number().int().min(1).max(200).default(100) }), resultSchema: z.array(TaskRecordSchema),
    handler: (input, context) => { const tasks = new BusinessStore(context.db).tasks(input.projectId, input.limit); return { data: tasks, evidence: tasks.map((task) => evidence('task', task.id)) }; } });
  registry.register({ metadata: metadata('write_artifact', 'Write a source-referenced artifact inside the configured run workspace.', 'artifacts:write', 'filesystem'), inputSchema: ArtifactInputSchema, resultSchema: ArtifactResultSchema,
    handler: (input, context) => context.artifacts.write(input, context), reconcile: (input, context) => context.artifacts.write(input, context, true) });
  registry.register({ metadata: metadata('create_email_draft', 'Persist an email draft locally without contacting any email provider.', 'email:draft', 'sqlite'),
    inputSchema: z.strictObject({ customerId: Id, projectId: Id.nullable().default(null), recipient: z.email().max(254), subject: label.refine((subject) => !/[\r\n]/.test(subject), 'Subject must be a single line'), body: z.string().min(1).max(50000).refine((body) => body.trim().length > 0, 'Body must not be blank') }), resultSchema: EmailDraftRecordSchema,
    handler: (input, context) => {
      const store = new BusinessStore(context.db); store.customer(input.customerId);
      if (input.projectId !== null && store.project(input.projectId).customerId !== input.customerId) throw new ToolFault('CUSTOMER_PROJECT_MISMATCH', 'Project belongs to a different customer.');
      const id = `draft-${context.executionId}`;
      context.db.prepare('INSERT INTO email_drafts (id,customer_id,project_id,recipient,subject,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, input.customerId, input.projectId, input.recipient, input.subject, input.body, 'DRAFT', context.now(), context.now());
      return value(store.draft(id), evidence('draft', id));
    } });
  registry.register({ metadata: metadata('get_email_draft', 'Read the current material content and state of a persisted draft.', 'email:read'), inputSchema: IdInput, resultSchema: EmailDraftRecordSchema,
    handler: (input, context) => value(new BusinessStore(context.db).draft(input.id), evidence('draft', input.id)) });
  registry.register({ metadata: metadata('send_email', 'Queue an exactly approved draft in the local sandbox outbox only.', 'email:send', 'sqlite'),
    inputSchema: z.strictObject({ draftId: Id, approvalId: Id }), resultSchema: OutboxRecordSchema,
    handler: (input, context) => {
      const store = new BusinessStore(context.db);
      const draft = store.draft(input.draftId);
      if (draft.status !== 'DRAFT') throw new ToolFault('DRAFT_ALREADY_QUEUED', 'The draft has already been queued in the sandbox.');
      validateApproval(context, input.approvalId, canonicalSendAction(draft));
      const id = `outbox-${context.executionId}`;
      context.db.prepare('INSERT INTO sandbox_outbox (id,draft_id,approval_id,execution_id,recipient,subject,body,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, draft.id, input.approvalId, context.executionId, draft.recipient, draft.subject, draft.body, 'SANDBOX_QUEUED', context.now());
      context.db.prepare("UPDATE email_drafts SET status='QUEUED',updated_at=? WHERE id=?").run(context.now(), draft.id);
      return value(store.outbox(id), evidence('outbox', id, { transport: 'local_simulation', approvalId: input.approvalId }));
    } });
  registry.register({ metadata: metadata('get_outbox_message', 'Read a persisted sandbox message without attempting email delivery.', 'email:read'), inputSchema: IdInput, resultSchema: OutboxRecordSchema,
    handler: (input, context) => value(new BusinessStore(context.db).outbox(input.id), evidence('outbox', input.id)) });
  registry.register({ metadata: metadata('browser_open', 'Open a read-only browser session restricted to configured origins.', 'browser:read'), inputSchema: z.strictObject({ url: z.url().max(2048) }), resultSchema: z.strictObject({ sessionId: Id, url: z.url(), title: z.string().max(300) }),
    handler: async (input, context) => {
      if (!context.browser) throw new ToolFault('BROWSER_DISABLED', 'No browser adapter is configured.', 'PERMISSION');
      const data = await context.browser.open(JSON.stringify([context.runId, context.actorId]), input.url, context.signal);
      return value(data, evidence('browser', data.sessionId, { url: data.url }));
    } });
  registry.register({ metadata: metadata('browser_snapshot', 'Read bounded page text, headings, and links from an owned browser session.', 'browser:read'), inputSchema: z.strictObject({ sessionId: Id }), resultSchema: z.strictObject({ sessionId: Id, url: z.url(), title: z.string().max(300), text: z.string().max(10000), headings: z.array(z.string().max(300)).max(40), links: z.array(z.strictObject({ text: z.string().max(200), href: z.string().max(2048) })).max(40) }),
    handler: async (input, context) => {
      if (!context.browser) throw new ToolFault('BROWSER_DISABLED', 'No browser adapter is configured.', 'PERMISSION');
      const data = await context.browser.snapshot(JSON.stringify([context.runId, context.actorId]), input.sessionId);
      return value(data, evidence('browser', data.sessionId, { url: data.url, trust: 'untrusted_source' }));
    } });
  return registry;
}
