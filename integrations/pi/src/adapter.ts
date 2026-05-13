// =============================================================================
// adapter.ts — Pure adapter layer between Pi extension and Engram.
//
// Takes an Engram instance and exposes the four operations Pi needs:
// remember, recall, memoryStats, forget. Knows nothing about Pi types — that
// way it can be unit-tested against a real in-memory Engram without mocking
// any Pi machinery.
//
// Binding layer (index.ts) is responsible for parsing slash command args,
// formatting output for ctx.ui, and asking for confirmation before destructive
// actions.
// =============================================================================

import type { Engram } from 'engram';
import type { RetainResult, RecallResponse } from 'engram';

export interface RememberInput {
  text: string;
  /** Optional source identifier (defaults to 'pi:slash-command' or 'pi:tool') */
  source?: string;
  /** Optional context tag (e.g. 'project:foo', 'topic:auth') */
  context?: string;
  /** Trust score 0–1; default 0.85 for user-stated, 0.6 for agent-generated */
  trustScore?: number;
  /** When the LLM is calling this on its own behalf, mark as agent_generated */
  fromLLM?: boolean;
}

export interface RecallInput {
  query: string;
  /** Max results to return; default 5 */
  topK?: number;
  /** Min trust score filter */
  minTrust?: number;
}

export interface MemoryStats {
  chunks: number;
  entities: number;
  opinions: number;
  observations: number;
  extractionQueue: {
    pending: number;
    processing: number;
    failed: number;
  };
}

export interface ForgetCandidate {
  chunkId: string;
  text: string;
  score: number;
  source: string | null;
}

const ID_PREFIX = /^chk-/;

export async function remember(
  engram: Engram,
  input: RememberInput,
): Promise<RetainResult> {
  const sourceType = input.fromLLM ? 'agent_generated' : 'user_stated';
  const trustScore = input.trustScore ?? (input.fromLLM ? 0.6 : 0.85);
  return engram.retain(input.text, {
    memoryType: 'world',
    source: input.source ?? (input.fromLLM ? 'pi:tool' : 'pi:slash-command'),
    sourceType,
    trustScore,
    context: input.context,
  });
}

export async function recall(
  engram: Engram,
  input: RecallInput,
): Promise<RecallResponse> {
  return engram.recall(input.query, {
    topK: input.topK ?? 5,
    minTrust: input.minTrust,
  });
}

export function memoryStats(engram: Engram): MemoryStats {
  // Engram doesn't expose a stats API; we query the DB directly via the
  // queue-stats helper plus a few count statements. Reaching into the DB
  // would require an exported handle, so instead we leverage the public
  // surface: getQueueStats() for the queue, recall for everything else
  // would be wrong (it's filtered). Use a dedicated SQL query path.
  //
  // We deliberately accept the indirection: MemoryStats is a Pi-side
  // concept, not an Engram-core concept. If this list grows, push a real
  // stats() method down into Engram.
  const queue = engram.getQueueStats();

  // The Engram class doesn't currently expose its DB handle. We access it
  // through a private cast — narrow and isolated to this function. If a
  // public stats() lands in core, swap this for a direct call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (engram as any).db as {
    prepare: (sql: string) => { get: () => { c: number } | undefined };
  };

  const count = (sql: string): number =>
    Number(db.prepare(sql).get()?.c ?? 0);

  return {
    chunks: count(
      `SELECT COUNT(*) AS c FROM chunks WHERE is_active = TRUE AND superseded_by IS NULL`,
    ),
    entities: count(
      `SELECT COUNT(*) AS c FROM entities WHERE is_active = TRUE`,
    ),
    opinions: count(
      `SELECT COUNT(*) AS c FROM opinions WHERE is_active = TRUE`,
    ),
    observations: count(
      `SELECT COUNT(*) AS c FROM observations WHERE is_active = TRUE`,
    ),
    extractionQueue: {
      pending: queue.pending,
      processing: queue.processing,
      failed: queue.failed,
    },
  };
}

