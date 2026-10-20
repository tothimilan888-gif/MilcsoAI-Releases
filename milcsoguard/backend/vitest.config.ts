import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Tests share one PostgreSQL test database and reset it between files.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    setupFiles: ['tests/setup-env.ts'],
  },
});
