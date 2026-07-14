import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { introspect } from '../src/introspect.js';
import { loadSchema, tmpDbPath, cleanupDb } from './helpers.js';

// ---------------------------------------------------------------------------
// introspect() — projection-only read primitive for held state
// ---------------------------------------------------------------------------

let dbPath: string;

afterEach(() => {
  cleanupDb(dbPath);
});

/** Insert an opinion row with sensible defaults; override any column. */
function insertOpinion(
  db: Database.Database,
  o: {
    id: string;
    belief: string;
    confidence: number;
    domain?: string;
    supporting?: string[];
    contradicting?: string[];
    evidenceCount?: number;
    relatedEntities?: string[];
    lastReinforced?: string | null;
    lastChallenged?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO opinions
       (id, belief, confidence, supporting_chunks, contradicting_chunks,
        evidence_count, domain, related_entities, formed_at, last_reinforced,
        last_challenged, updated_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP, TRUE)`,
  ).run(
    o.id,
    o.belief,
    o.confidence,
    JSON.stringify(o.supporting ?? []),
    JSON.stringify(o.contradicting ?? []),
    o.evidenceCount ?? o.supporting?.length ?? 0,
    o.domain ?? null,
    JSON.stringify(o.relatedEntities ?? []),
    o.lastReinforced ?? null,
    o.lastChallenged ?? null,
  );
}

function insertObservation(
  db: Database.Database,
  o: {
    id: string;
    summary: string;
    domain?: string;
    topic?: string;
    sourceChunks?: string[];
    refreshCount?: number;
  },
): void {
  db.prepare(
    `INSERT INTO observations
       (id, summary, source_chunks, source_entities, domain, topic,
        synthesized_at, last_refreshed, refresh_count, is_active)
     VALUES (?, ?, ?, '[]', ?, ?, CURRENT_TIMESTAMP, NULL, ?, TRUE)`,
  ).run(
    o.id,
    o.summary,
    JSON.stringify(o.sourceChunks ?? []),
    o.domain ?? null,
    o.topic ?? null,
    o.refreshCount ?? 0,
  );
}

function freshDb(): Database.Database {
  dbPath = tmpDbPath();
  const db = new Database(dbPath);
  loadSchema(db);
  return db;
}

describe('introspect()', () => {
  it('surfaces low-confidence beliefs that recall would hide (no confidence floor)', () => {
    const db = freshDb();
    // recall() gates opinions at confidence >= 0.5. introspect must NOT.
    insertOpinion(db, {
      id: 'op-weak',
      belief: 'Rust is the right choice for the engine core',
      confidence: 0.2,
      domain: 'architecture',
    });
    db.close();

    const result = introspect(new Database(dbPath), 'rust');
    expect(result.opinions).toHaveLength(1);
    expect(result.opinions[0].id).toBe('op-weak');
    expect(result.opinions[0].confidence).toBe(0.2);
  });

  it('projects the full evidence + lifecycle shape, including lastChallenged', () => {
    const db = freshDb();
    insertOpinion(db, {
      id: 'op-1',
      belief: 'Terraform with the bpg provider is preferred for Proxmox',
      confidence: 0.7,
      domain: 'infrastructure',
      supporting: ['c1', 'c2', 'c3'],
      contradicting: ['c9'],
      evidenceCount: 4,
      relatedEntities: ['e-terraform'],
      lastReinforced: '2026-06-01T00:00:00Z',
      lastChallenged: '2026-06-10T00:00:00Z',
    });
    db.close();

    const [op] = introspect(new Database(dbPath), 'terraform').opinions;
    // Counts are derived from the provenance arrays.
    expect(op.supportCount).toBe(3);
    expect(op.challengeCount).toBe(1);
    expect(op.supportingChunks).toEqual(['c1', 'c2', 'c3']);
    expect(op.contradictingChunks).toEqual(['c9']);
    expect(op.evidenceCount).toBe(4);
    expect(op.relatedEntities).toEqual(['e-terraform']);
    // The field recall drops entirely and Mira's list omitted — must be present.
    expect(op.lastReinforced).toBe('2026-06-01T00:00:00Z');
    expect(op.lastChallenged).toBe('2026-06-10T00:00:00Z');
    expect(op.formedAt).toBeTruthy();
    expect(op.updatedAt).toBeTruthy();
  });

  it('lexically matches subject across belief and domain, ordered by confidence DESC', () => {
    const db = freshDb();
    insertOpinion(db, {
      id: 'op-hi',
      belief: 'Kubernetes is over-engineered for a homelab',
      confidence: 0.9,
      domain: 'infrastructure',
    });
    insertOpinion(db, {
      id: 'op-lo',
      belief: 'The homelab should stay single-node',
      confidence: 0.4,
      domain: 'kubernetes',
    });
    insertOpinion(db, {
      id: 'op-unrelated',
      belief: 'TypeScript beats JavaScript for libraries',
      confidence: 0.95,
      domain: 'development',
    });
    db.close();

    const result = introspect(new Database(dbPath), 'kubernetes');
    // op-hi matches on belief text, op-lo matches on domain; unrelated excluded.
    expect(result.opinions.map((o) => o.id)).toEqual(['op-hi', 'op-lo']);
  });

  it('honors an explicit minConfidence floor when the caller opts in', () => {
    const db = freshDb();
    insertOpinion(db, { id: 'a', belief: 'rust is fast', confidence: 0.3 });
    insertOpinion(db, { id: 'b', belief: 'rust is safe', confidence: 0.8 });
    db.close();

    const result = introspect(new Database(dbPath), 'rust', {
      minConfidence: 0.5,
    });
    expect(result.opinions.map((o) => o.id)).toEqual(['b']);
  });

  it('returns observations matching the subject', () => {
    const db = freshDb();
    insertObservation(db, {
      id: 'obs-1',
      summary: 'The agent consistently prefers local-first inference',
      domain: 'preferences',
      topic: 'inference',
      sourceChunks: ['c1', 'c2'],
      refreshCount: 2,
    });
    db.close();

    const [obs] = introspect(new Database(dbPath), 'inference').observations;
    expect(obs.id).toBe('obs-1');
    expect(obs.sourceChunks).toEqual(['c1', 'c2']);
    expect(obs.refreshCount).toBe(2);
    expect(obs.topic).toBe('inference');
  });

  it('returns top held state overall when no subject is given', () => {
    const db = freshDb();
    insertOpinion(db, { id: 'a', belief: 'alpha', confidence: 0.9 });
    insertOpinion(db, { id: 'b', belief: 'beta', confidence: 0.1 });
    insertObservation(db, { id: 'obs', summary: 'gamma' });
    db.close();

    const result = introspect(new Database(dbPath));
    expect(result.subject).toBeNull();
    expect(result.opinions).toHaveLength(2);
    expect(result.observations).toHaveLength(1);
    // Still ordered by confidence DESC.
    expect(result.opinions.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('respects the include toggles and the limit', () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      insertOpinion(db, {
        id: `op-${i}`,
        belief: `rust ${i}`,
        confidence: 0.5,
      });
    }
    insertObservation(db, { id: 'obs', summary: 'rust observation' });
    db.close();

    const noObs = introspect(new Database(dbPath), 'rust', {
      includeObservations: false,
    });
    expect(noObs.observations).toHaveLength(0);
    expect(noObs.opinions.length).toBeGreaterThan(0);

    const limited = introspect(new Database(dbPath), 'rust', { limit: 2 });
    expect(limited.opinions).toHaveLength(2);

    const noOps = introspect(new Database(dbPath), 'rust', {
      includeOpinions: false,
    });
    expect(noOps.opinions).toHaveLength(0);
    expect(noOps.observations).toHaveLength(1);
  });

  it('excludes soft-deleted (is_active = FALSE) opinions', () => {
    const db = freshDb();
    insertOpinion(db, { id: 'live', belief: 'rust rules', confidence: 0.7 });
    db.prepare(
      `INSERT INTO opinions (id, belief, confidence, is_active) VALUES ('dead', 'rust is dead', 0.7, FALSE)`,
    ).run();
    db.close();

    const result = introspect(new Database(dbPath), 'rust');
    expect(result.opinions.map((o) => o.id)).toEqual(['live']);
  });
});
