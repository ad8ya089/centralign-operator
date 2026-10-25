import { join } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { isLoopbackHost } from '@centralign/shared';
import { DEFAULT_DATABASE_PATH, REPOSITORY_ROOT, resolveDatabasePath } from './paths.js';

const OriginSchema = z.string().refine((value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { return false; }
}, 'Browser entries must be exact HTTP(S) origins');

export const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().refine(isLoopbackHost, 'HOST must be an explicit loopback address or localhost').transform((value) => value === '[::1]' ? '::1' : value.toLowerCase()).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_PATH: z.string().trim().min(1).default(DEFAULT_DATABASE_PATH),
  ARTIFACT_WORKSPACE_PATH: z.string().trim().min(1).default('.data/workspaces'),
  BROWSER_ALLOWED_ORIGINS: z.string().default('').transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)).pipe(z.array(OriginSchema)),
  MODEL_PROVIDER: z.enum(['gemini', 'openai']).default('gemini'),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  GEMINI_MODEL: z.string().trim().min(1).max(100).default('gemini-3.8-flash'),
  MODEL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).optional(),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_MODEL: z.string().trim().min(1).max(100).default('gpt-6-sol'),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(30000),
  AGENT_MAX_MODEL_CALLS: z.coerce.number().int().min(1).max(200).default(40),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(200).default(60),
  AGENT_MAX_RECOVERY_ATTEMPTS: z.coerce.number().int().min(0).max(5).default(2),
  AGENT_MAX_REPLANS: z.coerce.number().int().min(0).max(20).default(4),
  AGENT_RUN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(86400000).default(1800000),
});
export type AppConfig = z.infer<typeof EnvironmentSchema>;

export function parseEnvironment(environment: Record<string, string | undefined>, root = REPOSITORY_ROOT): AppConfig {
  const parsed = EnvironmentSchema.parse(environment);
  return { ...parsed, DATABASE_PATH: resolveDatabasePath(parsed.DATABASE_PATH, root), ARTIFACT_WORKSPACE_PATH: resolveDatabasePath(parsed.ARTIFACT_WORKSPACE_PATH, root) };
}

export function loadConfig(root = REPOSITORY_ROOT): AppConfig {
  // Explicit env wins. Use a local object so config loading has no global mutation.
  const environment = { ...process.env };
  const result = dotenv.config({ path: join(root, '.env'), processEnv: environment, quiet: true });
  if (result.error && (!('code' in result.error) || result.error.code !== 'ENOENT')) throw result.error;
  return parseEnvironment(environment, root);
}
