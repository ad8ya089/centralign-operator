import { join } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { DEFAULT_DATABASE_PATH, REPOSITORY_ROOT, resolveDatabasePath } from './paths.js';

export const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_PATH: z.string().trim().min(1).default(DEFAULT_DATABASE_PATH),
});
export type AppConfig = z.infer<typeof EnvironmentSchema>;

export function parseEnvironment(environment: Record<string, string | undefined>, root = REPOSITORY_ROOT): AppConfig {
  const parsed = EnvironmentSchema.parse(environment);
  return { ...parsed, DATABASE_PATH: resolveDatabasePath(parsed.DATABASE_PATH, root) };
}

export function loadConfig(root = REPOSITORY_ROOT): AppConfig {
  // Explicit env wins. Use a local object so config loading has no global mutation.
  const environment = { ...process.env };
  const result = dotenv.config({ path: join(root, '.env'), processEnv: environment, quiet: true });
  if (result.error && (!('code' in result.error) || result.error.code !== 'ENOENT')) throw result.error;
  return parseEnvironment(environment, root);
}
