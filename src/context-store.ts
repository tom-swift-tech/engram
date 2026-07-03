// =============================================================================
// context-store.ts — Task-scoped ephemeral context (ContextStore)
//
// A fifth, short-lived counterpart to the four durable memory types
// (world/experience/observation/opinion). Where retain()/recall() persist an
// agent's long-term knowledge, ContextStore lets one agent COMMIT a small
// structured DecisionArtifact and a subagent QUERY for only the relevant
// slice — cheap context handoff instead of re-reading full transcripts.
//
// Deliberately NOT named "working memory": that name is already taken by the
// working_memory table (session goal/progress state, matched by its own
// topic_embedding cosine search — see engram.ts's inferSession/*WorkingSession
// methods). ContextStore artifacts are immutable, multi-row-per-task, and
// ranked via the same RRF-fusion recall() pipeline everything else uses —
// a different shape entirely, so it gets a different name: task scope.
//
// Storage: task-scoped artifacts live in the SAME `chunks` table as durable
// memory (memory_type='experience'), tagged `scope='task'` plus expires_at/
// parent_ref/agent_id/artifact_json columns that durable rows never set.
// recall()'s RRF fusion, trust tiers, and ranking are untouched — scope is
// just one more WHERE-clause discriminant (see recall.ts's buildScopeFilter),
// and recall() defaults to scope=['durable'] so existing callers are unaffected.
//
// TTL is enforced lazily: expires_at is checked at query time (recall.ts's
// buildScopeFilter), not swept by a background reaper. expireContext() additionally
// hard-deactivates a specific artifact (is_active=0) ahead of its natural TTL.
// =============================================================================

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { computeTextHash, type EmbeddingProvider } from './retain.js';
import { recall } from './recall.js';

// =============================================================================
// Types
// =============================================================================

/**
 * A lightweight pointer to a committed artifact — safe to hand across an
 * agent/process boundary (small, serializable, no embedded payload).
 */
export interface ContextRef {
  id: string;
  scope: 'task';
}

/**
 * Character-count budget, not a real tokenizer count. Matches the existing
 * approximation already used by recall.ts's formatForPrompt(maxChars) —
 * avoids pulling in a BPE tokenizer dependency for an estimate that's "close
 * enough" to bound prompt injection size.
 */
export interface TokenBudget {
  maxChars: number;
}

/** Default committed-artifact lifetime: short, matching CLAUDE.md's TaskScope guidance. */
export const DEFAULT_TASK_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Default query()-time budget when a caller doesn't size one explicitly. */
export const DEFAULT_QUERY_BUDGET: TokenBudget = { maxChars: 4000 };

export interface TaskScope {
  /** Chains to the parent scope's ContextRef — a reference, never a copy of its content. */
  parent?: ContextRef;
  /** Milliseconds until this artifact expires. Default: DEFAULT_TASK_TTL_MS. */
  ttlMs?: number;
  /**
   * Informational ceiling for how much a query() against this scope should
   * pull back. NOT enforced by commit() (a commit is one whole artifact, not
   * a slice) and NOT auto-applied by query() (there's no persisted scope
   * registry to read it back from) — callers that mint a TaskScope and hand
   * it to collaborators should pass this same budget to their query() calls.
   */
  budget?: TokenBudget;
}

/**
 * Structured decision record — not a transcript. `agentId` is the
 * originating agent's Tier/callsign, carried for provenance/audit.
 */
export interface DecisionArtifact {
  decision: string;
  rationale?: string;
  scoredOptions?: Array<{ option: string; score: number }>;
  confidence?: number;
  refsToSource?: string[];
  /** Freeform tag, e.g. a task/domain label. Stored in chunks.context. */
  domain?: string;
  /** Originating agent Tier/callsign — provenance for later audit. */
  agentId?: string;
}

export interface CommittedArtifact {
  ref: ContextRef;
  artifact: DecisionArtifact;
  parentRef: ContextRef | null;
  createdAt: string;
  expiresAt: string;
}

export interface ContextSlice {
  artifacts: CommittedArtifact[];
  /** True when relevant results existed beyond what `budget` allowed through. */
  truncated: boolean;
  /** Total candidates recall() fused across strategies before the budget cut. */
  totalCandidates: number;
}

interface ArtifactRow {
  id: string;
  artifact_json: string;
  agent_id: string | null;
  parent_ref: string | null;
  created_at: string;
  expires_at: string | null;
}

// =============================================================================
// Helpers
// =============================================================================

/** Flatten a DecisionArtifact into natural-language text for FTS5/semantic/graph search. */
function composeSearchableText(artifact: DecisionArtifact): string {
  const parts = [artifact.decision];
  if (artifact.rationale) parts.push(artifact.rationale);
  if (artifact.scoredOptions?.length) {
    parts.push(artifact.scoredOptions.map((o) => o.option).join(', '));
  }
  return parts.join('\n').trim();
}

