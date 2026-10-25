import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { applyMigrations } from '../src/persistence/migrate.js';
import { migrations } from '../src/persistence/migrations/index.js';
import { AT, insertRun, insertStep } from './helpers.js';

it('upgrades a real Phase 2 schema without losing any old event, run, step, or migration checksum', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.pragma('recursive_triggers=ON');
  try {
    expect(applyMigrations(db, migrations.slice(0, 2))).toEqual([1, 2]); insertRun(db); insertStep(db);
    const insert = db.prepare('INSERT INTO run_events(id,run_id,step_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)');
    insert.run('event-b', 'r1', null, 'RUN_CREATED', '{"legacy":true}', AT); insert.run('event-a', 'r1', 's1', 'STEP_CREATED', '{}', AT);
    const events = db.prepare('SELECT * FROM run_events ORDER BY rowid').all(); const history = db.prepare('SELECT * FROM schema_migrations').all();
    expect(applyMigrations(db)).toEqual([3]); expect(db.prepare('SELECT id,run_id,step_id,event_type,payload_json,created_at FROM run_events ORDER BY sequence').all()).toEqual(events);
    expect(db.prepare('SELECT * FROM schema_migrations WHERE version<3').all()).toEqual(history);
    expect(db.prepare('SELECT objective FROM runs').get()).toEqual({ objective: 'Fictional onboarding' }); expect(db.prepare('SELECT id FROM run_steps').get()).toEqual({ id: 's1' });
    expect(() => db.prepare("UPDATE run_events SET payload_json='{}'").run()).toThrow('append-only'); expect(() => db.prepare('DELETE FROM run_events').run()).toThrow('append-only');
    expect(() => insert.run('new', 'r1', null, 'UNRECOGNIZED', '{}', AT)).toThrow(); expect(applyMigrations(db)).toEqual([]); expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { db.close(); }
});
