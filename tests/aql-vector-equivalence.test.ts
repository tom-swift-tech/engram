// =============================================================================
// L2 semantic-equivalence: native vec_distance_cosine (Rust) == sqlite-vec (TS)
//
// The engram-aql Rust binary computes cosine distance with a NATIVE scalar
// function (src/vector/cosine.rs), while TypeScript Engram uses sqlite-vec's
// vec_distance_cosine. Both read the same LE-f32 embedding BLOBs from the same
// .engram file. This suite proves they rank chunks identically for a given
// probe, so AQL `RECALL ... LIKE` returns the same order a TS semantic query
// would.
//
// Method (deterministic, no embedding model, no bridge):
//   1. TS retains world chunks with MockEmbedder (8-dim, deterministic).
//   2. We read one chunk's stored embedding and use it as the probe.
//   3. TS ranks chunks via sqlite-vec vec_distance_cosine on the probe BLOB.
//   4. AQL ranks via `RECALL FROM SEMANTIC LIKE $q` with the probe bound as a
//      precomputed array (`--var q=[...]`) — array-bound, so no engram-mcp
//      child is needed.
//   5. Assert identical id ordering and near-equal distances. Distances are
//      compared with a tolerance because the Rust fn accumulates in f64 while
//      sqlite-vec uses f32 — ordering is preserved, values differ in ULPs.
//
// Gated on cargo (the shared helper lazy-builds the binary); skipped/failing
// without a Rust toolchain, like the other aql-* cross-process suites.
// =============================================================================

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Engram } from '../src/engram.js';
import { MockEmbedder, tmpDbPath, cleanupDb } from './helpers.js';
import { aqlQuery, ensureAqlBinary } from './aql-subprocess.js';

describe('engram-aql vector-search equivalence (L2)', () => {
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

  /** Decode a LE-f32 BLOB (the on-disk embedding format) into a number[]. */
  function decodeEmbedding(buf: Buffer): number[] {
    const f32 = new Float32Array(
      buf.buffer,
      buf.byteOffset,
      buf.byteLength / 4,
    );
    return Array.from(f32);
  }

  async function seedWorldChunks(): Promise<void> {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });
    const texts = [
      'terraform provisions cloud infrastructure',
      'proxmox is a bare-metal hypervisor',
      'sqlite wal mode enables concurrent readers',
      'kubernetes orchestrates containers',
      'rust guarantees memory safety without a gc',
    ];
    for (const t of texts) {
      await engram.retain(t, {
        memoryType: 'world',
        sourceType: 'user_stated',
        trustScore: 0.8,
      });
    }
    engram.close();
    engram = undefined;
  }

  it('AQL RECALL LIKE ranks identically to sqlite-vec for a probe', async () => {
    await seedWorldChunks();

    // Open the file directly and load sqlite-vec, exactly as Engram does.
    const db = new Database(dbPath);
    const vec = (await import('sqlite-vec')) as unknown as {
      load: (d: unknown) => void;
    };
    vec.load(db);

    // Probe = the first world chunk's own stored embedding. It will rank
    // itself at distance 0 and the rest by cosine distance.
    const first = db
      .prepare(
        `SELECT id, embedding FROM chunks WHERE memory_type = 'world' ORDER BY id LIMIT 1`,
      )
      .get() as { id: string; embedding: Buffer };
    const probe = decodeEmbedding(first.embedding);
    const probeBuffer = Buffer.from(Float32Array.from(probe).buffer);

    // TS reference ranking via sqlite-vec.
    const tsRows = db
      .prepare(
        `SELECT id, vec_distance_cosine(embedding, ?) AS distance
         FROM chunks
         WHERE memory_type = 'world' AND is_active = TRUE AND embedding IS NOT NULL
         ORDER BY distance ASC`,
      )
      .all(probeBuffer) as Array<{ id: string; distance: number }>;
    db.close();

    // AQL ranking via the Rust binary (array-bound probe — no bridge).
    const aql = aqlQuery(dbPath, 'RECALL FROM SEMANTIC LIKE $q', { q: probe });
    expect(aql.success).toBe(true);
    expect(aql.error).toBeUndefined();

    const tsOrder = tsRows.map((r) => r.id);
    const aqlOrder = aql.data.map((r) => r.id as string);

    // Same set, same order.
    expect(aqlOrder).toEqual(tsOrder);

    // The self-probe must rank first at distance ~0 on both sides.
    expect(aqlOrder[0]).toBe(first.id);
    expect(tsRows[0].distance).toBeCloseTo(0, 5);

    // Distances agree within tolerance (Rust f64 accumulation vs sqlite-vec f32).
    const aqlDist = new Map(
      aql.data.map((r) => [r.id as string, r.distance as number]),
    );
    for (const row of tsRows) {
      const rustD = aqlDist.get(row.id);
      expect(rustD).toBeDefined();
      expect(rustD!).toBeCloseTo(row.distance, 4);
    }
  });

  it('PATTERN THRESHOLD filters the same rows sqlite-vec would', async () => {
    await seedWorldChunks();

    const db = new Database(dbPath);
    const vec = (await import('sqlite-vec')) as unknown as {
      load: (d: unknown) => void;
    };
    vec.load(db);

    const first = db
      .prepare(
        `SELECT id, embedding FROM chunks WHERE memory_type = 'world' ORDER BY id LIMIT 1`,
      )
      .get() as { id: string; embedding: Buffer };
    const probe = decodeEmbedding(first.embedding);
    const probeBuffer = Buffer.from(Float32Array.from(probe).buffer);

    // THRESHOLD 0.5 → similarity floor → distance <= 0.5.
    const threshold = 0.5;
    const tsKept = (
      db
        .prepare(
          `SELECT id, vec_distance_cosine(embedding, ?) AS distance
           FROM chunks
           WHERE memory_type = 'world' AND is_active = TRUE AND embedding IS NOT NULL
           ORDER BY distance ASC`,
        )
        .all(probeBuffer) as Array<{ id: string; distance: number }>
    )
      .filter((r) => r.distance <= 1.0 - threshold)
      .map((r) => r.id);
    db.close();

    const aql = aqlQuery(
      dbPath,
      `RECALL FROM SEMANTIC PATTERN $q THRESHOLD ${threshold}`,
      { q: probe },
    );
    expect(aql.success).toBe(true);
    const aqlKept = aql.data.map((r) => r.id as string);
    expect(aqlKept).toEqual(tsKept);
  });
});
