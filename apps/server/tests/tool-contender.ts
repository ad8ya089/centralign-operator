// Invoked only by the concurrency test against its explicitly supplied disposable database.
import { openDatabase, closeDatabase } from '../src/persistence/database.js';
import { createToolRegistry } from '../src/tools/catalog.js';
import { ToolExecutor } from '../src/tools/executor.js';

const [databasePath, workspace] = process.argv.slice(2);
if (!databasePath || !workspace || !databasePath.includes('centralign-test-')) throw new Error('Expected an isolated test database and workspace');
const db = openDatabase(databasePath);
try {
  const executor = new ToolExecutor(db, createToolRegistry(), workspace);
  const result = await executor.execute('create_project', { customerId: 'customer-acme-logistics', name: 'Cross-process project' }, { runId: 'r1', stepId: 's1', actorId: 'test-operator', grantedScopes: ['projects:write'], idempotencyKey: 'cross-process-key', deadline: Date.now() + 10000 });
  if (!result.ok) { console.error(JSON.stringify(result)); process.exitCode = 1; }
  else console.info(JSON.stringify({ id: result.executionId, replayed: result.replayed }));
} finally { closeDatabase(db); }
