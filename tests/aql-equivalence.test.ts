// =============================================================================
// L2 — Semantic Equivalence Test
//
// Validates that AQL queries return the same chunk set that an equivalent raw
// SQL query would return against the same TS-created .engram file. This is
// the "is AQL a faithful front-end for Engram" layer — it locks in the
// mapping from AQL vocabulary (EPISODIC, SEMANTIC, WHERE, ORDER BY, AGGREGATE)
// to Engram's underlying SQL semantics.
//
// NOTE on scope: This suite tests equivalence to raw SQL over the chunks
// table — NOT equivalence to engram.recall(). Engram's recall() is a fuzzy
// retrieval that fuses 4 strategies via RRF and weights by trust; AQL is a
// structured filter-and-project query. The two are deliberately different
// shapes. "Faithful front-end" here means: for queries that are expressible
// as flat filters, AQL produces the same results as the SQL a user would
// write by hand. RRF-style retrieval remains the TS side's job.
//
// Each test:
//   1. Seeds a fresh .engram via TS Engram.create() + retain()
//   2. Runs an AQL query via subprocess → chunk ID set A
//   3. Runs an equivalent raw SQL query via better-sqlite3 → chunk ID set B
//   4. Asserts A === B (as sorted arrays)
// =============================================================================

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Engram } from '../src/engram.js';
import { MockEmbedder, tmpDbPath, cleanupDb } from './helpers.js';
import { aqlQuery, ensureAqlBinary, aqlChunkIds } from './aql-subprocess.js';

