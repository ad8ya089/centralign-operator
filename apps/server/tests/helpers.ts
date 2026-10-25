import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { closeDatabase, openDatabase } from '../src/persistence/database.js';

export const AT = '2026-10-25T10:00:00.000Z';
export function temporaryDirectory(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'centralign-test-'));
  return { path, cleanup: () => {
    const withinTemp = relative(tmpdir(), path);
    if (isAbsolute(withinTemp) || withinTemp.startsWith('..') || !withinTemp.startsWith('centralign-test-')) throw new Error('Refusing to clean an unexpected test path');
    rmSync(path, { recursive: true, force: true });
  } };
}
export function testDatabase() {
  const directory = temporaryDirectory();
  const path = join(directory.path, 'nested', 'test.sqlite');
  const db = openDatabase(path);
  return { db, path, cleanup: () => { closeDatabase(db); directory.cleanup(); } };
}
export function insertRun(db: Database.Database, id = 'r1', status = 'CREATED'): void {
  db.prepare('INSERT INTO runs (id, objective, status, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'Fictional onboarding', status, AT, AT, '{}');
}
export function insertStep(db: Database.Database, id = 's1', runId = 'r1', index = 0, status = 'PENDING'): void {
  db.prepare('INSERT INTO run_steps (id, run_id, step_index, description, status, input_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, runId, index, 'Check prerequisites', status, '{}', AT, AT);
}
export function insertTool(db: Database.Database, id = 't1', key = 'stable-key', runId = 'r1', status = 'PENDING'): void {
  db.prepare('INSERT INTO tool_executions (id, run_id, step_id, tool_name, idempotency_key, arguments_json, status, attempt_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, runId, 's1', 'future.tool', key, '{}', status, 1, AT, AT);
}
