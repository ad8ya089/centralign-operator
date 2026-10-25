import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseEnvironment } from '../src/config/env.js';
import { findRepositoryRoot, REPOSITORY_ROOT, resolveDatabasePath } from '../src/config/paths.js';
import { temporaryDirectory } from './helpers.js';
import { assertSupportedRuntime } from '../src/config/runtime.js';

describe('root-aware configuration', () => {
  it('rejects unsupported runtimes before opening a native database', () => {
    expect(() => assertSupportedRuntime('22.13.1')).toThrow('Node 24.x');
    expect(() => assertSupportedRuntime('24.0.0')).not.toThrow();
    expect(() => assertSupportedRuntime('25.0.0')).toThrow('Node 24.x');
  });
  it('uses safe defaults and validates environment values', () => {
    expect(parseEnvironment({})).toMatchObject({ HOST: '127.0.0.1', PORT: 3001, NODE_ENV: 'development', LOG_LEVEL: 'info', DATABASE_PATH: join(REPOSITORY_ROOT, '.data', 'centralign.sqlite') });
    for (const values of [{ PORT: '0' }, { PORT: '65536' }, { PORT: 'abc' }, { PORT: '1.5' }, { LOG_LEVEL: 'verbose' }, { NODE_ENV: 'staging' }, { HOST: ' ' }, { DATABASE_PATH: '' }]) expect(() => parseEnvironment(values)).toThrow();
  });
  it('defaults browser navigation to deny and validates exact origin configuration', () => {
    expect(parseEnvironment({}).BROWSER_ALLOWED_ORIGINS).toEqual([]);
    expect(parseEnvironment({ BROWSER_ALLOWED_ORIGINS: 'http://127.0.0.1:4321,https://example.test' }).BROWSER_ALLOWED_ORIGINS).toEqual(['http://127.0.0.1:4321', 'https://example.test']);
    expect(() => parseEnvironment({ BROWSER_ALLOWED_ORIGINS: 'file:///secret' })).toThrow();
    expect(() => parseEnvironment({ BROWSER_ALLOWED_ORIGINS: 'https://example.test/path' })).toThrow();
    expect(parseEnvironment({ ARTIFACT_WORKSPACE_PATH: 'state/workspace' }).ARTIFACT_WORKSPACE_PATH).toBe(join(REPOSITORY_ROOT, 'state', 'workspace'));
  });

  it('finds the same root from source and compiled locations and resolves portable paths', () => {
    const directory = temporaryDirectory();
    try {
      writeFileSync(join(directory.path, 'package.json'), JSON.stringify({ name: 'centralign-operator', workspaces: ['apps/*', 'packages/*'] }));
      for (const location of ['src', 'dist']) {
        const nested = join(directory.path, 'apps', 'server', location, 'config');
        mkdirSync(nested, { recursive: true });
        expect(findRepositoryRoot(nested)).toBe(directory.path);
      }
      expect(resolveDatabasePath('state/db.sqlite', directory.path)).toBe(join(directory.path, 'state', 'db.sqlite'));
      const absolute = join(directory.path, 'external.sqlite');
      expect(resolveDatabasePath(absolute, REPOSITORY_ROOT)).toBe(absolute);
    } finally { directory.cleanup(); }
  });

  it('loads .env from an explicit root without modifying process.env', () => {
    const directory = temporaryDirectory();
    try {
      writeFileSync(join(directory.path, '.env'), 'DATABASE_PATH=custom/test.sqlite\n');
      const previous = process.env['DATABASE_PATH'];
      expect(loadConfig(directory.path).DATABASE_PATH).toBe(previous ? resolveDatabasePath(previous, directory.path) : join(directory.path, 'custom', 'test.sqlite'));
      expect(process.env['DATABASE_PATH']).toBe(previous);
    } finally { directory.cleanup(); }
  });
});
