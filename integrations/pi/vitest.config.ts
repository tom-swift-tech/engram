import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Resolve `engram` to the parent project's compiled output. This lets the
// tests run via `vitest` from this directory without requiring an `npm install`
// in integrations/pi (which would symlink against engram's dist/ anyway).
// Production consumers install via `pi install` and resolve `engram` through
// real npm resolution.
export default defineConfig({
  resolve: {
    alias: {
      engram: resolve(here, '../../dist/engram.js'),
    },
  },
  test: {
    // Native addons (better-sqlite3 via engram) require forked child
    // processes, not worker_threads (vitest default). Same reason the
    // parent vitest.config.ts uses forks. Also unlocks process.chdir()
    // in tests that need to set a per-test cwd.
    pool: 'forks',
    include: ['tests/**/*.test.ts'],
  },
});
