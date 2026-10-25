import type Database from 'better-sqlite3';
import { z } from 'zod';
import { CustomerRecordSchema, EmailDraftRecordSchema, OutboxRecordSchema, ProjectRecordSchema, TaskRecordSchema, parseStoredJson, JsonObjectSchema } from '@centralign/shared';
import { normalizeName } from '../context/knowledge.js';
import { notFound } from './errors.js';

function parseRow<T>(schema: z.ZodType<T>, row: unknown): T {
  if (!row) return notFound('Record');
  const values = z.record(z.string(), z.unknown()).parse(row);
  if ('metadata' in values) values['metadata'] = parseStoredJson(z.string().parse(values['metadata']), JsonObjectSchema);
  return schema.parse(values);
}

const customerColumns = 'id,company_name AS companyName,normalized_name AS normalizedName,contact_name AS contactName,contact_email AS contactEmail,status,metadata_json AS metadata,created_at AS createdAt,updated_at AS updatedAt';
const projectColumns = 'id,customer_id AS customerId,name,status,metadata_json AS metadata,created_at AS createdAt,updated_at AS updatedAt';
const taskColumns = 'id,project_id AS projectId,title,description,status,metadata_json AS metadata,created_at AS createdAt,updated_at AS updatedAt';
const draftColumns = 'id,customer_id AS customerId,project_id AS projectId,recipient,subject,body,status,created_at AS createdAt,updated_at AS updatedAt';
const outboxColumns = 'id,draft_id AS draftId,approval_id AS approvalId,execution_id AS executionId,recipient,subject,body,status,created_at AS createdAt';

export class BusinessStore {
  constructor(private readonly db: Database.Database) {}
  customer(id: string) { return parseRow(CustomerRecordSchema, this.db.prepare(`SELECT ${customerColumns} FROM customers WHERE id=?`).get(id)); }
  project(id: string) { return parseRow(ProjectRecordSchema, this.db.prepare(`SELECT ${projectColumns} FROM projects WHERE id=?`).get(id)); }
  draft(id: string) { return parseRow(EmailDraftRecordSchema, this.db.prepare(`SELECT ${draftColumns} FROM email_drafts WHERE id=?`).get(id)); }
  outbox(id: string) { return parseRow(OutboxRecordSchema, this.db.prepare(`SELECT ${outboxColumns} FROM sandbox_outbox WHERE id=?`).get(id)); }
  task(id: string) { return parseRow(TaskRecordSchema, this.db.prepare(`SELECT ${taskColumns} FROM tasks WHERE id=?`).get(id)); }
  tasks(projectId: string, limit = 100) {
    this.project(projectId);
    return this.db.prepare(`SELECT ${taskColumns} FROM tasks WHERE project_id=? ORDER BY created_at,id LIMIT ?`).all(projectId, limit).map((row) => parseRow(TaskRecordSchema, row));
  }
  searchCustomers(query: string, limit: number) {
    const normalized = normalizeName(query);
    const count = z.object({ count: z.number() }).parse(this.db.prepare('SELECT count(*) AS count FROM customers WHERE instr(normalized_name,?)>0 OR lower(contact_email)=?').get(normalized, query.toLowerCase())).count;
    const candidates = this.db.prepare(`SELECT ${customerColumns} FROM customers WHERE instr(normalized_name,?)>0 OR lower(contact_email)=? ORDER BY normalized_name,id LIMIT ?`).all(normalized, query.toLowerCase(), limit).map((row) => parseRow(CustomerRecordSchema, row));
    return { resolution: count === 0 ? 'NONE' as const : count === 1 ? 'UNIQUE' as const : 'AMBIGUOUS' as const, matchCount: count, candidates };
  }
}
