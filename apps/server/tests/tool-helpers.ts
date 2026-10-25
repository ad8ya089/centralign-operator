import { join, dirname } from 'node:path';
import { z } from 'zod';
import { ToolExecutor } from '../src/tools/executor.js';
import { createToolRegistry } from '../src/tools/catalog.js';
import { PERMISSION_SCOPES } from '../src/tools/contracts.js';
import type { ExecutionContext, ToolOutcome } from '../src/tools/contracts.js';
import { seedDemoData } from '../src/persistence/seed.js';
import { AT, insertRun, insertStep, testDatabase } from './helpers.js';

export function toolFixture() {
  const fixture = testDatabase();
  seedDemoData(fixture.db);
  insertRun(fixture.db, 'r1', 'RUNNING');
  insertStep(fixture.db, 's1', 'r1', 0, 'RUNNING');
  const registry = createToolRegistry();
  const workspace = join(dirname(fixture.path), 'workspace');
  const executor = new ToolExecutor(fixture.db, registry, workspace);
  const context = (key: string | null = null, overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({ runId: 'r1', stepId: 's1', actorId: 'test-operator', grantedScopes: PERMISSION_SCOPES, idempotencyKey: key, deadline: Date.parse(AT) + 60000, clock: () => new Date(AT), ...overrides });
  return { ...fixture, registry, executor, workspace, context };
}
export function success<T>(result: ToolOutcome, schema: z.ZodType<T>): T {
  if (!result.ok) throw new Error(`${result.error.category}: ${result.error.code}: ${result.error.message}`);
  return schema.parse(result.data);
}
