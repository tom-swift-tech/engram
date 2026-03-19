# Engram Sprint 1 — Working Memory + Auto-Session Switching

## Agent-Executable Implementation Plan

**Repo:** `G:\Projects\SIT\engram`
**Baseline:** v0.1.0, 87 tests passing, `npm test` green
**Breakage:** Zero — existing retain/recall/reflect unchanged
**Time estimate:** 4–5 hours for a coding agent
**License:** Apache 2.0

Copy this file to `docs/SPRINT-1-WORKING-MEMORY.md` and hand it to your coding agent.

---

## Objective

Add a `working_memory` table inside the existing `.engram` SQLite file and expose new methods on the `Engram` class so agents can maintain **isolated, auto-switching conversation contexts** when users jump topics ("check my email → post this on X → design gardening calendar"). Stale sessions auto-snapshot to episodic memory after a configurable period.

This is the foundation for the hybrid memory roadmap: working memory (short-term, per-conversation) layered on top of the existing long-term memory system.

---

## Success Criteria (verify all before marking complete)

1. Single `.engram` file only — no new folders or sidecar files
2. `engram.inferWorkingSession(message)` returns the correct session + related context
3. Context stays perfectly isolated across topic jumps
4. Old sessions auto-snapshot to episodic memory (experience chunks) on expiry
5. All existing tests still pass (`npm test` — 87 tests)
6. New test suite `tests/working-memory.test.ts` passes (12+ test cases)
7. `npm run build` and `npm run typecheck` clean

---

## Phase 0 — Prerequisites (5 minutes)

```bash
cd G:\Projects\SIT\engram
git pull
npm install
npm test          # confirm 87 tests pass
npm run typecheck # confirm zero type errors
```

---

## Phase 1 — Schema Addition (10 minutes)

**File:** `src/schema.sql`

Add this block at the end of the file, before any trailing comments. It follows the same `CREATE TABLE IF NOT EXISTS` pattern used by every other table in the schema — idempotent, safe on every `Engram.open()`.

```sql
-- =============================================================================
-- WORKING MEMORY
-- Short-term session state for auto-switching multi-topic conversations.
-- One row per active session. Expired sessions snapshot to chunks (experience).
-- Scope: one .engram file = one agent, so no agent_id column needed.
-- =============================================================================

CREATE TABLE IF NOT EXISTS working_memory (
    id TEXT PRIMARY KEY,
    task_id TEXT,                        -- optional external task/thread ID
    scope TEXT DEFAULT 'task',           -- 'task' | 'conversation' | 'project'
    data_json TEXT NOT NULL,             -- flexible JSON: { goal, ...agent-defined fields }
    seed_query TEXT,                     -- auto-derived query for recall seeding
    topic_embedding BLOB,               -- embedding of seed_query for similarity matching
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP                -- NULL = active; set when session is snapshotted
);

CREATE INDEX IF NOT EXISTS idx_wm_expires
    ON working_memory(expires_at);
```

**Why no `agent_id`:** Engram's architecture is one `.engram` file per agent. The file IS the agent boundary. Every other table (chunks, entities, etc.) scopes implicitly to the file.

**Why no `session_id UNIQUE`:** The `id` column is the primary key. External identifiers (Telegram thread IDs, etc.) go in `task_id` or inside `data_json`.

**Why no `markdown_cache` or `last_message_hash`:** Premature. Generate markdown on demand via `formatForPrompt()`. Message hashing has no consumer yet.

---

## Phase 2 — Types (5 minutes)

**File:** Create `src/working-memory-types.ts`

