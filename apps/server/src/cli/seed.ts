import { loadConfig } from '../config/env.js';
import { openDatabase, closeDatabase } from '../persistence/database.js';
import { seedDemoData } from '../persistence/seed.js';

try {
  const db = openDatabase(loadConfig().DATABASE_PATH);
  try { console.info(JSON.stringify({ status: 'seeded', ...seedDemoData(db) })); }
  finally { closeDatabase(db); }
} catch (error) {
  console.error(error instanceof Error && error.name === 'ToolFault' ? error.message : 'Seed failed; check fixtures, Node 24, and database configuration.');
  process.exitCode = 1;
}
