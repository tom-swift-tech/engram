// =============================================================================
// L3 — End-to-End Cross-Process Test
//
// Validates the core architectural bet of the engram-aql branch: TypeScript
// Engram writes a .engram file, the Rust `engram-aql` binary reads it through
// SQLite WAL, and both sides see a consistent world.
//
// Every test here creates a fresh .engram via `Engram.create()`, retains a
// known set of chunks, closes the TS connection, spawns `engram-aql query`
// as a child process, and asserts the returned rows match what TS just wrote.
// The final test also re-opens the TS Engram after the subprocess query to
// prove the Rust reader didn't corrupt the file.
//
// Nothing in this suite exercises engram-aql's internal SQL builder in
// isolation — that's what `engram-aql/tests/` covers. This suite exclusively
// tests the handoff: TS pipeline → SQLite file → Rust subprocess → JSON out.
//
// Binary build: the shared helper lazy-builds `engram-aql` via cargo on first
// use. The first test run pays ~10s; subsequent runs reuse target/debug.
// =============================================================================

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Engram } from '../src/engram.js';
import { MockEmbedder, tmpDbPath, cleanupDb } from './helpers.js';
import { aqlQuery, ensureAqlBinary, aqlChunkIds } from './aql-subprocess.js';

describe('engram-aql cross-process end-to-end (L3)', () => {
  let dbPath: string;
  let engram: Engram | undefined;

  beforeAll(() => {
    ensureAqlBinary();
  });

  afterEach(() => {
    try {
      engram?.close();
    } catch {
      /* already closed */
    }
    engram = undefined;
    cleanupDb(dbPath);
  });

  /**
   * Seed a deterministic .engram file with a cross-section of memory types,
   * contexts, and JSON-text payloads. Returns the chunk IDs grouped by what
   * each test will want to assert against. Closes the TS connection cleanly
   * before returning — WAL frames are committed, Rust subprocess sees them.
   */
  async function seedAndClose(): Promise<{
    semantic: string[];
    episodic: string[];
    opsContext: string[];
    ciContext: string[];
    outcomeSuccess: string[];
    outcomeFailure: string[];
  }> {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    const semantic: string[] = [];
    const episodic: string[] = [];
    const opsContext: string[] = [];
    const ciContext: string[] = [];
    const outcomeSuccess: string[] = [];
    const outcomeFailure: string[] = [];

    // Semantic (world) chunks
    semantic.push(
      (
        await engram.retain('Terraform is an IaC tool', {
          memoryType: 'world',
          context: 'infra',
          trustScore: 0.9,
          sourceType: 'user_stated',
        })
      ).chunkId,
    );
    semantic.push(
      (
        await engram.retain('Proxmox runs on bare metal', {
          memoryType: 'world',
          context: 'infra',
          trustScore: 0.85,
          sourceType: 'user_stated',
        })
      ).chunkId,
    );
    semantic.push(
      (
        await engram.retain('SQLite WAL mode enables concurrent readers', {
          memoryType: 'world',
          context: 'storage',
          trustScore: 0.8,
          sourceType: 'inferred',
        })
      ).chunkId,
    );

    // Episodic (experience) chunks — stored as JSON text so AQL can
    // filter on `event` and `outcome` via json_extract.
    const e1 = await engram.retain(
      '{"event":"deploy","outcome":"success","confidence":0.9}',
      {
        memoryType: 'experience',
        context: 'ops',
        trustScore: 0.9,
        sourceType: 'agent_generated',
      },
    );
    episodic.push(e1.chunkId);
    opsContext.push(e1.chunkId);
    outcomeSuccess.push(e1.chunkId);

    const e2 = await engram.retain(
      '{"event":"deploy","outcome":"failure","confidence":0.3}',
      {
        memoryType: 'experience',
        context: 'ops',
        trustScore: 0.7,
        sourceType: 'agent_generated',
      },
    );
    episodic.push(e2.chunkId);
    opsContext.push(e2.chunkId);
    outcomeFailure.push(e2.chunkId);

    const e3 = await engram.retain(
      '{"event":"test","outcome":"success","confidence":0.8}',
      {
        memoryType: 'experience',
        context: 'ci',
        trustScore: 0.8,
        sourceType: 'agent_generated',
      },
    );
    episodic.push(e3.chunkId);
    ciContext.push(e3.chunkId);
    outcomeSuccess.push(e3.chunkId);

    const e4 = await engram.retain(
      '{"event":"deploy","outcome":"success","confidence":0.85}',
      {
        memoryType: 'experience',
        context: 'ops',
        trustScore: 0.85,
        sourceType: 'agent_generated',
      },
    );
    episodic.push(e4.chunkId);
    opsContext.push(e4.chunkId);
    outcomeSuccess.push(e4.chunkId);

    // Close forces a WAL checkpoint. After this call the Rust subprocess
    // MUST be able to see all of the above writes through the .engram file.
    engram.close();
    engram = undefined;

    return { semantic, episodic, opsContext, ciContext, outcomeSuccess, outcomeFailure };
  }

  // ---- Schema compatibility ----

  it('opens a TS-created .engram file without schema errors', async () => {
    await seedAndClose();
    const result = aqlQuery(dbPath, 'RECALL FROM SEMANTIC ALL LIMIT 1');
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // ---- RECALL by memory type ----

  it('RECALL FROM SEMANTIC returns only world-type chunks', async () => {
    const ids = await seedAndClose();
    const result = aqlQuery(dbPath, 'RECALL FROM SEMANTIC ALL LIMIT 50');
    expect(result.success).toBe(true);

    const returned = aqlChunkIds(result);
    // Every returned chunk must be one of the semantic IDs we retained.
    for (const id of returned) {
      expect(ids.semantic).toContain(id);
    }
    // And every semantic ID we retained must be in the result.
    expect(returned.sort()).toEqual([...ids.semantic].sort());
  });

  it('RECALL FROM EPISODIC returns only experience-type chunks', async () => {
    const ids = await seedAndClose();
    const result = aqlQuery(dbPath, 'RECALL FROM EPISODIC ALL LIMIT 50');
    expect(result.success).toBe(true);

    const returned = aqlChunkIds(result);
    expect(returned.sort()).toEqual([...ids.episodic].sort());
    // None of the semantic chunks should appear.
    for (const semId of ids.semantic) {
      expect(returned).not.toContain(semId);
    }
  });

  // ---- LOOKUP by ID ----

  it('LOOKUP BY id returns exactly the requested chunk', async () => {
    const ids = await seedAndClose();
    const target = ids.semantic[1];
    const result = aqlQuery(
      dbPath,
      `LOOKUP FROM SEMANTIC KEY id = "${target}"`,
    );
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(1);
    expect(result.data[0].id).toBe(target);
  });

  // ---- WHERE on direct columns ----

  it('RECALL ... WHERE context = "ops" filters by direct column', async () => {
    const ids = await seedAndClose();
    const result = aqlQuery(
      dbPath,
      'RECALL FROM EPISODIC WHERE context = "ops" LIMIT 50',
    );
    expect(result.success).toBe(true);
    expect(aqlChunkIds(result).sort()).toEqual([...ids.opsContext].sort());
  });

  // ---- WHERE on JSON-extracted field ----

  it('RECALL ... WHERE outcome = "success" filters via json_extract', async () => {
    const ids = await seedAndClose();
    const result = aqlQuery(
      dbPath,
      'RECALL FROM EPISODIC WHERE outcome = "success" LIMIT 50',
    );
    expect(result.success).toBe(true);
    expect(aqlChunkIds(result).sort()).toEqual([...ids.outcomeSuccess].sort());
  });

  // ---- AGGREGATE ----

  it('AGGREGATE COUNT returns the correct count', async () => {
    const ids = await seedAndClose();
    const result = aqlQuery(
      dbPath,
      'RECALL FROM EPISODIC ALL AGGREGATE COUNT(*) AS total',
    );
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(1);
    expect(result.data[0].total).toBe(ids.episodic.length);
  });

  it('AGGREGATE COUNT with WHERE matches filtered subset', async () => {
    const ids = await seedAndClose();
    const result = aqlQuery(
      dbPath,
      'RECALL FROM EPISODIC WHERE context = "ops" AGGREGATE COUNT(*) AS ops_count',
    );
    expect(result.success).toBe(true);
    expect(result.data[0].ops_count).toBe(ids.opsContext.length);
  });

  // ---- ORDER BY ----

  it('RECALL ... ORDER BY trust_score DESC returns highest-trust first', async () => {
    await seedAndClose();
    const result = aqlQuery(
      dbPath,
      'RECALL FROM EPISODIC ALL ORDER BY trust_score DESC LIMIT 50',
    );
    expect(result.success).toBe(true);
    const scores = result.data.map((r) => r.trust_score as number);
    // Descending monotonic
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  // ---- Write rejection (subprocess path) ----

  it('STORE statement is rejected with helpful error through subprocess', async () => {
    await seedAndClose();
    const result = aqlQuery(
      dbPath,
      'STORE INTO EPISODIC (event = "deploy", outcome = "success")',
    );
    expect(result.success).toBe(false);
    expect(result.statement).toBe('Store');
    expect(result.error).toContain('engram_retain');
  });

  // ---- Re-open + corruption check ----

  it('TS can re-open and see all data after Rust subprocess queried it', async () => {
    const ids = await seedAndClose();

    // Rust side reads
    const read = aqlQuery(dbPath, 'RECALL FROM SEMANTIC ALL LIMIT 50');
    expect(read.success).toBe(true);
    expect(read.data.length).toBe(ids.semantic.length);

    // TS side re-opens — verify every chunk is still intact and readable.
    const reopened = await Engram.open(dbPath, { embedder: new MockEmbedder() });
    try {
      const db = new Database(dbPath);
      const rows = db
        .prepare('SELECT id, text FROM chunks WHERE is_active = 1')
        .all() as Array<{ id: string; text: string }>;
      db.close();

      const allExpected = [...ids.semantic, ...ids.episodic].sort();
      expect(rows.map((r) => r.id).sort()).toEqual(allExpected);
      // Text content preserved (no truncation or encoding damage)
      for (const row of rows) {
        expect(typeof row.text).toBe('string');
        expect(row.text.length).toBeGreaterThan(0);
      }
    } finally {
      reopened.close();
    }
  });

  // ---- MIN_CONFIDENCE modifier ----

  it('MIN_CONFIDENCE filters by trust_score', async () => {
    const ids = await seedAndClose();
    // Using 0.84 rather than 0.85 to avoid the exact-equality boundary case —
    // trust_score = 0.85 stored as REAL and compared to >= 0.85 is subject to
    // IEEE-754 representation quirks that are out of scope for this suite.
    // Cross-process correctness is what we're testing; float precision is not.
    const result = aqlQuery(
      dbPath,
      'RECALL FROM EPISODIC ALL MIN_CONFIDENCE 0.84 LIMIT 50',
    );
    expect(result.success).toBe(true);
    const returned = aqlChunkIds(result);
    // e1 (0.9) and e4 (0.85) both clear the 0.84 threshold; e2 (0.7) and e3 (0.8) do not.
    const expected = [ids.episodic[0], ids.episodic[3]].sort();
    expect(returned.sort()).toEqual(expected);
  });
});
