import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['worker/test/**/*.test.ts', 'ui/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
  },
});
