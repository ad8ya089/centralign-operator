import Database from 'better-sqlite3';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../src/persistence/database.js';
import { applyMigrations } from '../src/persistence/migrate.js';
import { migrations } from '../src/persistence/migrations/index.js';
import { seedDemoData } from '../src/persistence/seed.js';
import { AT, insertRun, temporaryDirectory, testDatabase } from './helpers.js';

describe('Phase 2 additive persistence', () => {
  it('upgrades a real Phase 1 file without losing its data or checksum history', () => {
    const directory = temporaryDirectory();
    const path = join(directory.path, 'upgrade.sqlite');
    let db = new Database(path);
    try {
      applyMigrations(db, migrations.slice(0, 1)); insertRun(db, 'preserved');
      const original = db.prepare('SELECT * FROM schema_migrations WHERE version=1').get();
      closeDatabase(db); db = openDatabase(path);
      expect(db.prepare('SELECT objective,status FROM runs WHERE id=?').get('preserved')).toEqual({ objective: 'Fictional onboarding', status: 'CREATED' });
      expect(db.prepare('SELECT * FROM schema_migrations WHERE version=1').get()).toEqual(original);
      expect(db.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({ count: migrations.length });
      expect(applyMigrations(db)).toEqual([]);
      expect(seedDemoData(db).insertedCustomers).toBe(1);
    } finally { closeDatabase(db); directory.cleanup(); }
  });

  it('enforces business and document foreign keys, unique identities, and states', () => {
    const fixture = testDatabase(); const { db } = fixture;
    try {
      seedDemoData(db);
      const project = db.prepare('INSERT INTO projects (id,customer_id,name,status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
      expect(() => project.run('p1', 'missing', 'Onboarding', 'PLANNED', '{}', AT, AT)).toThrow(/FOREIGN KEY/);
      expect(() => project.run('p1', 'customer-acme-logistics', 'Onboarding', 'INVALID', '{}', AT, AT)).toThrow(/CHECK/);
      project.run('p1', 'customer-acme-logistics', 'Onboarding', 'PLANNED', '{}', AT, AT);
      expect(() => project.run('p1', 'customer-acme-logistics', 'Duplicate', 'PLANNED', '{}', AT, AT)).toThrow(/UNIQUE/);
      const task = db.prepare('INSERT INTO tasks (id,project_id,title,description,status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
      expect(() => task.run('t1', 'missing', 'Questionnaire', '', 'PENDING', '{}', AT, AT)).toThrow(/FOREIGN KEY/);
      expect(() => task.run('t1', 'p1', 'Questionnaire', '', 'DONE', '{}', AT, AT)).toThrow(/CHECK/);
      task.run('t1', 'p1', 'Questionnaire', '', 'PENDING', '{}', AT, AT);
      expect(() => db.prepare('UPDATE customers SET status=?').run('FINISHED')).toThrow(/CHECK/);
      expect(() => db.prepare('INSERT INTO document_chunks (id,document_id,chunk_index,heading,content,content_hash) VALUES (?,?,?,?,?,?)').run('c1', 'missing', 0, null, 'text', 'a'.repeat(64))).toThrow(/FOREIGN KEY/);
      expect(() => db.prepare('DELETE FROM company_documents WHERE id=?').run('doc-security-policy')).toThrow(/FOREIGN KEY/);
      expect(() => db.prepare('INSERT INTO email_drafts (id,customer_id,project_id,recipient,subject,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('d1', 'customer-acme-logistics', 'missing', 'demo@example.test', 'Subject', 'Body', 'DRAFT', AT, AT)).toThrow(/FOREIGN KEY/);
      expect(() => db.prepare('INSERT INTO sandbox_outbox (id,draft_id,approval_id,execution_id,recipient,subject,body,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('o1', 'missing', 'missing', 'missing', 'demo@example.test', 'Subject', 'Body', 'SANDBOX_QUEUED', AT)).toThrow(/FOREIGN KEY/);
    } finally { fixture.cleanup(); }
  });
});
