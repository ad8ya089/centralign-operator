import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../src/config/paths.js';

it('contains configuration failures in the live smoke CLI without echoing invalid values', () => {
  const secret = `AQ.${'U'.repeat(44)}`;
  const result = spawnSync(process.execPath, [join(REPOSITORY_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(REPOSITORY_ROOT, 'apps/server/src/cli/model-smoke.ts')], { cwd: REPOSITORY_ROOT, env: { ...process.env, MODEL_PROVIDER: secret }, encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(1); expect(result.stdout + result.stderr).not.toContain(secret);
  expect(JSON.parse(result.stderr.trim())).toMatchObject({ provider: 'unconfigured', model: null, status: 'FAILED', category: 'CONFIGURATION', businessToolsCalled: 0 });
});
