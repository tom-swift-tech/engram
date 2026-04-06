import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { retain } from '../src/retain.js';
import { reflect } from '../src/reflect.js';
import {
  MockEmbedder,
  loadSchema,
  tmpDbPath,
  cleanupDb,
  mockOllamaFetch,
  REFLECT_RESPONSE,
} from './helpers.js';

// Helpers
const embedder = new MockEmbedder();

/** Create a temp file db, insert n facts, close it. */
async function setupDb(path: string, factCount: number): Promise<void> {
  const db = new Database(path);
  loadSchema(db);
  for (let i = 0; i < factCount; i++) {
    await retain(db, `Alice prefers Rust — fact ${i}`, embedder, {
      memoryType: 'world',
      sourceType: 'user_stated',
      trustScore: 0.8,
    });
  }
  db.close();
}

// ---------------------------------------------------------------------------
// reflect()
// ---------------------------------------------------------------------------

describe('reflect()', () => {
  let dbPath: string;

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanupDb(dbPath);
  });

  it('skips when fewer than minFactsThreshold facts exist', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 2); // below default threshold of 5

    // fetch should never be called — we set a mock that would fail the test if invoked
    vi.stubGlobal('fetch', async () => {
      throw new Error('fetch should not be called when threshold not met');
    });

    const result = await reflect({ dbPath });
    expect(result.status).toBe('completed');
    expect(result.factsProcessed).toBe(0);
  });

  it('processes facts when threshold is met', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);
    vi.stubGlobal('fetch', mockOllamaFetch(REFLECT_RESPONSE));

    const result = await reflect({ dbPath });
    expect(result.status).toBe('completed');
    expect(result.factsProcessed).toBe(5);
  });

  it('creates observations from LLM output', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);
    vi.stubGlobal('fetch', mockOllamaFetch(REFLECT_RESPONSE));

    const result = await reflect({ dbPath });
    expect(result.observationsCreated).toBe(1);

    const db = new Database(dbPath);
    const obs = db.prepare('SELECT * FROM observations').all() as any[];
    db.close();
    expect(obs).toHaveLength(1);
    expect(obs[0].summary).toContain('Alice');
  });

  it('forms new opinions from LLM output', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);
    vi.stubGlobal('fetch', mockOllamaFetch(REFLECT_RESPONSE));

    const result = await reflect({ dbPath });
    expect(result.opinionsFormed).toBe(1);

    const db = new Database(dbPath);
    const ops = db.prepare('SELECT * FROM opinions').all() as any[];
    db.close();
    expect(ops).toHaveLength(1);
    expect(ops[0].belief).toContain('Alice');
    expect(ops[0].confidence).toBeGreaterThan(0);
    expect(ops[0].confidence).toBeLessThanOrEqual(0.7);
  });

  it('marks all processed facts as reflected', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);
    vi.stubGlobal('fetch', mockOllamaFetch(REFLECT_RESPONSE));

    await reflect({ dbPath });

    const db = new Database(dbPath);
    const unreflected = db
      .prepare(`SELECT count(*) as n FROM chunks WHERE reflected_at IS NULL`)
      .get() as { n: number };
    db.close();
    expect(unreflected.n).toBe(0);
  });

  it('writes a completed reflect_log entry', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);
    vi.stubGlobal('fetch', mockOllamaFetch(REFLECT_RESPONSE));

    const result = await reflect({ dbPath });

    const db = new Database(dbPath);
    const log = db
      .prepare('SELECT * FROM reflect_log WHERE id = ?')
      .get(result.logId) as any;
    db.close();

    expect(log.status).toBe('completed');
    expect(log.facts_processed).toBe(5);
    expect(log.observations_created).toBe(1);
    expect(log.opinions_formed).toBe(1);
    expect(log.completed_at).toBeTruthy();
  });

  it('completes with zero observations when LLM returns unparseable output', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);
    vi.stubGlobal('fetch', mockOllamaFetch('this is not json at all'));

    const result = await reflect({ dbPath });
    // Graceful recovery: unparseable JSON → empty arrays, not failure
    expect(result.status).toBe('completed');
    expect(result.observationsCreated).toBe(0);
    expect(result.opinionsFormed).toBe(0);
  });

  it('does not mark facts as reflected when parse produces no insights', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 3);
    vi.stubGlobal('fetch', mockOllamaFetch('this is not json at all'));

    await reflect({ dbPath });

    // Facts should still be unreflected so the next cycle can retry them
    const db = new Database(dbPath);
    const unreflected = db
      .prepare(`SELECT COUNT(*) as cnt FROM chunks WHERE reflected_at IS NULL`)
      .get() as any;
    expect(unreflected.cnt).toBe(3);
    db.close();
  });

  it('sets status to failed when Ollama is unreachable', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);
    vi.stubGlobal(
      'fetch',
      async () =>
        ({
          ok: false,
          status: 503,
          text: async () => 'Service Unavailable',
        }) as unknown as Response,
    );

    const result = await reflect({ dbPath });
    expect(result.status).toBe('failed');
  });

  it('records durationMs in result', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);
    vi.stubGlobal('fetch', mockOllamaFetch(REFLECT_RESPONSE));

    const result = await reflect({ dbPath });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reinforces only the opinion in the matching domain, not a same-belief in a different domain', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);

    const db = new Database(dbPath);
    // Same belief text, different domains
    db.prepare(
      `
      INSERT INTO opinions (id, belief, confidence, domain, supporting_chunks, related_entities)
      VALUES ('op-infra', 'Kubernetes is the preferred orchestration platform', 0.7, 'infrastructure', '[]', '[]')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO opinions (id, belief, confidence, domain, supporting_chunks, related_entities)
      VALUES ('op-dev', 'Kubernetes is the preferred orchestration platform', 0.7, 'development', '[]', '[]')
    `,
    ).run();
    db.close();

    // Reinforce only the 'infrastructure' domain opinion
    vi.stubGlobal(
      'fetch',
      mockOllamaFetch(
        JSON.stringify({
          observations: [],
          opinion_updates: [
            {
              belief: 'Kubernetes is the preferred orchestration platform',
              direction: 'reinforce',
              confidence_delta: 0.1,
              domain: 'infrastructure',
              evidence_chunk_ids: ['chk-x'],
              entity_names: [],
            },
          ],
          observation_refreshes: [],
        }),
      ),
    );

    const result = await reflect({ dbPath });
    expect(result.opinionsReinforced).toBe(1);

    const verify = new Database(dbPath);
    const opinions = verify
      .prepare(
        `
      SELECT id, confidence FROM opinions WHERE id IN ('op-infra', 'op-dev')
    `,
      )
      .all() as Array<{ id: string; confidence: number }>;
    verify.close();

    const infra = opinions.find((op) => op.id === 'op-infra')!;
    const dev = opinions.find((op) => op.id === 'op-dev')!;
    // Only the infrastructure opinion should have increased confidence
    expect(infra.confidence).toBeGreaterThan(0.7);
    expect(dev.confidence).toBe(0.7);
  });

  it('reinforces the exact matching opinion instead of a same-prefix sibling', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);

    const db = new Database(dbPath);
    db.prepare(
      `
      INSERT INTO opinions (id, belief, confidence, domain, supporting_chunks, related_entities)
      VALUES ('op-1', 'Tom prefers Terraform for all infrastructure work', 0.7, 'infrastructure', '[]', '[]')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO opinions (id, belief, confidence, domain, supporting_chunks, related_entities)
      VALUES ('op-2', 'Tom prefers Terraform for all production deployments', 0.7, 'infrastructure', '[]', '[]')
    `,
    ).run();
    db.close();

    vi.stubGlobal(
      'fetch',
      mockOllamaFetch(
        JSON.stringify({
          observations: [],
          opinion_updates: [
            {
              belief: 'Tom prefers Terraform for all production deployments',
              direction: 'reinforce',
              confidence_delta: 0.1,
              domain: 'infrastructure',
              evidence_chunk_ids: ['chk-1'],
              entity_names: [],
            },
          ],
          observation_refreshes: [],
        }),
      ),
    );

    const result = await reflect({ dbPath });
    expect(result.opinionsReinforced).toBe(1);

    const verify = new Database(dbPath);
    const opinions = verify
      .prepare(
        `
      SELECT id, belief, confidence
      FROM opinions
      WHERE id IN ('op-1', 'op-2')
      ORDER BY id
    `,
      )
      .all() as Array<{ id: string; belief: string; confidence: number }>;
    verify.close();

    expect(opinions.find((op) => op.id === 'op-1')?.confidence).toBe(0.7);
    expect(opinions.find((op) => op.id === 'op-2')?.confidence).toBeGreaterThan(
      0.7,
    );
  });

  it('reinforces via fuzzy match when belief text differs slightly', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);

    const db = new Database(dbPath);
    // Stored belief has slightly different wording than what the LLM will output
    db.prepare(
      `
      INSERT INTO opinions (id, belief, confidence, domain, supporting_chunks, related_entities)
      VALUES ('op-fuzzy', 'Alice strongly prefers Rust over other systems languages for performance work', 0.6, 'preferences', '[]', '[]')
    `,
    ).run();
    db.close();

    // LLM outputs a belief that is similar but not identical (triggers beliefSimilarity >= 0.85)
    vi.stubGlobal(
      'fetch',
      mockOllamaFetch(
        JSON.stringify({
          observations: [],
          opinion_updates: [
            {
              belief:
                'Alice strongly prefers Rust over other systems languages for performance tasks',
              direction: 'reinforce',
              confidence_delta: 0.1,
              domain: 'preferences',
              evidence_chunk_ids: ['chk-fuzzy'],
              entity_names: [],
            },
          ],
          observation_refreshes: [],
        }),
      ),
    );

    const result = await reflect({ dbPath });
    expect(result.opinionsReinforced).toBe(1);

    const verify = new Database(dbPath);
    const op = verify
      .prepare(`SELECT confidence FROM opinions WHERE id = 'op-fuzzy'`)
      .get() as { confidence: number };
    verify.close();

    // With row-ID-based UPDATE, fuzzy match successfully updates the opinion
    expect(op.confidence).toBeGreaterThan(0.6);
  });

  it('decays stale opinions not reinforced in 30+ days', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);

    const db = new Database(dbPath);
    // Insert an opinion that hasn't been reinforced in 60 days and not updated in 8 days
    db.prepare(`
      INSERT INTO opinions (id, belief, confidence, domain, supporting_chunks, related_entities,
        last_reinforced, updated_at)
      VALUES ('op-stale', 'Stale opinion', 0.8, 'test', '[]', '[]',
        datetime('now', '-60 days'), datetime('now', '-8 days'))
    `).run();
    db.close();

    // Reflect will apply decay before gathering facts
    vi.stubGlobal('fetch', mockOllamaFetch(JSON.stringify({
      observations: [],
      opinion_updates: [],
      observation_refreshes: [],
    })));

    await reflect({ dbPath });

    const verify = new Database(dbPath);
    const op = verify.prepare(`SELECT confidence FROM opinions WHERE id = 'op-stale'`).get() as { confidence: number };
    verify.close();

    expect(op.confidence).toBeCloseTo(0.78, 2);
  });

  it('dampens reinforcement when evidence is agent-generated', async () => {
    dbPath = tmpDbPath();
    await setupDb(dbPath, 5);

    const db = new Database(dbPath);
    // Insert an existing opinion to be reinforced
    db.prepare(`
      INSERT INTO opinions (id, belief, confidence, domain, supporting_chunks, related_entities)
      VALUES ('op-agent', 'Agent-reinforced belief', 0.6, 'test', '[]', '[]')
    `).run();

    // Insert agent-generated chunks as evidence
    const chunkIds = ['chk-ag1', 'chk-ag2'];
    for (const id of chunkIds) {
      db.prepare(`
        INSERT INTO chunks (id, text, embedding, memory_type, source_type, trust_score)
        VALUES (?, 'agent output', zeroblob(32), 'world', 'agent_generated', 0.5)
      `).run(id);
    }
    db.close();

    vi.stubGlobal('fetch', mockOllamaFetch(JSON.stringify({
      observations: [],
      opinion_updates: [{
        belief: 'Agent-reinforced belief',
        direction: 'reinforce',
        confidence_delta: 0.10,
        domain: 'test',
        evidence_chunk_ids: chunkIds,
        entity_names: [],
      }],
      observation_refreshes: [],
    })));

    const result = await reflect({ dbPath });
    expect(result.opinionsReinforced).toBe(1);

    const verify = new Database(dbPath);
    const op = verify.prepare(`SELECT confidence FROM opinions WHERE id = 'op-agent'`).get() as { confidence: number };
    verify.close();

    // With dampening (0.5x), delta of 0.10 becomes 0.05, so 0.6 + 0.05 = 0.65
    expect(op.confidence).toBeCloseTo(0.65, 2);
  });
});
