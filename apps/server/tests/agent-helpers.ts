import { dirname, join } from 'node:path';
import { createApp } from '../src/app.js';
import { parseEnvironment } from '../src/config/env.js';
import { seedDemoData } from '../src/persistence/seed.js';
import { RunService } from '../src/agent/run-service.js';
import type { RunServiceOptions } from '../src/agent/run-service.js';
import { testDatabase } from './helpers.js';

export function agentFixture(options: RunServiceOptions = {}, environment: Record<string, string> = {}) {
  const fixture = testDatabase(); seedDemoData(fixture.db);
  const workspace = join(dirname(fixture.path), 'agent-workspace');
  const config = parseEnvironment({ NODE_ENV: 'test', DATABASE_PATH: fixture.path, ARTIFACT_WORKSPACE_PATH: workspace, ...environment });
  const app = createApp({ database: fixture.db, config, logging: false, agent: options });
  const service = app.getDecorator<RunService>('runService');
  return { ...fixture, workspace, config, app, service, close: async () => { await app.close(); fixture.cleanup(); } };
}
