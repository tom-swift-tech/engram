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
import { formatForPrompt } from 'engram';

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
    // Disable the library's default 180-day recency decay. At that default a
    // multi-year-old memory's score is crushed to ~1% before trust/relevance
    // even apply (2^(-1205/180) ≈ 0.01 for a 2023 chunk) — wrong for a
    // personal assistant meant to have continuity across years, where
    // trust_score and semantic relevance should drive ranking, not recency.
    decayHalfLifeDays: 0,
  });
}

export interface StartupRecallInput {
  /** The user's first prompt in a fresh session — used as the recall query. */
  prompt: string;
  /** Max results considered before formatting/truncation; default 8 */
  topK?: number;
  /** Character budget for the formatted block; default 1200 (matches session-resume's relatedContext budget) */
  maxChars?: number;
}

const STARTUP_RECALL_HEADER = '## Relevant memory from prior work';

/**
 * Whether a session_start event represents a genuinely blank-slate session
 * eligible for one-shot startup recall.
 *
 * Pi's 'new' reason only fires for an explicit mid-process session switch
 * (e.g. an interactive "start a new session" action) — it is never the
 * reason on an initial process launch, interactive or `pi -p`. Every initial
 * launch reports 'startup' instead, regardless of whether it created a
 * genuinely fresh session or loaded prior history via
 * --continue/--resume/--session — so 'reason' alone can't tell those apart.
 *
 * `priorMessageCount` disambiguates: it must be the count of session entries
 * with `type === 'message'` specifically — Pi appends bookkeeping entries
 * (model_change, thinking_level_change, ...) before session_start fires on
 * *every* launch, so a raw entry count is never zero even for a truly fresh
 * session. Zero real messages means nothing was loaded, so 'startup' is
 * genuinely fresh too; a non-zero count means this is a continuation that
 * already has its own context (covered by the working-memory session
 * bridge, not startup recall).
 */
export function isFreshSessionStart(
  reason: string,
  priorMessageCount: number,
): boolean {
  if (reason === 'new') return true;
  if (reason === 'startup') return priorMessageCount === 0;
  return false;
}

/**
 * One-shot "starting context" for a fresh session: recall against the user's
 * first message and format the result for system-prompt injection. Returns
 * null when there's nothing relevant (or nothing to say) — the caller should
 * then fall back to appending no extra context rather than an empty header.
 *
 * Deliberately NOT called on every turn — see index.ts's `sessionIsFresh`
 * gating. Repeating this per-turn would add recall latency to every message
 * and risks injecting stale/irrelevant matches into unrelated follow-ups.
 */