/**
 * Looks like a chunk ID? (chk-xxx format). Used by binding layer to decide
 * whether `/forget <arg>` should delete directly or first ask for confirmation
 * after a recall.
 */
export function looksLikeChunkId(arg: string): boolean {
  return ID_PREFIX.test(arg.trim());
}

/**
 * Find the single best candidate for a query-based forget. Returns null when
 * nothing matches. Caller is expected to display the candidate, confirm with
 * the user, then call forgetById.
 */
export async function findToForget(
  engram: Engram,
  query: string,
): Promise<ForgetCandidate | null> {
  // recall returns tier-major order (source tier before relevance), which
  // protects user directives in prompt contexts — but a forget lookup wants
  // the single most RELEVANT match regardless of provenance. With topK: 1
  // the tier-major cut would preferentially nominate user-stated directives
  // for deletion. Over-fetch and re-sort by score locally instead.
  const response = await engram.recall(query, { topK: 5 });
  const top = [...response.results].sort((a, b) => b.score - a.score)[0];
  if (!top) return null;
  return {
    chunkId: top.id,
    text: top.text,
    score: top.score,
    source: top.source ?? null,
  };
}

export async function forgetById(
  engram: Engram,
  chunkId: string,
): Promise<boolean> {
  return engram.forget(chunkId);
}

// =============================================================================
// Working memory session bridge — Phase 2
//
// Wraps Engram's inferWorkingSession / updateWorkingSession /
// snapshotWorkingSession operations as pure functions over plain types.
// The binding layer (index.ts) carries the LLM-tool surface and one
// transient module-level currentSessionId pointer for the /session command.
// =============================================================================

export interface ResumeSessionInput {
  message: string;
  /** Cosine similarity threshold; defaults to Engram's default (0.55) */
  threshold?: number;
  /** Max active sessions before oldest is snapshotted; defaults to Engram's default (5) */
  maxActive?: number;
}

export interface ResumeSessionOutput {
  sessionId: string;
  goal: string;
  progress?: string;
  relatedContext: string;
  confidence: number;
  reason: 'match' | 'new' | 'forced';
}

export async function resumeSession(
  engram: Engram,
  input: ResumeSessionInput,
): Promise<ResumeSessionOutput> {
  const result = await engram.inferWorkingSession(input.message, {
    threshold: input.threshold,
    maxActive: input.maxActive,
  });
  return {
    sessionId: result.session.id,
    goal: result.session.goal,
    progress:
      typeof result.session.progress === 'string'
        ? result.session.progress
        : undefined,
    relatedContext: result.relatedContext,
    confidence: result.confidence,
    reason: result.diagnostics.reason,
  };
}

export interface UpdateSessionInput {
  sessionId: string;
  /** Free-form progress note merged into session state */
  progress?: string;
  /** Agent-defined extension keys merged into session state */
  extensions?: Record<string, unknown>;
}

export interface UpdateSessionOutput {
  sessionId: string;
  updated_at: string;
}

export async function updateSession(
  engram: Engram,
  input: UpdateSessionInput,
): Promise<UpdateSessionOutput> {
  const updates: Record<string, unknown> = { ...(input.extensions ?? {}) };
  if (input.progress !== undefined) {
    updates.progress = input.progress;
  }
  await engram.updateWorkingSession(input.sessionId, updates);
  const reloaded = engram.getWorkingSession(input.sessionId);
  if (!reloaded) {
    throw new Error(
      `Working memory session ${input.sessionId} not found after update`,
    );
  }
  return {
    sessionId: reloaded.id,
    updated_at: reloaded.updated_at,
  };
}

export interface SnapshotSessionInput {
  sessionId: string;
}

export interface SnapshotSessionOutput {
  sessionId: string;
  chunkId: string;
}

export async function snapshotSession(
  engram: Engram,
  input: SnapshotSessionInput,
): Promise<SnapshotSessionOutput> {
  const result = await engram.snapshotWorkingSession(input.sessionId);
  return {
    sessionId: input.sessionId,
    chunkId: result.chunkId,
  };
}