function toCommittedArtifact(row: ArtifactRow): CommittedArtifact {
  return {
    ref: { id: row.id, scope: 'task' },
    artifact: JSON.parse(row.artifact_json) as DecisionArtifact,
    parentRef: row.parent_ref ? { id: row.parent_ref, scope: 'task' } : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at as string,
  };
}

// =============================================================================
// ContextStore operations
// =============================================================================

/**
 * Commit a DecisionArtifact under the given TaskScope. Returns a ContextRef
 * cheap enough to pass to a subagent, who can query() beneath it.
 */
export async function commitContext(
  db: Database.Database,
  embedder: EmbeddingProvider,
  artifact: DecisionArtifact,
  scope: TaskScope = {},
): Promise<ContextRef> {
  const chunkId = `ctx-${randomUUID().substring(0, 12)}`;
  const ttlMs = scope.ttlMs ?? DEFAULT_TASK_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const parentRef = scope.parent?.id ?? null;
  const text = composeSearchableText(artifact);

  const embedding = await embedder.embed(text);
  const embeddingBuffer = Buffer.from(embedding.buffer);

  db.prepare(
    `
    INSERT INTO chunks (
      id, text, embedding, memory_type,
      context, source_type, trust_score,
      scope, expires_at, parent_ref, agent_id, artifact_json,
      text_hash
    ) VALUES (?, ?, ?, 'experience', ?, 'agent_generated', 0.6, 'task', ?, ?, ?, ?, ?)
  `,
  ).run(
    chunkId,
    text,
    embeddingBuffer,
    artifact.domain ?? null,
    expiresAt,
    parentRef,
    artifact.agentId ?? null,
    JSON.stringify(artifact),
    computeTextHash(text),
  );

  return { id: chunkId, scope: 'task' };
}

/**
 * Query for the task-scoped artifacts committed under `ref` (its direct
 * children — chunks whose parent_ref === ref.id), ranked via the same
 * RRF-fusion recall() pipeline used for durable memory, then truncated to
 * fit `budget`. Expired artifacts (past expires_at) are excluded regardless
 * of `is_active`, enforced lazily by recall()'s scope filter.
 */
export async function queryContext(
  db: Database.Database,
  embedder: EmbeddingProvider,
  ref: ContextRef,
  relevanceQuery: string,
  budget: TokenBudget = DEFAULT_QUERY_BUDGET,
): Promise<ContextSlice> {
  const response = await recall(db, relevanceQuery, embedder, {
    scope: ['task'],
    parentRef: ref.id,
    topK: 50,
    includeOpinions: false,
    includeObservations: false,
  });

  if (response.results.length === 0) {
    return { artifacts: [], truncated: false, totalCandidates: response.totalCandidates };
  }

  const ids = response.results.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, artifact_json, agent_id, parent_ref, created_at, expires_at
       FROM chunks WHERE id IN (${placeholders})`,
    )
    .all(...ids) as ArtifactRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const artifacts: CommittedArtifact[] = [];
  let truncated = false;
  let used = 0;

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue; // defensive — recall() and this read are not in one transaction
    const cost = row.artifact_json.length;
    if (used + cost > budget.maxChars) {
      truncated = true;
      continue; // keep scanning: a later, smaller artifact may still fit
    }
    used += cost;
    artifacts.push(toCommittedArtifact(row));
  }

  return { artifacts, truncated, totalCandidates: response.totalCandidates };
}

/**
 * Explicitly expire a committed artifact ahead of its natural TTL
 * (soft-delete via is_active=0, same convention as Engram.forget()).
 * Throws if the ref doesn't resolve to an active task-scoped chunk.
 */
export async function expireContext(
  db: Database.Database,
  ref: ContextRef,
): Promise<void> {
  const result = db
    .prepare(
      `UPDATE chunks SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND scope = 'task' AND is_active = TRUE`,
    )
    .run(ref.id);
  if (result.changes === 0) {
    throw new Error(`Context artifact ${ref.id} not found or already expired`);
  }
}

/**
 * Promotion seam: mechanically moves an artifact from task scope into
 * durable memory (scope='durable', TTL/parent chain cleared) so it survives
 * past its TTL and becomes eligible for reflect/consolidation. Deliberately
 * does NOT run reflect() or synthesize observations itself — wiring this
 * into the reflect pipeline is out of scope for this pass.
 */
export async function promoteToDurable(
  db: Database.Database,
  ref: ContextRef,
): Promise<void> {
  const result = db
    .prepare(
      `UPDATE chunks SET scope = 'durable', expires_at = NULL, parent_ref = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND scope = 'task' AND is_active = TRUE`,
    )
    .run(ref.id);
  if (result.changes === 0) {
    throw new Error(`Context artifact ${ref.id} not found or already expired`);
  }
}
