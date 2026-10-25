import { loadConfig } from '../config/env.js';
import { openDatabase, closeDatabase } from '../persistence/database.js';

try {
  const config = loadConfig();
  const db = openDatabase(config.DATABASE_PATH);
  try {
    const migrations = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
    console.info(JSON.stringify({ status: 'current', migrations }));
  } finally { closeDatabase(db); }
} catch {
  console.error('Migration failed. Check Node 24, .env values, database access, and migration history.');
  process.exitCode = 1;
}
