import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, SQLITE_BUSY_TIMEOUT_MS } from '../src/persistence/database.js';
import { applyMigrations } from '../src/persistence/migrate.js';
import { migrations } from '../src/persistence/migrations/index.js';
import { resolveDatabasePath } from '../src/config/paths.js';
import { AT, insertRun, insertStep, insertTool, temporaryDirectory, testDatabase } from './helpers.js';

describe('SQLite foundation', () => {
  let fixture: ReturnType<typeof testDatabase>;
  beforeEach(() => { fixture = testDatabase(); });
  afterEach(() => { fixture.cleanup(); });

  it('creates all versioned tables and safely reapplies migrations', () => {
    const { db } = fixture;
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([
      'approvals', 'artifacts', 'company_documents', 'memory_entries', 'run_events', 'run_steps', 'runs', 'schema_migrations', 'tool_executions',
    ].map((name) => ({ name })));
    const before = db.prepare('SELECT * FROM schema_migrations').all();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ version: 1, name: 'foundation' });
    expect(applyMigrations(db)).toEqual([]);
    expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual(before);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(SQLITE_BUSY_TIMEOUT_MS);
  });

  it('enforces run foreign keys and same-run step relationships', () => {
    expect(() => insertStep(fixture.db)).toThrow(/FOREIGN KEY/);
    insertRun(fixture.db);
    insertRun(fixture.db, 'r2');
    insertStep(fixture.db);
    expect(() => insertTool(fixture.db, 't1', 'key', 'r2')).toThrow(/FOREIGN KEY/);
    expect(() => fixture.db.prepare('DELETE FROM runs WHERE id = ?').run('r1')).toThrow(/FOREIGN KEY/);
  });

  it('enforces stable step indexes and globally unique tool idempotency keys', () => {
    insertRun(fixture.db); insertStep(fixture.db); insertTool(fixture.db);
    expect(() => insertStep(fixture.db, 's2')).toThrow(/UNIQUE/);
    expect(() => insertTool(fixture.db, 't2')).toThrow(/UNIQUE/);
    expect(fixture.db.prepare('SELECT count(*) AS count FROM tool_executions').get()).toEqual({ count: 1 });
  });

  it('rejects invalid run, step, tool, approval, and memory states', () => {
    expect(() => insertRun(fixture.db, 'bad', 'SUCCEEDED')).toThrow(/CHECK/);
    insertRun(fixture.db);
    expect(() => insertStep(fixture.db, 'bad', 'r1', 0, 'COMPLETED')).toThrow(/CHECK/);
    insertStep(fixture.db);
    expect(() => insertTool(fixture.db, 'bad', 'bad-key', 'r1', 'UNKNOWN')).toThrow(/CHECK/);
    expect(() => fixture.db.prepare('INSERT INTO approvals (id, run_id, action_json, policy_reason, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)').run('a1', 'r1', '{}', 'Test', 'GRANTED', AT)).toThrow(/CHECK/);
    expect(() => fixture.db.prepare('INSERT INTO memory_entries (id, scope, content, source_references_json, trust_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'COMPANY', 'Test', '[]', 'TRUSTED', AT, AT)).toThrow(/CHECK/);
  });

  it('rejects malformed JSON, incorrect JSON shape, and unreviewed approved memories', () => {
    insertRun(fixture.db);
    for (const json of ['{broken', '[]', 'null']) expect(() => fixture.db.prepare('UPDATE runs SET metadata_json = ? WHERE id = ?').run(json, 'r1')).toThrow();
    expect(() => fixture.db.prepare('INSERT INTO memory_entries (id, scope, content, source_references_json, trust_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'COMPANY', 'Test', '[]', 'APPROVED', AT, AT)).toThrow(/CHECK/);
  });

  it('protects events from updates, deletes, and replacement inserts', () => {
    const { db } = fixture;
    insertRun(db);
    const args = ['e1', 'r1', 'RUN_CREATED', '{}', AT];
    db.prepare('INSERT INTO run_events (id, run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(...args);
    expect(() => db.prepare('UPDATE run_events SET payload_json = ? WHERE id = ?').run('{"altered":true}', 'e1')).toThrow('append-only');
    expect(() => db.prepare('DELETE FROM run_events WHERE id = ?').run('e1')).toThrow('append-only');
    expect(() => db.prepare('INSERT OR REPLACE INTO run_events (id, run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(...args)).toThrow('append-only');
    expect(db.prepare('SELECT payload_json FROM run_events WHERE id = ?').get('e1')).toEqual({ payload_json: '{}' });
  });

  it('rejects edited migration history', () => {
    const edited = migrations.map((migration) => ({ ...migration, sql: `${migration.sql}\n-- changed` }));
    expect(() => applyMigrations(fixture.db, edited)).toThrow('Migration history mismatch');
    expect(fixture.db.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({ count: 1 });
  });

  it('keeps temporary databases isolated and supports repeated close', () => {
    const other = testDatabase();
    try {
      insertRun(fixture.db);
      expect(other.path).not.toBe(fixture.path);
      expect(fixture.path).not.toBe(resolveDatabasePath());
      expect(other.db.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 0 });
      closeDatabase(fixture.db); closeDatabase(fixture.db);
      expect(fixture.db.open).toBe(false);
      expect(other.db.prepare('SELECT 1 AS connected').get()).toEqual({ connected: 1 });
    } finally { other.cleanup(); }
  });
});

it('rolls back both DDL and migration records after a partially applied batch fails', () => {
  const directory = temporaryDirectory();
  const db = new Database(join(directory.path, 'rollback.sqlite'));
  try {
    expect(() => applyMigrations(db, [...migrations, { version: 2, name: 'broken', sql: 'CREATE TABLE transient_table (id TEXT); INSERT INTO missing_table VALUES (1);' }])).toThrow(/missing_table/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    expect(applyMigrations(db)).toEqual([1]);
  } finally { closeDatabase(db); directory.cleanup(); }
});
