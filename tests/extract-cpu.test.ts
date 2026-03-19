import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { extractEntitiesCpu } from '../src/extract-cpu.js';
import { createTestDb } from './helpers.js';

describe('extractEntitiesCpu', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  /** Insert a chunk so foreign key constraints are satisfied. */
  function insertChunk(chunkId: string, text: string): void {
    db.prepare(
      `INSERT INTO chunks (id, text, memory_type) VALUES (?, ?, 'world')`
    ).run(chunkId, text);
  }

  // -------------------------------------------------------------------------
  // 1. Graph matching — link to pre-existing entity
  // -------------------------------------------------------------------------

  it('links chunk to pre-existing entity via graph matching', () => {
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, aliases)
       VALUES ('ent-terraform', 'Terraform', 'terraform', 'technology', '[]')`
    ).run();

    const chunkId = 'chk-graph-1';
    const text = 'I use Terraform daily';
    insertChunk(chunkId, text);

    const result = extractEntitiesCpu(db, chunkId, text);

    expect(result.entitiesLinked).toBeGreaterThanOrEqual(1);

    const link = db.prepare(
      `SELECT * FROM chunk_entities WHERE chunk_id = ? AND entity_id = 'ent-terraform'`
    ).get(chunkId);
    expect(link).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 2. Proper noun detection
  // -------------------------------------------------------------------------

  it('creates entities for proper nouns', () => {
    const chunkId = 'chk-propernoun-1';
    // "Tom" is at index 0 (sentence start) so Strategy 2 skips it.
    // Use a sentence where proper nouns appear mid-sentence.
    const text = 'We asked Tom about Terraform today';
    insertChunk(chunkId, text);

    const result = extractEntitiesCpu(db, chunkId, text);

    const tom = db.prepare(
      `SELECT * FROM entities WHERE canonical_name = 'tom'`
    ).get() as any;
    const terraform = db.prepare(
      `SELECT * FROM entities WHERE canonical_name = 'terraform'`
    ).get() as any;

    expect(tom).toBeTruthy();
    expect(terraform).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 3. Technical term detection (kebab-case)
  // -------------------------------------------------------------------------

  it('creates technology entities for kebab-case terms', () => {
    const chunkId = 'chk-tech-1';
    const text = 'using better-sqlite3 with sqlite-vec';
    insertChunk(chunkId, text);

    const result = extractEntitiesCpu(db, chunkId, text);

    const betterSqlite = db.prepare(
      `SELECT * FROM entities WHERE canonical_name = 'better-sqlite3'`
    ).get() as any;
    const sqliteVec = db.prepare(
      `SELECT * FROM entities WHERE canonical_name = 'sqlite-vec'`
    ).get() as any;

    expect(betterSqlite).toBeTruthy();
    expect(betterSqlite?.entity_type).toBe('technology');
    expect(sqliteVec).toBeTruthy();
    expect(sqliteVec?.entity_type).toBe('technology');
  });

  // -------------------------------------------------------------------------
  // 4. Relation: uses
  // -------------------------------------------------------------------------

  it('creates relation for "X uses Y"', () => {
    // Pre-create entities so relation template can find them
    db.prepare(`INSERT INTO entities (id, name, canonical_name, entity_type, aliases) VALUES ('ent-tom', 'Tom', 'tom', 'person', '[]')`).run();
    db.prepare(`INSERT INTO entities (id, name, canonical_name, entity_type, aliases) VALUES ('ent-terraform', 'Terraform', 'terraform', 'technology', '[]')`).run();

    const chunkId = 'chk-rel-uses';
    const text = 'Tom uses Terraform';
    insertChunk(chunkId, text);

    const result = extractEntitiesCpu(db, chunkId, text);

    expect(result.relationsCreated).toBeGreaterThanOrEqual(1);

    const rel = db.prepare(
      `SELECT * FROM relations WHERE relation_type = 'uses'`
    ).get() as any;
    expect(rel).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 5. Relation: prefers
  // -------------------------------------------------------------------------

  it('creates relation for "X prefers Y"', () => {
    // Pre-create entities
    db.prepare(`INSERT INTO entities (id, name, canonical_name, entity_type, aliases) VALUES ('ent-tom', 'Tom', 'tom', 'person', '[]')`).run();
    db.prepare(`INSERT INTO entities (id, name, canonical_name, entity_type, aliases) VALUES ('ent-sqlite', 'Sqlite', 'sqlite', 'technology', '[]')`).run();

    const chunkId = 'chk-rel-prefers';
    const text = 'Tom prefers Sqlite';
    insertChunk(chunkId, text);

    const result = extractEntitiesCpu(db, chunkId, text);

    expect(result.relationsCreated).toBeGreaterThanOrEqual(1);

    const rel = db.prepare(
      `SELECT * FROM relations WHERE relation_type = 'prefers'`
    ).get() as any;
    expect(rel).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 6. Relation: switched to
  // -------------------------------------------------------------------------

  it('creates relation for "X switched to Y"', () => {
    // Pre-create entities
    db.prepare(`INSERT INTO entities (id, name, canonical_name, entity_type, aliases) VALUES ('ent-tom', 'Tom', 'tom', 'person', '[]')`).run();
    db.prepare(`INSERT INTO entities (id, name, canonical_name, entity_type, aliases) VALUES ('ent-pulumi', 'Pulumi', 'pulumi', 'technology', '[]')`).run();

    const chunkId = 'chk-rel-switched';
    const text = 'Tom switched to Pulumi';
    insertChunk(chunkId, text);

    const result = extractEntitiesCpu(db, chunkId, text);

    expect(result.relationsCreated).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 7. Case insensitivity — lowercase text matches existing entity
  // -------------------------------------------------------------------------

  it('matches entities case-insensitively', () => {
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, aliases)
       VALUES ('ent-terraform', 'Terraform', 'terraform', 'technology', '[]')`
    ).run();

    const chunkId = 'chk-case-1';
    const text = 'we deployed terraform today';
    insertChunk(chunkId, text);

    const result = extractEntitiesCpu(db, chunkId, text);

    expect(result.entitiesLinked).toBeGreaterThanOrEqual(1);

    const link = db.prepare(
      `SELECT * FROM chunk_entities WHERE chunk_id = ? AND entity_id = 'ent-terraform'`
    ).get(chunkId);
    expect(link).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 8. No false positives on common words
  // -------------------------------------------------------------------------

  it('does not create entities for common words', () => {
    const chunkId = 'chk-common-1';
    const text = 'The Quick Brown Fox';
    insertChunk(chunkId, text);

    extractEntitiesCpu(db, chunkId, text);

    // "The" should never be an entity
    const theEntity = db.prepare(
      `SELECT * FROM entities WHERE canonical_name = 'the'`
    ).get();
    expect(theEntity).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 9. Dedup safety — calling twice increments mention_count, no duplicates
  // -------------------------------------------------------------------------

  it('increments mention_count on duplicate, does not create duplicate entities', () => {
    const text = 'Tom uses Terraform';

    const chunkId1 = 'chk-dedup-1';
    insertChunk(chunkId1, text);
    extractEntitiesCpu(db, chunkId1, text);

    const afterFirst = db.prepare(
      `SELECT mention_count FROM entities WHERE canonical_name = 'terraform'`
    ).get() as any;
    const firstCount = afterFirst?.mention_count ?? 0;

    const chunkId2 = 'chk-dedup-2';
    insertChunk(chunkId2, text);
    extractEntitiesCpu(db, chunkId2, text);

    const afterSecond = db.prepare(
      `SELECT mention_count FROM entities WHERE canonical_name = 'terraform'`
    ).get() as any;
    expect(afterSecond.mention_count).toBeGreaterThan(firstCount);

    // Should still be exactly one entity row for terraform
    const count = db.prepare(
      `SELECT COUNT(*) as cnt FROM entities WHERE canonical_name = 'terraform'`
    ).get() as any;
    expect(count.cnt).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 10. Empty text
  // -------------------------------------------------------------------------

  it('returns zeros for empty text', () => {
    const chunkId = 'chk-empty-1';
    insertChunk(chunkId, '');

    const result = extractEntitiesCpu(db, chunkId, '');

    expect(result.entitiesLinked).toBe(0);
    expect(result.relationsCreated).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 11. Performance — 50 pre-existing entities, 100-char text completes fast
  // -------------------------------------------------------------------------

  it('completes extraction with 50 pre-existing entities without timeout', () => {
    // Seed 50 entities
    const insert = db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, aliases)
       VALUES (?, ?, ?, 'technology', '[]')`
    );
    for (let i = 0; i < 50; i++) {
      const name = `tech-entity-${i}`;
      insert.run(`ent-${name}`, name, name);
    }

    const chunkId = 'chk-perf-1';
    const text = 'This is a moderately long text about tech-entity-7 and tech-entity-42 that should be processed quickly by the CPU extractor';
    insertChunk(chunkId, text);

    const start = performance.now();
    const result = extractEntitiesCpu(db, chunkId, text);
    const elapsed = performance.now() - start;

    // Should complete — the test itself acts as a timeout guard
    expect(result).toBeDefined();
    expect(result.entitiesLinked).toBeGreaterThanOrEqual(0);
    // Sanity: should finish well within vitest's default timeout
    expect(elapsed).toBeLessThan(5000);
  });
});
