import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { UtcTimestampSchema } from '@centralign/shared';
import { migrations } from './migrations/index.js';
import type { Migration } from './migrations/index.js';

const AppliedMigrationSchema = z.strictObject({
  version: z.number().int().positive(), name: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/), applied_at: UtcTimestampSchema,
});
const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

export function applyMigrations(db: Database.Database, available: readonly Migration[] = migrations): number[] {
  const ordered = [...available].sort((a, b) => a.version - b.version);
  if (ordered.some((migration, index) => migration.version !== index + 1 || migration.name.trim().length === 0)) throw new Error('Migration versions must be unique and contiguous, starting at 1');
  // A write lock covers validation, DDL, and ledger writes, including concurrent startup.
  return db.transaction(() => {
    // Only the migration ledger is bootstrapped; application DDL is versioned below.
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL
    ) STRICT`);
    const rows = z.array(AppliedMigrationSchema).parse(db.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all());
    for (const [index, row] of rows.entries()) {
      const expected = ordered[index];
      if (!expected || row.version !== expected.version || row.name !== expected.name || row.checksum !== checksum(expected.sql)) throw new Error(`Migration history mismatch at version ${row.version}; applied migrations must not be edited`);
    }
    const applied: number[] = [];
    const insert = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');
    for (const migration of ordered.slice(rows.length)) {
      db.exec(migration.sql); // Trusted, immutable source SQL; never user input.
      insert.run(migration.version, migration.name, checksum(migration.sql), new Date().toISOString());
      applied.push(migration.version);
    }
    return applied;
  }).immediate();
}
