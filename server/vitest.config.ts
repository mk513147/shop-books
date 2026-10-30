import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Integration tests share one dedicated test database; run files one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
