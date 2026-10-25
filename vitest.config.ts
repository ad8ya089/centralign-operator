import './scripts/check-runtime.mjs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/shared/tests/**/*.test.ts', 'apps/server/tests/**/*.test.ts', 'apps/web/src/lib/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    // SDK/native imports plus Chromium exhaust this local Windows host when
    // every file gets a worker. Keep file parallelism and the process pool;
    // the explicit three-process idempotency race remains independently tested.
    maxWorkers: 4,
  },
});