```typescript
// =============================================================================
// working-memory-types.ts — Types for Working Memory Sessions
// =============================================================================

export interface WorkingMemoryState {
  /** Session ID (matches working_memory.id) */
  id: string;
  /** The user's apparent goal for this session */
  goal: string;
  /** When this session state was last updated */
  updated_at: string;
  /** Agent-defined extensions — any additional session state */
  [key: string]: unknown;
}

export interface WorkingMemoryOptions {
  /** Max active (non-expired) sessions to keep. Oldest auto-snapshot when exceeded. Default: 5 */
  maxActive?: number;
  /** Cosine similarity threshold for matching an existing session. Default: 0.72 */
  threshold?: number;
  /** Hours before an untouched session auto-expires. Default: 48 */
  expireAfterHours?: number;
}

export interface WorkingSessionResult {
  /** The resolved or newly created session state */
  session: WorkingMemoryState;
  /** Formatted related context from long-term memory (output of formatForPrompt) */
  relatedContext: string;
  /** Cosine similarity score of the match (1.0 = new session) */
  confidence: number;
  /** Diagnostic info */
  diagnostics: {
    sessionId: string;
    reason: 'match' | 'new' | 'forced';
    candidatesEvaluated: number;
  };
}
```

---

## Phase 3 — Core Working Memory Methods (90 minutes)

**File:** `src/engram.ts`

Add these imports at the top of `engram.ts`, alongside the existing imports:

```typescript
import type {
  WorkingMemoryState,
  WorkingMemoryOptions,
  WorkingSessionResult,
} from './working-memory-types.js';
```

Add the re-export so consumers can import types from `'engram'`:

```typescript
export type { WorkingMemoryState, WorkingMemoryOptions, WorkingSessionResult };
```

Add the following methods to the `Engram` class. Place them after the existing `forgetBySource()` method, in a new section:

