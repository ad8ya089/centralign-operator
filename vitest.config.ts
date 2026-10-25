import './scripts/check-runtime.mjs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/shared/tests/**/*.test.ts', 'apps/server/tests/**/*.test.ts', 'apps/web/src/lib/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
