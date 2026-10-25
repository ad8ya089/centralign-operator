import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { resolveDatabasePath } from '../config/paths.js';
import { applyMigrations } from './migrate.js';
import { assertSupportedRuntime } from '../config/runtime.js';

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export function openDatabase(databasePath?: string): Database.Database {
  assertSupportedRuntime();
  const path = resolveDatabasePath(databasePath);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('recursive_triggers = ON');
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    applyMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function closeDatabase(db: Database.Database): void {
  if (db.open) db.close();
}

export function checkDatabase(db: Database.Database): boolean {
  // Query the migration ledger as well as the connection; a missing schema is unhealthy.
  const row: unknown = db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
  return typeof row === 'object' && row !== null && 'version' in row && typeof row.version === 'number' && row.version >= 1;
}
