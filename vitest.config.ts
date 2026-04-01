import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Native addons (better-sqlite3) require forked child processes,
    // not worker_threads (the vitest default).
    pool: 'forks',
    // Auto-cleanup after each test
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/mcp-server.ts'], // CLI entry point, tested via integration
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 75,
        lines: 75,
      },
    },
  },
});
