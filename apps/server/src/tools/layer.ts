import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/env.js';
import { RestrictedBrowser } from '../browser/adapter.js';
import { createToolRegistry } from './catalog.js';
import { ToolExecutor } from './executor.js';

/** Server-only composition. Caller owns db and must close the layer's ephemeral browser resources. */
export function createToolLayer(db: Database.Database, config: AppConfig) {
  const browser = new RestrictedBrowser(config.BROWSER_ALLOWED_ORIGINS);
  const registry = createToolRegistry();
  const executor = new ToolExecutor(db, registry, config.ARTIFACT_WORKSPACE_PATH, browser);
  return { registry, executor, close: () => browser.close() };
}