```typescript
  // ---------------------------------------------------------------------------
  // Working Memory — short-term session management
  // ---------------------------------------------------------------------------

  /**
   * Infer which working memory session an incoming message belongs to.
   * Embeds the message, cosine-matches against active sessions, and either
   * resumes the best match or creates a new session. Then loads related
   * long-term context via recall().
   *
   * This is the primary entry point for working memory. Call it once per
   * incoming user message, before the LLM call.
   */
  async inferWorkingSession(
    message: string,
    options: WorkingMemoryOptions = {}
  ): Promise<WorkingSessionResult> {
    const {
      maxActive = 5,
      threshold = 0.72,
      expireAfterHours = 48,
    } = options;

    // 1. Embed the incoming message
    const msgEmbedding = await this.embedder.embed(message);
    const embeddingBuffer = Buffer.from(msgEmbedding.buffer);

    // 2. Find active sessions and score by similarity
    let candidates: Array<{ id: string; data_json: string; similarity: number }>;
    try {
      candidates = this.db.prepare(`
        SELECT id, data_json,
               vec_distance_cosine(topic_embedding, ?) AS distance
        FROM working_memory
        WHERE (expires_at IS NULL OR expires_at > datetime('now'))
          AND topic_embedding IS NOT NULL
        ORDER BY distance ASC
        LIMIT 3
      `).all(embeddingBuffer) as Array<{ id: string; data_json: string; distance: number }> as any;

      // Convert distance to similarity (cosine distance → similarity = 1 - distance)
      candidates = (candidates as any[]).map((c: any) => ({
        id: c.id,
        data_json: c.data_json,
        similarity: 1 - (c.distance ?? 1),
      }));
    } catch {
      // sqlite-vec not loaded — no vector matching available
      candidates = [];
    }

    // 3. Pick best match or create new session
    let session: WorkingMemoryState;
    let confidence: number;
    let reason: 'match' | 'new';

    const best = candidates[0];
    if (best && best.similarity >= threshold) {
      // Resume existing session
      session = JSON.parse(best.data_json) as WorkingMemoryState;
      confidence = best.similarity;
      reason = 'match';

      // Touch the session timestamp
      this.db.prepare(
        `UPDATE working_memory SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(best.id);
    } else {
      // Create new session
      session = await this.createWorkingSession(message, embeddingBuffer);
      confidence = 1.0;
      reason = 'new';

      // Enforce maxActive — snapshot oldest if over the cap
      await this.enforceSessionCap(maxActive);
    }

    // 4. Load related long-term context using session state as seed
    const seed = `${session.goal}`;
    const recallResponse = await this.recall(seed, {
      topK: 8,
      snippetChars: 800,
    });
    const relatedContext = formatForPrompt(recallResponse, { maxChars: 1200 });

    return {
      session,
      relatedContext,
      confidence,
      diagnostics: {
        sessionId: session.id,
        reason,
        candidatesEvaluated: candidates.length,
      },
    };
  }

  /**
   * Create a new working memory session from a message.
   * Internal — called by inferWorkingSession when no match is found.
   */
  private async createWorkingSession(
    message: string,
    embeddingBuffer: Buffer
  ): Promise<WorkingMemoryState> {
    const id = `wm-${randomUUID().substring(0, 12)}`;
    const now = new Date().toISOString();

    const state: WorkingMemoryState = {
      id,
      goal: message.slice(0, 200),
      updated_at: now,
    };

    this.db.prepare(`
      INSERT INTO working_memory (id, data_json, seed_query, topic_embedding)
      VALUES (?, ?, ?, ?)
    `).run(id, JSON.stringify(state), message.slice(0, 200), embeddingBuffer);

    return state;
  }

  /**
   * Update an existing working memory session with new state.
   * Merges partial updates into the existing data_json and re-embeds
   * the seed query for future similarity matching.
   */
  async updateWorkingSession(
    sessionId: string,
    updates: Partial<WorkingMemoryState>
  ): Promise<void> {
    const row = this.db.prepare(
      `SELECT data_json FROM working_memory WHERE id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`
    ).get(sessionId) as { data_json: string } | undefined;

    if (!row) throw new Error(`Working memory session ${sessionId} not found or expired`);

    const existing = JSON.parse(row.data_json) as WorkingMemoryState;
    const merged: WorkingMemoryState = {
      ...existing,
      ...updates,
      id: sessionId, // never overwrite ID
      updated_at: new Date().toISOString(),
    };

    const seedQuery = `${merged.goal}`.trim();
    const embedding = await this.embedder.embed(seedQuery);
    const embeddingBuffer = Buffer.from(embedding.buffer);

    this.db.prepare(`
      UPDATE working_memory
      SET data_json = ?, seed_query = ?, topic_embedding = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(merged), seedQuery, embeddingBuffer, sessionId);
  }

  /**
   * Get the current state of a working memory session.
   * Returns null if the session doesn't exist or has expired.
   */
  getWorkingSession(sessionId: string): WorkingMemoryState | null {
    const row = this.db.prepare(
      `SELECT data_json FROM working_memory WHERE id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`
    ).get(sessionId) as { data_json: string } | undefined;

    return row ? JSON.parse(row.data_json) as WorkingMemoryState : null;
  }

  /**
   * List all active (non-expired) working memory sessions.
   */
  listWorkingSessions(): WorkingMemoryState[] {
    const rows = this.db.prepare(`
      SELECT data_json FROM working_memory
      WHERE expires_at IS NULL OR expires_at > datetime('now')
      ORDER BY updated_at DESC
    `).all() as Array<{ data_json: string }>;

    return rows.map(r => JSON.parse(r.data_json) as WorkingMemoryState);
  }

  /**
   * Snapshot a working memory session to long-term episodic memory,
   * then mark it as expired. The session state is retained as an
   * 'experience' chunk so it persists in the knowledge base.
   *
   * Returns the RetainResult for the new experience chunk.
   */
  async snapshotWorkingSession(sessionId: string): Promise<RetainResult> {
    const row = this.db.prepare(
      `SELECT data_json, seed_query FROM working_memory WHERE id = ?`
    ).get(sessionId) as { data_json: string; seed_query: string | null } | undefined;

    if (!row) throw new Error(`Working memory session ${sessionId} not found`);

    const state = JSON.parse(row.data_json) as WorkingMemoryState;
    const summary = `Working session completed. Goal: ${state.goal}`;

    const result = await this.retain(summary, {
      memoryType: 'experience',
      source: `working_memory:${sessionId}`,
      sourceType: 'agent_generated',
      trustScore: 0.6,
      skipExtraction: false,
    });

    // Mark as expired
    this.db.prepare(
      `UPDATE working_memory SET expires_at = datetime('now') WHERE id = ?`
    ).run(sessionId);

    return result;
  }

  /**
   * Expire and snapshot all sessions that haven't been updated within
   * the given threshold. Call this from a background maintenance tick.
   *
   * Returns the number of sessions expired.
   */
  async expireStaleWorkingSessions(maxAgeHours: number = 48): Promise<number> {
    const stale = this.db.prepare(`
      SELECT id FROM working_memory
      WHERE updated_at < datetime('now', '-' || ? || ' hours')
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).all(String(maxAgeHours)) as Array<{ id: string }>;

    for (const { id } of stale) {
      try {
        await this.snapshotWorkingSession(id);
      } catch {
        // If snapshot fails (e.g. embedding error), still expire it
        this.db.prepare(
          `UPDATE working_memory SET expires_at = datetime('now') WHERE id = ?`
        ).run(id);
      }
    }

    return stale.length;
  }

  /**
   * Clear a specific working memory session without snapshotting.
   * Use when the session should be discarded rather than preserved.
   */
  clearWorkingSession(sessionId: string): boolean {
    const result = this.db.prepare(
      `UPDATE working_memory SET expires_at = datetime('now') WHERE id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`
    ).run(sessionId);
    return result.changes > 0;
  }

  /**
   * Enforce the maximum active session cap.
   * If there are more active sessions than maxActive, snapshot the oldest ones.
   * Internal — called by inferWorkingSession after creating a new session.
   */
  private async enforceSessionCap(maxActive: number): Promise<void> {
    const active = this.db.prepare(`
      SELECT id FROM working_memory
      WHERE expires_at IS NULL OR expires_at > datetime('now')
      ORDER BY updated_at ASC
    `).all() as Array<{ id: string }>;

    const excess = active.length - maxActive;
    if (excess <= 0) return;

    // Snapshot the oldest sessions that exceed the cap
    for (let i = 0; i < excess; i++) {
      try {
        await this.snapshotWorkingSession(active[i].id);
      } catch {
        this.db.prepare(
          `UPDATE working_memory SET expires_at = datetime('now') WHERE id = ?`
        ).run(active[i].id);
      }
    }
  }