describe('AQL semantic equivalence to raw SQL (L2)', () => {
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
   * Seed a diverse chunk set covering both memory types, multiple contexts,
   * and JSON-text payloads for field-extraction coverage. Closes TS cleanly.
   */
  async function seedAndClose(): Promise<void> {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    // World chunks — plain text, filterable by context/source/trust_score
    await engram.retain('Terraform is an IaC tool', {
      memoryType: 'world',
      context: 'infra',
      trustScore: 0.9,
      source: 'docs:terraform',
    });
    await engram.retain('Proxmox runs on bare metal', {
      memoryType: 'world',
      context: 'infra',
      trustScore: 0.7,
      source: 'docs:proxmox',
    });
    await engram.retain('SQLite WAL mode enables concurrent readers', {
      memoryType: 'world',
      context: 'storage',
      trustScore: 0.8,
      source: 'docs:sqlite',
    });

    // Experience chunks — JSON text so outcome/event filters exercise json_extract
    await engram.retain(
      '{"event":"deploy","outcome":"success","confidence":0.9}',
      {
        memoryType: 'experience',
        context: 'ops',
        trustScore: 0.9,
        source: 'agent:deployer',
      },
    );
    await engram.retain(
      '{"event":"deploy","outcome":"failure","confidence":0.3}',
      {
        memoryType: 'experience',
        context: 'ops',
        trustScore: 0.6,
        source: 'agent:deployer',
      },
    );
    await engram.retain(
      '{"event":"test","outcome":"success","confidence":0.8}',
      {
        memoryType: 'experience',
        context: 'ci',
        trustScore: 0.8,
        source: 'agent:runner',
      },
    );
    await engram.retain(
      '{"event":"deploy","outcome":"success","confidence":0.95}',
      {
        memoryType: 'experience',
        context: 'ops',
        trustScore: 0.95,
        source: 'agent:deployer',
      },
    );

    engram.close();
    engram = undefined;
  }

  /**
   * Open a read-only connection to the seeded file, run a SQL query, return
   * the `id` column sorted. Used as the ground-truth reference for every
   * AQL equivalence assertion.
   */
  function rawSqlIds(sql: string, ...params: unknown[]): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
      return rows.map((r) => r.id).sort();
    } finally {
      db.close();
    }
  }

  // ---- Memory type mapping ----

  it('RECALL FROM EPISODIC ≡ chunks WHERE memory_type = experience', async () => {
    await seedAndClose();
    const aql = aqlChunkIds(aqlQuery(dbPath, 'RECALL FROM EPISODIC ALL LIMIT 50'));
    const sql = rawSqlIds(
      "SELECT id FROM chunks WHERE memory_type = 'experience' AND is_active = 1 LIMIT 50",
    );
    expect(aql).toEqual(sql);
    expect(aql.length).toBeGreaterThan(0); // guard against trivial pass on empty sets
  });

  it('RECALL FROM SEMANTIC ≡ chunks WHERE memory_type = world', async () => {
    await seedAndClose();
    const aql = aqlChunkIds(aqlQuery(dbPath, 'RECALL FROM SEMANTIC ALL LIMIT 50'));
    const sql = rawSqlIds(
      "SELECT id FROM chunks WHERE memory_type = 'world' AND is_active = 1 LIMIT 50",
    );
    expect(aql).toEqual(sql);
    expect(aql.length).toBeGreaterThan(0);
  });

  // ---- WHERE on direct columns ----

  it('WHERE context = "ops" ≡ raw SQL context filter', async () => {
    await seedAndClose();
    const aql = aqlChunkIds(
      aqlQuery(dbPath, 'RECALL FROM EPISODIC WHERE context = "ops" LIMIT 50'),
    );
    const sql = rawSqlIds(
      "SELECT id FROM chunks WHERE memory_type = 'experience' AND is_active = 1 AND context = ? LIMIT 50",
      'ops',
    );
    expect(aql).toEqual(sql);
    expect(aql.length).toBeGreaterThan(0);
  });

  it('WHERE trust_score > 0.7 ≡ raw SQL numeric comparison', async () => {
    await seedAndClose();
    const aql = aqlChunkIds(
      aqlQuery(dbPath, 'RECALL FROM EPISODIC WHERE trust_score > 0.7 LIMIT 50'),
    );
    const sql = rawSqlIds(
      "SELECT id FROM chunks WHERE memory_type = 'experience' AND is_active = 1 AND trust_score > 0.7 LIMIT 50",
    );
    expect(aql).toEqual(sql);
    expect(aql.length).toBeGreaterThan(0);
  });

  it('WHERE source = "docs:terraform" ≡ raw SQL exact match', async () => {
    await seedAndClose();
    const aql = aqlChunkIds(
      aqlQuery(
        dbPath,
        'RECALL FROM SEMANTIC WHERE source = "docs:terraform" LIMIT 50',
      ),
    );
    const sql = rawSqlIds(
      "SELECT id FROM chunks WHERE memory_type = 'world' AND is_active = 1 AND source = ? LIMIT 50",
      'docs:terraform',
    );
    expect(aql).toEqual(sql);
    expect(aql.length).toBe(1);
  });

  // ---- WHERE on JSON-extracted fields ----

  it('WHERE outcome = "success" ≡ raw SQL json_extract', async () => {
    await seedAndClose();
    const aql = aqlChunkIds(
      aqlQuery(
        dbPath,
        'RECALL FROM EPISODIC WHERE outcome = "success" LIMIT 50',
      ),
    );
    const sql = rawSqlIds(
      "SELECT id FROM chunks WHERE memory_type = 'experience' AND is_active = 1 AND json_extract(text, '$.outcome') = ? LIMIT 50",
      'success',
    );
    expect(aql).toEqual(sql);
    expect(aql.length).toBeGreaterThan(0);
  });

  it('WHERE event = "deploy" AND outcome = "failure" ≡ compound json_extract', async () => {
    await seedAndClose();
    const aql = aqlChunkIds(
      aqlQuery(
        dbPath,
        'RECALL FROM EPISODIC WHERE event = "deploy" AND outcome = "failure" LIMIT 50',
      ),
    );
    const sql = rawSqlIds(
      `SELECT id FROM chunks
       WHERE memory_type = 'experience' AND is_active = 1
         AND json_extract(text, '$.event') = ?
         AND json_extract(text, '$.outcome') = ?
       LIMIT 50`,
      'deploy',
      'failure',
    );
    expect(aql).toEqual(sql);
    expect(aql.length).toBe(1);
  });

  // ---- LOOKUP ≡ id filter ----

  it('LOOKUP KEY id ≡ raw SQL id equality', async () => {
    await seedAndClose();
    // Pick a known chunk to look up
    const pickId = rawSqlIds(
      "SELECT id FROM chunks WHERE memory_type = 'experience' AND is_active = 1 LIMIT 1",
    )[0];
    const aql = aqlChunkIds(
      aqlQuery(dbPath, `LOOKUP FROM EPISODIC KEY id = "${pickId}"`),
    );
    const sql = rawSqlIds(
      "SELECT id FROM chunks WHERE memory_type = 'experience' AND is_active = 1 AND id = ?",
      pickId,
    );
    expect(aql).toEqual(sql);
    expect(aql).toEqual([pickId]);
  });

  // ---- ORDER BY + LIMIT ----

  it('ORDER BY trust_score DESC LIMIT 2 ≡ raw SQL top-N', async () => {
    await seedAndClose();
    // Use raw strings (not set comparison) because order matters here.
    const aqlRows = aqlQuery(
      dbPath,
      'RECALL FROM EPISODIC ALL ORDER BY trust_score DESC LIMIT 2',
    );
    const db = new Database(dbPath, { readonly: true });
    const sqlRows = db
      .prepare(
        "SELECT id, trust_score FROM chunks WHERE memory_type = 'experience' AND is_active = 1 ORDER BY trust_score DESC LIMIT 2",
      )
      .all() as Array<{ id: string; trust_score: number }>;
    db.close();

    expect(aqlRows.data.map((r) => r.id)).toEqual(sqlRows.map((r) => r.id));
  });

  // ---- AGGREGATE ≡ SQL COUNT ----

  it('AGGREGATE COUNT(*) ≡ raw SQL COUNT', async () => {
    await seedAndClose();
    const aql = aqlQuery(
      dbPath,
      'RECALL FROM EPISODIC ALL AGGREGATE COUNT(*) AS total',
    );
    const db = new Database(dbPath, { readonly: true });
    const sql = db
      .prepare(
        "SELECT COUNT(*) AS total FROM chunks WHERE memory_type = 'experience' AND is_active = 1",
      )
      .get() as { total: number };
    db.close();

    expect(aql.data[0].total).toBe(sql.total);
    expect(sql.total).toBeGreaterThan(0);
  });

  // ---- Forget exclusion ----

  it('AQL excludes forgotten chunks ≡ raw SQL with is_active = 1', async () => {
    // Seed, forget one, close — then query from Rust subprocess.
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    const r1 = await engram.retain('keep me', { memoryType: 'world' });
    const r2 = await engram.retain('forget me', { memoryType: 'world' });
    await engram.retain('keep me too', { memoryType: 'world' });

    await engram.forget(r2.chunkId);
    engram.close();
    engram = undefined;

    const aql = aqlChunkIds(aqlQuery(dbPath, 'RECALL FROM SEMANTIC ALL LIMIT 50'));
    const sql = rawSqlIds(
      "SELECT id FROM chunks WHERE memory_type = 'world' AND is_active = 1 LIMIT 50",
    );

    expect(aql).toEqual(sql);
    expect(aql).toContain(r1.chunkId);
    expect(aql).not.toContain(r2.chunkId);
  });
});
