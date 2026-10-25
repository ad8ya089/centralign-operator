// Diagnostic intentionally has no runtime guard: it can compare installed Node runtimes.
// It never opens the application database.
import Database from 'better-sqlite3';

console.info(JSON.stringify({ phase: 'imported', node: process.version, platform: process.platform, arch: process.arch, abi: process.versions.modules }));
const db = new Database(':memory:');
try {
  console.info(JSON.stringify({ phase: 'opened', sqlite: db.prepare('SELECT sqlite_version() AS version').get() }));
  db.exec('CREATE TEMP TABLE smoke (value TEXT NOT NULL)');
  db.prepare('INSERT INTO smoke (value) VALUES (?)').run('isolated-check');
  console.info(JSON.stringify({ phase: 'queried', row: db.prepare('SELECT value FROM smoke').get(), fts5: db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get() }));
} finally {
  db.close();
  console.info(JSON.stringify({ phase: 'closed', open: db.open }));
}