```

**Also add this import** at the top of `engram.ts` (if `randomUUID` is not already imported — check existing imports from `retain.ts`):

```typescript
import { randomUUID } from 'crypto';
```

Note: `randomUUID` is already used in `retain.ts` but the `Engram` class in `engram.ts` doesn't currently import it directly. Check if it's needed.

---

## Phase 4 — MCP Tool (15 minutes)

**File:** `src/mcp-tools.ts`

Add to the `ENGRAM_TOOLS` array:

```typescript
  {
    name: 'engram_session' as const,
    description: 'Infer or resume a working memory session for the given message. Returns session state and related long-term context. Call once per incoming user message before the LLM call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'The incoming user message to match against active sessions',
        },
        maxActive: {
          type: 'number',
          description: 'Max active sessions to keep (default: 5)',
        },
        threshold: {
          type: 'number',
          description: 'Cosine similarity threshold for session matching (default: 0.72)',
        },
      },
      required: ['message'],
    },
  },
```

Add the handler case in `createEngramToolHandler()`:

```typescript
        case 'engram_session': {
          const msg = input.message as string;
          const opts = {
            maxActive: typeof input.maxActive === 'number' ? input.maxActive : undefined,
            threshold: typeof input.threshold === 'number' ? input.threshold : undefined,
          };
          const result = await engram.inferWorkingSession(msg, opts);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
```

Update the `EngramToolName` type — it auto-derives from the `ENGRAM_TOOLS` array, so no manual change needed if using `as const`.

---

## Phase 5 — Operative Adapter Integration (20 minutes)

**File:** `G:\Projects\SIT\operative\src\core\engram-adapter.ts`

Add to the `EngramLike` interface:

```typescript
  inferWorkingSession?(message: string, options?: Record<string, unknown>): Promise<any>;
  expireStaleWorkingSessions?(maxAgeHours?: number): Promise<number>;
```

Add a new exported function after `recallContext()`:

```typescript
// ─── 1b. Working Memory — Session Inference ────────────────────────────────

/**
 * Infer or resume a working memory session for the current input.
 * Returns session state and formatted related context, or undefined
 * if Engram is not configured or doesn't support working memory.
 */
export async function inferSession(
  userInput: string
): Promise<{ session: any; relatedContext: string; confidence: number } | undefined> {
  const engram = getEngram();
  if (!engram || !engram.inferWorkingSession) return undefined;

  try {
    return await engram.inferWorkingSession(userInput);
  } catch (err) {
    if (config.debug) console.debug('[ENGRAM] Session inference failed:', err);
    return undefined;
  }
}
```

Add to the `runExtraction()` function (or create a new tick function):

```typescript
/** Expire stale working memory sessions. Called by the scheduler tick engine. */
export async function expireWorkingSessions(): Promise<void> {
  const engram = getEngram();
  if (!engram || !engram.expireStaleWorkingSessions) return;

  try {
    const expired = await engram.expireStaleWorkingSessions(48);
    if (expired > 0 && config.debug) {
      console.debug(`[ENGRAM] Expired ${expired} stale working memory session(s)`);
    }
  } catch (err) {
    if (config.debug) console.debug('[ENGRAM] Session expiry failed:', err);
  }
}
```

**Note:** The Operative loop in `loop.ts` already calls `recallContext()` before Act and `retainTurn()` after Report. The `inferSession()` function can be called alongside or instead of `recallContext()` — this is a design decision for the agent author. For now, just export it. The Gage agent can choose to use it in its next iteration.

---

## Phase 6 — Tests (40 minutes)

**File:** Create `tests/working-memory.test.ts`

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { Engram } from '../src/engram.js';
import { MockEmbedder, tmpDbPath, cleanupDb } from './helpers.js';

describe('Working Memory', () => {
  let engram: Engram | undefined;
  let dbPath: string;

  afterEach(() => {
    try { engram?.close(); } catch { /* already closed */ }
    engram = undefined;
    cleanupDb(dbPath);
  });

  // ── Session Creation ───────────────────────────────────────────────────

  it('creates a new session from a message when no sessions exist', async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    const result = await engram.inferWorkingSession('check my email for updates');

    expect(result.session.id).toMatch(/^wm-/);
    expect(result.session.goal).toContain('check my email');
    expect(result.confidence).toBe(1.0);
    expect(result.diagnostics.reason).toBe('new');
  });

  // ── Session Resumption ────────────────────────────────────────────────

  it('resumes an existing session when topic matches', async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    const first = await engram.inferWorkingSession('check my email for updates');
    const second = await engram.inferWorkingSession('any new emails today');

    // MockEmbedder produces similar vectors for similar text
    // With 8-dim deterministic embeddings, "email" tokens overlap
    expect(second.diagnostics.reason).toBe('match');
    expect(second.session.id).toBe(first.session.id);
  });

  // ── Topic Isolation ────────────────────────────────────────────────────

  it('creates isolated sessions for different topics', async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    // Use very different text to ensure MockEmbedder produces distant vectors
    const email = await engram.inferWorkingSession('check my email for updates from the office');
    const garden = await engram.inferWorkingSession('ZZZZZ plant roses in the garden ZZZZZ');

    expect(email.session.id).not.toBe(garden.session.id);

    const sessions = engram.listWorkingSessions();
    expect(sessions.length).toBe(2);
  });

  // ── Session Update ─────────────────────────────────────────────────────

  it('updates session state with merged data', async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    const result = await engram.inferWorkingSession('plan the deployment');

    await engram.updateWorkingSession(result.session.id, {
      goal: 'plan the production deployment for Friday',
      status: 'in_progress',
    });

    const updated = engram.getWorkingSession(result.session.id);
    expect(updated).not.toBeNull();
    expect(updated!.goal).toBe('plan the production deployment for Friday');
    expect((updated as any).status).toBe('in_progress');
  });

  it('throws when updating a non-existent session', async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    await expect(
      engram.updateWorkingSession('wm-doesnotexist', { goal: 'test' })
    ).rejects.toThrow('not found');
  });

  // ── Session Retrieval ──────────────────────────────────────────────────

  it('getWorkingSession returns null for expired sessions', async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    const result = await engram.inferWorkingSession('temporary task');
    engram.clearWorkingSession(result.session.id);

    const retrieved = engram.getWorkingSession(result.session.id);
    expect(retrieved).toBeNull();
  });

  it('listWorkingSessions returns only active sessions', async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    await engram.inferWorkingSession('task one about alpha');
    const second = await engram.inferWorkingSession('ZZZZ completely different topic ZZZZ');
    engram.clearWorkingSession(second.session.id);

    const sessions = engram.listWorkingSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].goal).toContain('task one');
  });

  // ── Snapshot ───────────────────────────────────────────────────────────

  it('snapshotWorkingSession creates an experience chunk and expires the session', async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    const result = await engram.inferWorkingSession('design the API schema');
    const snapshot = await engram.snapshotWorkingSession(result.session.id);

    expect(snapshot.chunkId).toMatch(/^chk-/);

    // Session should now be expired
    const retrieved = engram.getWorkingSession(result.session.id);
    expect(retrieved).toBeNull();

    // The snapshot chunk should be findable via recall
    const recallResult = await engram.recall('API schema', { strategies: ['keyword'] });
    expect(recallResult.results.some(r => r.source?.includes('working_memory'))).toBe(true);
  });

  // ── Clear ──────────────────────────────────────────────────────────────

  it('clearWorkingSession expires without snapshotting', async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    const result = await engram.inferWorkingSession('throwaway task');
    const cleared = engram.clearWorkingSession(result.session.id);

    expect(cleared).toBe(true);
    expect(engram.getWorkingSession(result.session.id)).toBeNull();

    // No experience chunk should exist from this session
    const recallResult = await engram.recall('throwaway', { strategies: ['keyword'] });
    expect(recallResult.results.some(r => r.source?.includes('working_memory'))).toBe(false);
  });

  it('clearWorkingSession returns false for already-expired session', async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    const result = await engram.inferWorkingSession('temp');
    engram.clearWorkingSession(result.session.id);

    // Second clear should return false
    const secondClear = engram.clearWorkingSession(result.session.id);
    expect(secondClear).toBe(false);
  });

  // ── Session Cap ────────────────────────────────────────────────────────

  it('enforces maxActive by snapshotting oldest sessions', async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    // Create 3 sessions with very different text so MockEmbedder produces distinct vectors
    await engram.inferWorkingSession('AAAA first topic about alpha');
    await engram.inferWorkingSession('BBBB second topic about beta');
    await engram.inferWorkingSession('CCCC third topic about gamma');

    // Now create a 4th with maxActive: 3 — should snapshot the oldest
    await engram.inferWorkingSession('DDDD fourth topic about delta', { maxActive: 3 });

    const sessions = engram.listWorkingSessions();
    expect(sessions.length).toBeLessThanOrEqual(3);
  });

  // ── Related Context ────────────────────────────────────────────────────

  it('returns related long-term context alongside the session', async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    // Add some long-term knowledge first
    await engram.retain('Tom uses Terraform for all IaC deployments', {
      memoryType: 'world',
      trustScore: 0.9,
    });

    const result = await engram.inferWorkingSession('plan the Terraform deployment');

    expect(result.relatedContext).toBeTruthy();
    expect(typeof result.relatedContext).toBe('string');
    // The related context should contain the formatted recall output
    expect(result.relatedContext.length).toBeGreaterThan(0);
  });
});
```

---

## Phase 7 — Build & Verify (10 minutes)

```bash
npm run typecheck  # zero errors
npm run build      # clean compile, dist/ updated
npm test           # all existing 87 tests + new working-memory tests pass
```

---

## Rollback

The `working_memory` table is created with `IF NOT EXISTS` — it has zero impact on existing code paths. To remove:

```sql
DROP TABLE IF EXISTS working_memory;
```

No other tables, indexes, or code paths reference it outside the new methods.

---

## Files Changed Summary

| Action | File | What Changed |
|--------|------|-------------|
| MODIFY | `src/schema.sql` | Added `working_memory` table + index |
| CREATE | `src/working-memory-types.ts` | Type definitions for session state |
| MODIFY | `src/engram.ts` | Added 8 new methods on the Engram class + type re-exports |
| MODIFY | `src/mcp-tools.ts` | Added `engram_session` tool + handler case |
| CREATE | `tests/working-memory.test.ts` | 12 test cases covering full session lifecycle |

## Files NOT Changed

| File | Why |
|------|-----|
| `src/retain.ts` | Working memory uses `this.retain()` internally — no changes needed |
| `src/recall.ts` | Working memory uses `this.recall()` internally — no changes needed |
| `src/reflect.ts` | Reflection operates on chunks — session snapshots become chunks automatically |
| `src/local-embedder.ts` | Working memory uses the existing `EmbeddingProvider` interface |
| `tsconfig.json` | No changes needed |
| `vitest.config.ts` | No changes needed |
| All existing tests | Working memory is additive — zero behavioral change to existing features |

## Operative Integration Files (optional, separate commit)

| Action | File | What Changed |
|--------|------|-------------|
| MODIFY | `G:\Projects\SIT\operative\src\core\engram-adapter.ts` | Added `inferSession()` and `expireWorkingSessions()` |

---

## Integration Example — OpenClaw Agent

```typescript
// In your OpenClaw agent's message handler:
import { Engram, shouldRetain, formatForPrompt } from 'engram';

const memory = await Engram.open('./agent.engram', {
  ollamaUrl: 'http://starbase:40114',
});

async function handleMessage(userInput: string) {
  // 1. Infer working session (replaces manual context management)
  const { session, relatedContext, confidence } = 
    await memory.inferWorkingSession(userInput);

  // 2. Optional: ask for confirmation on low-confidence switches
  if (confidence < 0.65) {
    console.log(`Switching context? Current goal: ${session.goal}`);
  }

  // 3. Build prompt with session state + long-term context
  const systemPrompt = `
${basePrompt}

## Current Task
Goal: ${session.goal}

## Memory Context
${relatedContext}
  `.trim();

  // 4. Call LLM
  const response = await callLLM(userInput, systemPrompt);

  // 5. Update session state if the goal evolved
  await memory.updateWorkingSession(session.id, {
    goal: session.goal, // or update based on LLM output
    lastResponse: response.slice(0, 200),
  });

  // 6. Retain the turn in long-term memory
  if (shouldRetain(userInput).score >= 0.3) {
    await memory.retain(userInput, {
      memoryType: 'experience',
      source: `session:${session.id}`,
      sourceType: 'user_stated',
      trustScore: 0.85,
    });
  }

  return response;
}

// 7. Background maintenance
setInterval(() => memory.processExtractions(10), 5 * 60 * 1000);
setInterval(() => memory.expireStaleWorkingSessions(48), 60 * 60 * 1000);
setInterval(() => memory.reflect(), 6 * 60 * 60 * 1000);
```

## Integration Example — Telegram Bot

```typescript
bot.on('message', async (msg) => {
  const result = await memory.inferWorkingSession(msg.text);

  if (result.confidence < 0.65) {
    await bot.sendMessage(msg.chat.id,
      `Switching context? (current: ${result.session.goal})`
    );
  }

  // Proceed with result.session + result.relatedContext
});
```

---

## Next Steps (after this sprint)

1. Merge & ship — `git add -A && git commit -m "feat: working memory with auto-session switching"`
2. Update `engram.fyi` with "Multi-session auto-context" badge
3. Update `README.md` with working memory section and API docs
4. Sprint 2: memory scopes (project-level, agent-level, shared) building on session `scope` field
5. Sprint 3: session handoff between agents (via `task_id` matching across `.engram` files)
