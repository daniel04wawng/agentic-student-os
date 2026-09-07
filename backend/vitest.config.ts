import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve the shared workspace package to its TS source so unit tests run
// without a prior build step. Runtime (node dist/) still uses the built package.
export default defineConfig({
  resolve: {
    alias: {
      '@student-os/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
