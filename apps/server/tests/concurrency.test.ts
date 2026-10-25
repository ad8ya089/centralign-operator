import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../src/config/paths.js';
import { toolFixture } from './tool-helpers.js';

it('reconciles simultaneous requests across independent Node processes and SQLite connections', async () => {
  const fixture = toolFixture();
  try {
    const contend = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./tool-contender.ts', import.meta.url)), fixture.path, fixture.workspace], { cwd: REPOSITORY_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let errors = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => { if (code === 0) resolve(output.trim()); else reject(new Error(`Contender failed (${code}): ${errors}`)); });
    });
    const results = await Promise.all([contend(), contend(), contend()]);
    const parsed = results.map((result) => JSON.parse(result) as { id: string; replayed: boolean });
    expect(new Set(parsed.map((result) => result.id)).size).toBe(1);
    expect(parsed.filter((result) => !result.replayed)).toHaveLength(1);
    expect(fixture.db.prepare('SELECT count(*) AS count FROM projects').get()).toEqual({ count: 1 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM tool_executions WHERE idempotency_key=?').get('cross-process-key')).toEqual({ count: 1 });
  } finally { fixture.cleanup(); }
}, 20000);
