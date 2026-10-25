import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk from this module, never process.cwd(); src/ and dist/ resolve the same root. */
export function findRepositoryRoot(startDirectory = dirname(fileURLToPath(import.meta.url))): string {
  let directory = resolve(startDirectory);
  while (true) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const candidate: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof candidate === 'object' && candidate !== null && 'name' in candidate && candidate.name === 'centralign-operator' && 'workspaces' in candidate && Array.isArray(candidate.workspaces)) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot locate the CentrAlign repository root from the application module');
    directory = parent;
  }
}

export const REPOSITORY_ROOT = findRepositoryRoot();
export const DEFAULT_DATABASE_PATH = '.data/centralign.sqlite';

export function resolveDatabasePath(configuredPath = DEFAULT_DATABASE_PATH, root = REPOSITORY_ROOT): string {
  if (configuredPath.trim().length === 0 || configuredPath === ':memory:' || configuredPath.startsWith('file:')) throw new Error('DATABASE_PATH must be a nonempty filesystem path');
  return isAbsolute(configuredPath) ? resolve(configuredPath) : resolve(root, configuredPath);
}
