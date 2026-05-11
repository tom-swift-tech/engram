import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Native addons (better-sqlite3) require forked child processes,
    // not worker_threads (the vitest default).
    pool: 'forks',
    // integrations/* are subprojects with their own vitest configs and
    // dependency closures (e.g. integrations/pi resolves `engram` via a
    // local symlink). Excluded so the root suite stays independent of
    // optional install steps. tools/openclaw-import is intentionally kept
    // in the root globbing — it has no extra deps and contributes 67 tests
    // to the headline 308 count.
    exclude: ['**/node_modules/**', '**/dist/**', 'integrations/**'],
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
        'src/local-embedder.ts': {
          statements: 80,
          branches: 60,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
});
