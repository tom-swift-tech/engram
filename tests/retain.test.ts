import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  retain,
  retainBatch,
  processExtractionQueue,
  getQueueStats,
  chunkText,
} from '../src/retain.js';
import {
  createTestDb,
  MockEmbedder,
  MockGenerator,
  EXTRACTION_RESPONSE,
} from './helpers.js';

// ---------------------------------------------------------------------------
// retain()
// ---------------------------------------------------------------------------

describe('retain()', () => {
  let db: Database.Database;
  const embedder = new MockEmbedder();

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('stores chunk with correct fields', async () => {
    const result = await retain(db, 'Tom prefers Terraform', embedder, {
      memoryType: 'world',
      sourceType: 'user_stated',
      trustScore: 0.9,
      source: 'conversation:test',
      context: 'infrastructure',
    });

    expect(result.chunkId).toMatch(/^chk-/);
    const chunk = db
      .prepare('SELECT * FROM chunks WHERE id = ?')
      .get(result.chunkId) as any;
    expect(chunk.text).toBe('Tom prefers Terraform');
    expect(chunk.memory_type).toBe('world');
    expect(chunk.source_type).toBe('user_stated');
    expect(chunk.trust_score).toBe(0.9);
    expect(chunk.source).toBe('conversation:test');
    expect(chunk.context).toBe('infrastructure');
    expect(chunk.is_active).toBe(1);
    expect(chunk.reflected_at).toBeNull();
  });

  it('stores embedding as a buffer of the correct size', async () => {
    const result = await retain(db, 'test text', embedder);
    const chunk = db
      .prepare('SELECT embedding FROM chunks WHERE id = ?')
      .get(result.chunkId) as any;
    // MockEmbedder dimensions=8, each float32 = 4 bytes → 32 bytes total
    expect(chunk.embedding).toBeInstanceOf(Buffer);
    expect(chunk.embedding.byteLength).toBe(embedder.dimensions * 4);
  });

  it('applies default options', async () => {
    const result = await retain(db, 'plain text', embedder);
    const chunk = db
      .prepare('SELECT * FROM chunks WHERE id = ?')
      .get(result.chunkId) as any;
    expect(chunk.memory_type).toBe('world');
    expect(chunk.source_type).toBe('inferred');
    expect(chunk.trust_score).toBe(0.5);
  });

  it('stores temporal fields', async () => {
    const result = await retain(db, 'event', embedder, {
      eventTime: '2025-01-15T00:00:00Z',
      temporalLabel: 'mid-January 2025',
    });
    const chunk = db
      .prepare('SELECT * FROM chunks WHERE id = ?')
      .get(result.chunkId) as any;
    expect(chunk.event_time).toBe('2025-01-15T00:00:00Z');
    expect(chunk.temporal_label).toBe('mid-January 2025');
  });

  it('queues extraction for world type', async () => {
    const result = await retain(db, 'hello world', embedder, {
      memoryType: 'world',
    });
    expect(result.queued).toBe(true);
    const row = db
      .prepare('SELECT * FROM extraction_queue WHERE chunk_id = ?')
      .get(result.chunkId);
    expect(row).toBeTruthy();
  });

  it('queues extraction for experience type', async () => {
    const result = await retain(db, 'I did a thing', embedder, {
      memoryType: 'experience',
    });
    expect(result.queued).toBe(true);
  });

  it('does not queue for observation type', async () => {
    const result = await retain(db, 'observed pattern', embedder, {
      memoryType: 'observation',
    });
    expect(result.queued).toBe(false);
    // better-sqlite3 .get() returns undefined (not null) when no row exists
    const row = db
      .prepare('SELECT * FROM extraction_queue WHERE chunk_id = ?')
      .get(result.chunkId);
    expect(row).toBeUndefined();
  });

  it('does not queue for opinion type', async () => {
    const result = await retain(db, 'I believe this', embedder, {
      memoryType: 'opinion',
    });
    expect(result.queued).toBe(false);
  });

  it('skips queueing when skipExtraction is true', async () => {
    const result = await retain(db, 'hello', embedder, {
      memoryType: 'world',
      skipExtraction: true,
    });
    expect(result.queued).toBe(false);
    const row = db
      .prepare('SELECT * FROM extraction_queue WHERE chunk_id = ?')
      .get(result.chunkId);
    expect(row).toBeUndefined();
  });

  it('generates unique chunk IDs across multiple retains', async () => {
    const r1 = await retain(db, 'first', embedder);
    const r2 = await retain(db, 'second', embedder);
    expect(r1.chunkId).not.toBe(r2.chunkId);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('retain() — deduplication', () => {
  let db: Database.Database;
  const embedder = new MockEmbedder();

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('exact dedup: retaining identical text returns existing chunk', async () => {
    const r1 = await retain(db, 'Tom prefers Terraform', embedder);
    const r2 = await retain(db, 'Tom prefers Terraform', embedder);

    expect(r2.chunkId).toBe(r1.chunkId);
    expect(r2.deduplicated).toBe(true);

    const count = db.prepare('SELECT count(*) as n FROM chunks').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it('exact dedup: reinforces trust score with the higher value', async () => {
    const r1 = await retain(db, 'Tom prefers Terraform', embedder, {
      trustScore: 0.5,
    });
    await retain(db, 'Tom prefers Terraform', embedder, { trustScore: 0.9 });

    const chunk = db
      .prepare('SELECT trust_score FROM chunks WHERE id = ?')
      .get(r1.chunkId) as any;
    expect(chunk.trust_score).toBe(0.9);
  });

  it('dedupMode none: always creates new chunks', async () => {
    await retain(db, 'Tom prefers Terraform', embedder, { dedupMode: 'none' });
    const r2 = await retain(db, 'Tom prefers Terraform', embedder, {
      dedupMode: 'none',
    });

    expect(r2.deduplicated).toBeUndefined();
    const count = db.prepare('SELECT count(*) as n FROM chunks').get() as {
      n: number;
    };
    expect(count.n).toBe(2);
  });

  it('dedupMode normalized: deduplicates despite case/whitespace differences', async () => {
    const r1 = await retain(db, 'Tom prefers Terraform', embedder, {
      dedupMode: 'normalized',
    });
    const r2 = await retain(db, '  tom prefers terraform  ', embedder, {
      dedupMode: 'normalized',
    });

    expect(r2.chunkId).toBe(r1.chunkId);
    expect(r2.deduplicated).toBe(true);
  });

  it('dedupMode normalized: deduplicates despite internal whitespace differences', async () => {
    const r1 = await retain(db, 'Tom  prefers   Terraform', embedder, {
      dedupMode: 'normalized',
    });
    const r2 = await retain(db, 'tom prefers terraform', embedder, {
      dedupMode: 'normalized',
    });

    expect(r2.chunkId).toBe(r1.chunkId);
    expect(r2.deduplicated).toBe(true);
  });

  it('exact dedup: different text creates new chunk', async () => {
    const r1 = await retain(db, 'Tom prefers Terraform', embedder);
    const r2 = await retain(db, 'Tom prefers Pulumi', embedder);

    expect(r1.chunkId).not.toBe(r2.chunkId);
    const count = db.prepare('SELECT count(*) as n FROM chunks').get() as {
      n: number;
    };
    expect(count.n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// retainBatch()
// ---------------------------------------------------------------------------

describe('retainBatch()', () => {
  it('stores all items and returns all results', async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();

    const results = await retainBatch(
      db,
      [
        { text: 'first', options: { memoryType: 'world' } },
        { text: 'second', options: { memoryType: 'world' } },
        { text: 'third', options: { memoryType: 'world' } },
      ],
      embedder,
    );

    expect(results).toHaveLength(3);
    const count = db.prepare('SELECT count(*) as n FROM chunks').get() as {
      n: number;
    };
    expect(count.n).toBe(3);
    db.close();
  });

  it('reports progress per concurrency chunk', async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const progress: Array<[number, number]> = [];

    // With concurrency=1, reports per-item like the old sequential behavior
    await retainBatch(
      db,
      [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
      embedder,
      (current, total) => progress.push([current, total]),
      1, // concurrency=1 forces sequential
    );

    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    db.close();
  });

  it('queues world and experience items but not observation/opinion', async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();

    await retainBatch(
      db,
      [
        { text: 'world fact', options: { memoryType: 'world' } },
        { text: 'my experience', options: { memoryType: 'experience' } },
        { text: 'observed pattern', options: { memoryType: 'observation' } },
      ],
      embedder,
    );

    const count = db
      .prepare('SELECT count(*) as n FROM extraction_queue')
      .get() as { n: number };
    expect(count.n).toBe(2);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// processExtractionQueue()
// ---------------------------------------------------------------------------

describe('processExtractionQueue()', () => {
  it('extracts entities and relations from queued chunks', async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const generator = new MockGenerator(EXTRACTION_RESPONSE);

    await retain(db, 'Alice prefers Rust for systems programming', embedder, {
      memoryType: 'world',
    });

    const result = await processExtractionQueue(db, generator);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    // Entities created (by Tier 1 CPU + Tier 2 LLM)
    const entities = db.prepare('SELECT * FROM entities').all() as any[];
    expect(entities.some((e) => e.canonical_name === 'alice')).toBe(true);
    expect(entities.some((e) => e.canonical_name === 'rust')).toBe(true);

    // Relation created
    const relations = db.prepare('SELECT * FROM relations').all() as any[];
    expect(relations.length).toBeGreaterThan(0);

    // chunk_entities linked
    const links = db.prepare('SELECT * FROM chunk_entities').all() as any[];
    expect(links.length).toBeGreaterThan(0);

    // Queue item marked complete
    const queued = db
      .prepare('SELECT status FROM extraction_queue LIMIT 1')
      .get() as any;
    expect(queued.status).toBe('completed');

    db.close();
  });

  it('sets status to pending (not failed) after first extraction failure', async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const failGen: import('../src/generation.js').GenerationProvider = {
      name: 'mock/fail',
      generate: async () => {
        throw new Error('generation error');
      },
    };

    await retain(db, 'some text', embedder, { memoryType: 'world' });
    const result = await processExtractionQueue(db, failGen);

    expect(result.failed).toBe(1);
    const queued = db
      .prepare('SELECT status, attempts FROM extraction_queue LIMIT 1')
      .get() as any;
    // First failure: status back to 'pending' so it can be retried
    expect(queued.status).toBe('pending');
    expect(queued.attempts).toBe(1);
    db.close();
  });

  it('sets status to failed after 3 extraction failures', async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const failGen: import('../src/generation.js').GenerationProvider = {
      name: 'mock/fail',
      generate: async () => {
        throw new Error('generation error');
      },
    };

    await retain(db, 'retry exhaustion text', embedder, {
      memoryType: 'world',
    });

    // Run 3 times — clear backoff window between each to simulate time passing
    await processExtractionQueue(db, failGen);
    db.prepare(`UPDATE extraction_queue SET next_retry_after = NULL`).run();
    await processExtractionQueue(db, failGen);
    db.prepare(`UPDATE extraction_queue SET next_retry_after = NULL`).run();
    const thirdResult = await processExtractionQueue(db, failGen);

    expect(thirdResult.failed).toBe(1);
    const queued = db
      .prepare('SELECT status, attempts FROM extraction_queue LIMIT 1')
      .get() as any;
    expect(queued.attempts).toBe(3);
    expect(queued.status).toBe('failed');
    db.close();
  });

  it('respects backoff window — does not retry immediately after failure', async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const failGen: import('../src/generation.js').GenerationProvider = {
      name: 'mock/fail',
      generate: async () => {
        throw new Error('generation error');
      },
    };

    await retain(db, 'backoff test text', embedder, { memoryType: 'world' });

    // First call fails and sets a backoff window
    await processExtractionQueue(db, failGen);
    const queued = db
      .prepare('SELECT status, next_retry_after FROM extraction_queue LIMIT 1')
      .get() as any;
    expect(queued.status).toBe('pending');
    expect(queued.next_retry_after).toBeTruthy();

    // Second call immediately after — item should be skipped due to backoff
    const secondResult = await processExtractionQueue(db, failGen);
    expect(secondResult.processed).toBe(0);
    expect(secondResult.failed).toBe(0);

    db.close();
  });

  it('returns zero when queue is empty', async () => {
    const db = createTestDb();
    const generator = new MockGenerator();
    const result = await processExtractionQueue(db, generator);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    db.close();
  });

  it('skips inactive chunks even if they remain in the extraction queue', async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const generator = new MockGenerator(EXTRACTION_RESPONSE);

    const retained = await retain(db, 'Alice prefers Rust', embedder, {
      memoryType: 'world',
    });
    db.prepare(`UPDATE chunks SET is_active = FALSE WHERE id = ?`).run(
      retained.chunkId,
    );

    const result = await processExtractionQueue(db, generator);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);

    // Tier 1 CPU extraction created entities during retain(), so count > 0
    // But Tier 2 should NOT have processed the inactive chunk
    db.close();
  });

  it('getQueueStats returns correct counts per status', async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const generator = new MockGenerator(EXTRACTION_RESPONSE);

    // One completed
    await retain(db, 'fact one', embedder, { memoryType: 'world' });
    await processExtractionQueue(db, generator);

    // One pending
    await retain(db, 'fact two', embedder, { memoryType: 'world' });

    const stats = getQueueStats(db);
    expect(stats.completed).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.oldest_pending).toBeTruthy();

    db.close();
  });

  it('getQueueStats returns zeros on empty queue', () => {
    const db = createTestDb();
    const stats = getQueueStats(db);
    expect(stats.pending).toBe(0);
    expect(stats.processing).toBe(0);
    expect(stats.completed).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.oldest_pending).toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// retainBatch dedup
// ---------------------------------------------------------------------------

describe('retainBatch() intra-batch dedup', () => {
  let db: Database.Database;
  const embedder = new MockEmbedder();

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('deduplicates identical items within a batch', async () => {
    const items = [
      { text: 'Tom uses Terraform' },
      { text: 'Tom uses Terraform' },
      { text: 'Tom uses Terraform' },
    ];
    const results = await retainBatch(db, items, embedder);

    // All should resolve to the same chunkId
    expect(results[0].chunkId).toBe(results[1].chunkId);
    expect(results[0].chunkId).toBe(results[2].chunkId);

    // Only one chunk should exist in the DB
    const count = db.prepare(`SELECT COUNT(*) as cnt FROM chunks`).get() as any;
    expect(count.cnt).toBe(1);
  });

  it('deduplicates case/whitespace-normalized duplicates', async () => {
    const items = [
      { text: 'Tom uses Terraform' },
      { text: 'tom  uses  terraform' },
    ];
    const results = await retainBatch(db, items, embedder);

    expect(results[1].deduplicated).toBe(true);
    expect(results[0].chunkId).toBe(results[1].chunkId);
  });
});

// ---------------------------------------------------------------------------
// chunkText()
// ---------------------------------------------------------------------------

describe('chunkText()', () => {
  it('returns single chunk for short text', () => {
    const result = chunkText('Short text here.', { maxChunkChars: 1000 });
    expect(result).toEqual(['Short text here.']);
  });

  it('returns empty array for empty text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  it('splits long text at paragraph boundaries', () => {
    const text =
      'Paragraph one about Terraform.\n\nParagraph two about Kubernetes.\n\nParagraph three about SQLite.';
    const chunks = chunkText(text, { maxChunkChars: 50, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('Terraform');
  });

  it('no chunk exceeds maxChunkChars', () => {
    const paragraphs = Array.from(
      { length: 20 },
      (_, i) =>
        `This is paragraph ${i} with enough words to be meaningful content.`,
    ).join('\n\n');
    const chunks = chunkText(paragraphs, {
      maxChunkChars: 200,
      overlapChars: 0,
    });
    const withinLimit = chunks.filter((c) => c.length <= 200);
    expect(withinLimit.length).toBe(chunks.length);
  });

  it('applies overlap from previous chunk', () => {
    const text =
      'AAAA first section content.\n\nBBBB second section content.\n\nCCCC third section content.';
    const chunks = chunkText(text, { maxChunkChars: 50, overlapChars: 10 });
    if (chunks.length >= 2) {
      const tail = chunks[0].slice(-10).trim();
      expect(chunks[1].startsWith(tail)).toBe(true);
    }
  });
});
