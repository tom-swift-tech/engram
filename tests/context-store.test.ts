import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { recall } from '../src/recall.js';
import { retain } from '../src/retain.js';
import {
  commitContext,
  queryContext,
  expireContext,
  promoteToDurable,
  type DecisionArtifact,
} from '../src/context-store.js';
import { createTestDb, MockEmbedder } from './helpers.js';

describe('ContextStore', () => {
  let db: Database.Database;
  const embedder = new MockEmbedder();

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  const artifact = (
    decision: string,
    extra?: Partial<DecisionArtifact>,
  ): DecisionArtifact => ({
    decision,
    rationale: `because ${decision}`,
    confidence: 0.8,
    agentId: 'lead-tier1',
    ...extra,
  });

  // ---------------------------------------------------------------------------
  // commit/query round-trip
  // ---------------------------------------------------------------------------

  it('commits an artifact and queries it back as a child of its parent scope', async () => {
    const root = await commitContext(
      db,
      embedder,
      artifact('root task started'),
    );
    const child = await commitContext(
      db,
      embedder,
      artifact('use Terraform for IaC'),
      {
        parent: root,
      },
    );
    expect(child.scope).toBe('task');

    const slice = await queryContext(
      db,
      embedder,
      root,
      'Terraform IaC decision',
    );
    expect(slice.artifacts).toHaveLength(1);
    expect(slice.artifacts[0].ref.id).toBe(child.id);
    expect(slice.artifacts[0].artifact.decision).toBe('use Terraform for IaC');
    expect(slice.truncated).toBe(false);
  });

  it('a fresh commit is queryable as a child of itself only if referenced as parent', async () => {
    const root = await commitContext(
      db,
      embedder,
      artifact('root task started'),
    );
    const child = await commitContext(
      db,
      embedder,
      artifact('picked option A'),
      {
        parent: root,
      },
    );

    // Querying the root's own ref returns its children, not the root itself.
    const slice = await queryContext(db, embedder, root, 'option A');
    expect(slice.artifacts.map((a) => a.ref.id)).toEqual([child.id]);
  });

  it('rejects a commit whose parent ref does not exist', async () => {
    await expect(
      commitContext(db, embedder, artifact('orphan'), {
        parent: { id: 'ctx-does-not-exist', scope: 'task' },
      }),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // TTL expiry (lazy, read-time)
  // ---------------------------------------------------------------------------

  it('excludes an artifact past its TTL from query(), with no reaper involved', async () => {
    const root = await commitContext(db, embedder, artifact('root'));
    const child = await commitContext(
      db,
      embedder,
      artifact('short-lived note'),
      {
        parent: root,
        ttlMs: -1, // already expired the instant it's committed
      },
    );

    // Row still physically exists (is_active untouched) — only the read is filtered.
    const row = db
      .prepare('SELECT is_active, scope FROM chunks WHERE id = ?')
      .get(child.id) as {
      is_active: number;
      scope: string;
    };
    expect(row.is_active).toBe(1);
    expect(row.scope).toBe('task');

    const slice = await queryContext(db, embedder, root, 'short-lived note');
    expect(slice.artifacts).toHaveLength(0);
  });

  it('never surfaces task-scoped artifacts from a default recall() call', async () => {
    await retain(db, 'a durable long-term fact', embedder, {
      memoryType: 'world',
    });
    const root = await commitContext(db, embedder, artifact('root'));
    await commitContext(
      db,
      embedder,
      artifact('a task-scoped decision about Terraform'),
      {
        parent: root,
      },
    );

    const response = await recall(db, 'Terraform decision', embedder, {
      strategies: ['keyword'],
    });
    expect(
      response.results.every(
        (r) => r.text !== 'a task-scoped decision about Terraform',
      ),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Budget truncation
  // ---------------------------------------------------------------------------

  it('truncates results to fit the budget and flags truncation', async () => {
    const root = await commitContext(db, embedder, artifact('root'));
    // Every artifact is the same shape/size, so its serialized length is
    // deterministic — compute it instead of guessing, so the budget below
    // reliably admits exactly 2 of the 5 committed artifacts.
    const sampleSize = JSON.stringify(
      artifact('decision 0 about widgets'),
    ).length;
    for (let i = 0; i < 5; i++) {
      await commitContext(
        db,
        embedder,
        artifact(`decision ${i} about widgets`),
        {
          parent: root,
        },
      );
    }

    const tight = await queryContext(db, embedder, root, 'widgets decision', {
      maxChars: sampleSize * 2 + 1,
    });
    expect(tight.artifacts).toHaveLength(2);
    expect(tight.truncated).toBe(true);

    const generous = await queryContext(
      db,
      embedder,
      root,
      'widgets decision',
      {
        maxChars: 1_000_000,
      },
    );
    expect(generous.artifacts).toHaveLength(5);
    expect(generous.truncated).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // RRF-fusion parity
  // ---------------------------------------------------------------------------

  it('ranks task-scoped results consistently with a direct recall() call using the same scope filter', async () => {
    const root = await commitContext(db, embedder, artifact('root'));
    await commitContext(
      db,
      embedder,
      artifact('prefers Rust for systems programming'),
      {
        parent: root,
      },
    );
    await commitContext(db, embedder, artifact('a recipe for chocolate cake'), {
      parent: root,
    });

    const direct = await recall(db, 'Rust systems programming', embedder, {
      scope: ['task'],
      parentRef: root.id,
      includeOpinions: false,
      includeObservations: false,
    });
    const slice = await queryContext(
      db,
      embedder,
      root,
      'Rust systems programming',
      {
        maxChars: 1_000_000,
      },
    );

    expect(slice.artifacts.map((a) => a.ref.id)).toEqual(
      direct.results.map((r) => r.id),
    );
  });

  // ---------------------------------------------------------------------------
  // expire()
  // ---------------------------------------------------------------------------

  it('expireContext soft-deletes an artifact ahead of its natural TTL', async () => {
    const root = await commitContext(db, embedder, artifact('root'));
    const child = await commitContext(
      db,
      embedder,
      artifact('to be expired early'),
      {
        parent: root,
      },
    );

    await expireContext(db, child);

    const row = db
      .prepare('SELECT is_active FROM chunks WHERE id = ?')
      .get(child.id) as {
      is_active: number;
    };
    expect(row.is_active).toBe(0);

    const slice = await queryContext(db, embedder, root, 'to be expired early');
    expect(slice.artifacts).toHaveLength(0);
  });

  it('expireContext throws for an unknown or already-expired ref', async () => {
    await expect(
      expireContext(db, { id: 'ctx-nope', scope: 'task' }),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Promotion seam
  // ---------------------------------------------------------------------------

  it('promoteToDurable flips scope and clears TTL/parent without running reflect', async () => {
    const root = await commitContext(db, embedder, artifact('root'));
    const child = await commitContext(db, embedder, artifact('worth keeping'), {
      parent: root,
    });

    await promoteToDurable(db, child);

    const row = db
      .prepare(
        'SELECT scope, expires_at, parent_ref, reflected_at FROM chunks WHERE id = ?',
      )
      .get(child.id) as {
      scope: string;
      expires_at: string | null;
      parent_ref: string | null;
      reflected_at: string | null;
    };
    expect(row.scope).toBe('durable');
    expect(row.expires_at).toBeNull();
    expect(row.parent_ref).toBeNull();
    expect(row.reflected_at).toBeNull(); // promotion doesn't run reflect itself

    // Now eligible for reflect's unreflected-facts query (scope='durable' AND memory_type IN (...)).
    const unreflected = db
      .prepare(
        `SELECT id FROM chunks WHERE reflected_at IS NULL AND is_active = TRUE AND scope = 'durable' AND memory_type IN ('world', 'experience')`,
      )
      .all() as Array<{ id: string }>;
    expect(unreflected.map((r) => r.id)).toContain(child.id);

    // And no longer reachable via queryContext (it's not task-scoped anymore).
    const slice = await queryContext(db, embedder, root, 'worth keeping');
    expect(slice.artifacts).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Integration example — shared parent, sibling artifacts, tight-budget child query
  // ---------------------------------------------------------------------------

  it('two artifacts under a shared parent scope: a child query pulls only the relevant one under a tight budget', async () => {
    const parent = await commitContext(
      db,
      embedder,
      artifact('lead: decompose the migration task'),
    );

    const dbDecision = artifact('use Postgres database for the service', {
      rationale: 'runs Postgres database in production already',
    });
    const uiDecision = artifact('use React for the frontend', {
      rationale: 'matches the existing component library',
    });
    const dbArtifact = await commitContext(db, embedder, dbDecision, {
      parent,
    });
    await commitContext(db, embedder, uiDecision, { parent });

    // A subagent handed only `parent` asks specifically about the database choice —
    // every query term is a literal substring of dbArtifact's text and absent
    // from uiArtifact's, so FTS5 keyword search ranks it first deterministically.
    // Budget fits exactly the top-ranked artifact, not both.
    const budget = JSON.stringify(dbDecision).length + 20;
    const slice = await queryContext(
      db,
      embedder,
      parent,
      'Postgres database production',
      {
        maxChars: budget,
      },
    );

    expect(slice.artifacts).toHaveLength(1);
    expect(slice.artifacts[0].ref.id).toBe(dbArtifact.id);
    expect(slice.truncated).toBe(true);
  });
});