export async function startupRecall(
  engram: Engram,
  input: StartupRecallInput,
): Promise<string | null> {
  const prompt = input.prompt.trim();
  if (!prompt) return null;

  const response = await engram.recall(prompt, { topK: input.topK ?? 8 });
  if (
    response.results.length === 0 &&
    response.opinions.length === 0 &&
    response.observations.length === 0
  ) {
    return null;
  }

  const formatted = formatForPrompt(response, {
    maxChars: input.maxChars ?? 1200,
    header: STARTUP_RECALL_HEADER,
  });
  return formatted.trim() ? formatted : null;
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

// =============================================================================
// Background consolidation scheduling — Phase 2
//
// Engram's founding constraint is "never block a write/turn on an LLM call".
// processExtractions() and reflect() both hit Ollama, so the binding runs them
// fire-and-forget off Pi's turn_end / session_shutdown hooks. This module owns
// the *pure* parts: deciding when a cycle is due (planConsolidation) and
// running it while classifying Ollama-reachability (runConsolidation). The
// counter, in-flight guard, and once-per-session warning live in index.ts.
// =============================================================================

export interface SchedulingConfig {
  /** Run processExtractions() every N turns (when the queue has pending items). */
  extractEveryTurns: number;
  /** Run reflect() every N turns. */
  reflectEveryTurns: number;
  /** Batch size passed to processExtractions(). */
  extractBatchSize: number;
}

export const DEFAULT_SCHEDULING_CONFIG: SchedulingConfig = {
  extractEveryTurns: 3,
  reflectEveryTurns: 12,
  extractBatchSize: 10,
};

export interface ConsolidationPlan {
  extract: boolean;
  reflect: boolean;
}

function onInterval(turn: number, every: number): boolean {
  return every > 0 && turn > 0 && turn % every === 0;
}

/**
 * Cheap pre-check: is *any* cadence interval hit this turn? Used by the binding
 * to decide whether it's even worth opening Engram — an idle session that never
 * touched memory should pay neither the lazy-open (embedder load) nor a no-op
 * queue check.
 */
export function consolidationDue(
  turn: number,
  config: SchedulingConfig = DEFAULT_SCHEDULING_CONFIG,
): boolean {
  return (
    onInterval(turn, config.extractEveryTurns) ||
    onInterval(turn, config.reflectEveryTurns)
  );
}

/**
 * Pure cadence decision. `turn` is 1-based (the count *after* this turn ends).
 * Extraction is gated on both the turn interval and a non-empty queue so we
 * never spin up Ollama just to drain zero items; reflection is purely
 * interval-driven (it has its own min-facts threshold inside Engram).
 */
export function planConsolidation(
  turn: number,
  queuePending: number,
  config: SchedulingConfig = DEFAULT_SCHEDULING_CONFIG,
): ConsolidationPlan {
  return {
    extract: onInterval(turn, config.extractEveryTurns) && queuePending > 0,
    reflect: onInterval(turn, config.reflectEveryTurns),
  };
}

export interface ConsolidationResult {
  extracted: { processed: number; failed: number } | null;
  reflected: Awaited<ReturnType<Engram['reflect']>> | null;
  /** False if a connection-class error was seen (Ollama down/unconfigured). */
  ollamaReachable: boolean;
}

/**
 * True for errors that mean "the Ollama endpoint isn't answering" — connection
 * refused, DNS miss, reset, or undici's wrapped `fetch failed`. Anything else
 * (a genuine bug, a parse error) is re-thrown so it isn't silently swallowed
 * under the "Ollama is down" banner.
 */
export function isConnectionError(err: unknown): boolean {
  const codes = ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'];
  const haystacks: string[] = [];
  if (err instanceof Error) {
    haystacks.push(err.message);
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) haystacks.push(cause.message);
    const code = (cause as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string') haystacks.push(code);
  } else if (typeof err === 'string') {
    haystacks.push(err);
  }
  const joined = haystacks.join(' ');
  return (
    /fetch failed/i.test(joined) || codes.some((c) => joined.includes(c))
  );
}

/**
 * Most recent error recorded on the extraction queue, or null. Engram's
 * extraction/reflection paths swallow generator failures (recording them rather
 * than throwing — they must never crash a background drain), so reachability is
 * read back from these structured signals, not from a thrown exception.
 * Reaches the DB through the same narrow cast memoryStats() uses.
 */
function latestQueueError(engram: Engram): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (engram as any).db as {
    prepare: (sql: string) => {
      get: () => { error: string | null } | undefined;
    };
  };
  const row = db
    .prepare(
      `SELECT error FROM extraction_queue
       WHERE error IS NOT NULL
       ORDER BY last_attempt DESC LIMIT 1`,
    )
    .get();
  return row?.error ?? null;
}

/**
 * Run the requested consolidation steps and infer Ollama reachability from
 * their results. Extraction runs before reflection; if extraction shows a
 * connection-class failure we skip reflection (same endpoint, no point
 * retrying this cycle). Neither call throws on an Ollama outage — extraction
 * records the error on the queue row, reflect returns `status: 'failed'` — so
 * we inspect those rather than catch.
 */
export async function runConsolidation(
  engram: Engram,
  plan: ConsolidationPlan,
  config: SchedulingConfig = DEFAULT_SCHEDULING_CONFIG,
): Promise<ConsolidationResult> {
  let ollamaReachable = true;
  let extracted: ConsolidationResult['extracted'] = null;
  let reflected: ConsolidationResult['reflected'] = null;

  if (plan.extract) {
    extracted = await engram.processExtractions(config.extractBatchSize);
    if (extracted.failed > 0 && isConnectionError(latestQueueError(engram))) {
      ollamaReachable = false;
    }
  }

  if (plan.reflect && ollamaReachable) {
    reflected = await engram.reflect();
    if (reflected.status === 'failed' && isConnectionError(reflected.error)) {
      ollamaReachable = false;
    }
  }

  return { extracted, reflected, ollamaReachable };
}

