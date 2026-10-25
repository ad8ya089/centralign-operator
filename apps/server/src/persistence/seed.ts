import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { REPOSITORY_ROOT } from '../config/paths.js';
import { indexCompanyDocuments, normalizeName } from '../context/knowledge.js';

export function seedDemoData(db: Database.Database, fixtureRoot = join(REPOSITORY_ROOT, 'fixtures', 'company'), now = new Date().toISOString()) {
  return db.transaction(() => {
    const indexedDocuments = indexCompanyDocuments(db, fixtureRoot, undefined, now);
    const result = db.prepare(`INSERT INTO customers (id,company_name,normalized_name,contact_name,contact_email,status,metadata_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run('customer-acme-logistics', 'Acme Logistics', normalizeName('Acme Logistics'), 'Mira Sen', 'mira.sen@acme-logistics.example.test', 'BLOCKED', JSON.stringify({ fictional: true, securityQuestionnaire: 'missing', billingContact: null, sourceDocumentId: 'doc-acme-notes' }), now, now);
    return { insertedCustomers: result.changes, indexedDocuments };
  }).immediate();
}
