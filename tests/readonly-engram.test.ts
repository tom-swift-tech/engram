// =============================================================================
// readonly-engram.test.ts — the read-only guarantee (spec §5, options 1+2)
//
// Two enforcement layers:
//   1. Capability surface — no write method exists on ReadonlyEngram.
//   2. Read-only driver connection — a raw-SQL write fails at the driver.
// Plus: read parity with the parent, and connection independence on close().
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Engram } from '../src/engram.js';
import { ReadonlyEngram } from '../src/readonly-engram.js';
import {
  MockEmbedder,
  MockGenerator,
  tmpDbPath,
  cleanupDb,
} from './helpers.js';

describe('ReadonlyEngram', () => {
  let dbPath: string;
  let engram: Engram;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    await engram.retain('Postgres listens on port 5432 by default', {
      memoryType: 'world',
      sourceType: 'user_stated',
      trustScore: 0.9,
    });
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  // Layer 1 — capability surface -------------------------------------------------

  it('exposes read operations only — no write method on the surface', async () => {
    const view = await engram.readonlyView();
    expect(view).toBeInstanceOf(ReadonlyEngram);

    // Reads present
    expect(typeof view.recall).toBe('function');
    expect(typeof view.queryContext).toBe('function');
    expect(typeof view.introspect).toBe('function');

    // Writes structurally absent
    const v = view as unknown as Record<string, unknown>;
    for (const method of [
      'retain',
      'reflect',
      'commitContext',
      'promoteContext',
      'supersede',
      'forget',
      'expireContext',
      'processExtractions',
    ]) {
      expect(v[method]).toBeUndefined();
    }

    view.close();
  });

  // Layer 2 — read-only driver connection ---------------------------------------

  it('rides a read-only connection: a raw-SQL write fails at the driver', async () => {
    const view = await engram.readonlyView();

    // Reach past the capability surface to the underlying connection and prove
    // even a raw-SQL escape hatch cannot mutate the store.
    const rawDb = (view as unknown as { db: Database.Database }).db;
    expect(() =>
      rawDb
        .prepare(`UPDATE chunks SET trust_score = 0.1 WHERE is_active = TRUE`)
        .run(),
    ).toThrow(/readonly/i);

    view.close();
  });

  // Read parity + independence ---------------------------------------------------

  it('reads the same durable facts the parent engram sees', async () => {
    const view = await engram.readonlyView();

    const viaView = await view.recall('Postgres port', { topK: 5 });
    const viaParent = await engram.recall('Postgres port', { topK: 5 });

    expect(viaView.results.length).toBeGreaterThan(0);
    expect(viaView.results.map((r) => r.id).sort()).toEqual(
      viaParent.results.map((r) => r.id).sort(),
    );

    view.close();
  });

  it('closing the view leaves the parent connection usable', async () => {
    const view = await engram.readonlyView();
    view.close();

    // Parent still works after the view is gone.
    const res = await engram.recall('Postgres port', { topK: 5 });
    expect(res.results.length).toBeGreaterThan(0);
    // And the parent can still write.
    await expect(
      engram.retain('Redis listens on port 6379', { memoryType: 'world' }),
    ).resolves.toBeDefined();
  });

  it('sees writes the parent commits after the view was opened (WAL)', async () => {
    const view = await engram.readonlyView();
    await engram.retain('Redis listens on port 6379 by default', {
      memoryType: 'world',
      sourceType: 'user_stated',
    });

    const res = await view.recall('Redis port', { topK: 5 });
    expect(res.results.some((r) => /redis/i.test(r.text))).toBe(true);

    view.close();
  });
});