// =============================================================================
// Auto-retain — Phase 2
//
// Auto-stash conversation messages as experience-type memories. The pure half
// (planAutoRetain) decides what, if anything, to store from a single message
// and with what provenance; the effectful half (autoRetain) performs the
// retain. Kept Pi-agnostic via the minimal RetainableMessage shape — the
// binding maps Pi's MessageEndEvent.message onto it.
//
// Provenance by role matters for the trust layer: tool/bash output is stored
// as `tool_result`, the lowest recall tier, so a flood of captured output can
// never outrank a user-stated directive at retrieval time.
// =============================================================================

/** Minimal message shape the binding maps Pi's AgentMessage onto. */
export interface RetainableMessage {
  role: string;
  /** string, or an array of content parts (text parts carry a string `text`). */
  content: unknown;
}

export interface AutoRetainConfig {
  /** Skip messages whose extracted text is shorter than this (default 8). */
  minChars: number;
  /** Truncate extracted text to this length so huge tool output can't bloat the DB (default 4000). */
  maxChars: number;
}

export const DEFAULT_AUTO_RETAIN_CONFIG: AutoRetainConfig = {
  minChars: 8,
  maxChars: 4000,
};

type SourceType = 'user_stated' | 'agent_generated' | 'tool_result';

interface RoleMapping {
  sourceType: SourceType;
  trustScore: number;
}

// Conversational roles we capture, with provenance. Roles absent here
// (branchSummary, compactionSummary, custom, …) are internal artifacts — skipped.
const ROLE_MAP: Record<string, RoleMapping> = {
  user: { sourceType: 'user_stated', trustScore: 0.7 },
  assistant: { sourceType: 'agent_generated', trustScore: 0.5 },
  toolResult: { sourceType: 'tool_result', trustScore: 0.4 },
  bashExecution: { sourceType: 'tool_result', trustScore: 0.4 },
};

const TRUNCATION_MARKER = '… [truncated]';

/**
 * Pull plain text out of a message's `content`, which is either a string or an
 * array of parts where text parts carry a string `text` field (image parts are
 * ignored). Returns '' when there's no extractable text.
 */
export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export interface AutoRetainPlan {
  text: string;
  memoryType: 'experience';
  sourceType: SourceType;
  trustScore: number;
  source: string;
  context: string;
}

/**
 * Pure decision: given a message, return what to retain (or null to skip).
 * Skips non-conversational roles, empty/whitespace text, user `/command`
 * invocations, and text below `minChars`; truncates to `maxChars`.
 */
export function planAutoRetain(
  message: RetainableMessage,
  config: AutoRetainConfig = DEFAULT_AUTO_RETAIN_CONFIG,
): AutoRetainPlan | null {
  const mapping = ROLE_MAP[message.role];
  if (!mapping) return null;

  const raw = extractMessageText(message.content).trim();
  if (!raw) return null;
  // Slash-command invocations are control input, not memories.
  if (message.role === 'user' && raw.startsWith('/')) return null;
  if (raw.length < config.minChars) return null;

  const text =
    raw.length > config.maxChars
      ? raw.slice(0, config.maxChars - TRUNCATION_MARKER.length) +
        TRUNCATION_MARKER
      : raw;

  return {
    text,
    memoryType: 'experience',
    sourceType: mapping.sourceType,
    trustScore: mapping.trustScore,
    source: 'pi:conversation',
    context: `role:${message.role}`,
  };
}

/**
 * Effectful: plan, then retain. Returns the RetainResult, or null if the
 * message was skipped by planAutoRetain. retain() embeds in-process (~ms, no
 * LLM) and dedups via normalized text_hash, so re-stored duplicates collapse.
 */
export async function autoRetain(
  engram: Engram,
  message: RetainableMessage,
  config: AutoRetainConfig = DEFAULT_AUTO_RETAIN_CONFIG,
): Promise<RetainResult | null> {
  const plan = planAutoRetain(message, config);
  if (!plan) return null;
  return engram.retain(plan.text, {
    memoryType: plan.memoryType,
    source: plan.source,
    sourceType: plan.sourceType,
    trustScore: plan.trustScore,
    context: plan.context,
  });
}
