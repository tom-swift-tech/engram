// =============================================================================
// index.ts — Pi extension entry point. Default-exports the factory Pi calls
// when loading the extension.
//
// Lifecycle:
//   - On factory invocation: register slash commands and LLM tools (synchronous
//     so /reload works predictably and registration is visible immediately).
//   - On 'session_start': lazily open Engram (project-local .engram/pi.db) so
//     the embedding model only loads when actually used.
//   - On 'turn_end': drive the background-consolidation cadence — every few
//     turns drain the extraction queue / run reflection, fire-and-forget so the
//     turn never blocks on Ollama. Skipped entirely if memory was never opened.
//   - On 'message_end': auto-retain the completed message as an experience
//     memory (on by default; ENGRAM_PI_AUTO_RETAIN=0 disables). Fire-and-forget;
//     a message that fails gating never opens the DB. A 'user'-role message is
//     stored as user_stated only when ctx.mode === 'tui' (a live interactive
//     session); non-interactive invocations (pi -p, RPC, JSON) default to
//     ENGRAM_PI_AUTO_RETAIN_NONINTERACTIVE_SOURCE_TYPE (default 'inferred') so
//     scheduled/automated volume can't crowd out real user_stated content.
//   - On 'session_shutdown': flush a final extract+reflect (time-bounded), then
//     close Engram. Pi may not always fire this (e.g. crash); SQLite WAL is
//     durable across abrupt exits.
//   - On 'before_agent_start', ONLY for the first turn of a genuinely fresh
//     session (session_start reason 'new', or 'startup' with zero prior
//     session entries — see isFreshSessionStart in adapter.ts for why reason
//     alone isn't enough): recall against the user's prompt and prepend the
//     formatted result to the system prompt as starting context. One-shot —
//     not repeated on later turns in the same session.
//     ENGRAM_PI_STARTUP_RECALL=0 disables it.
//
// Slash commands:
//   /remember <text>       store a fact
//   /recall   <query>      retrieve relevant memories
//   /memory                show memory stats
//   /forget   <id|query>   soft-delete a chunk (confirms before query-based deletes)
//   /session               show current working session + list active sessions
//
// LLM tools (JSON Schema):
//   engram_remember
//   engram_recall
//   engram_memory_stats
//   engram_forget          (requires explicit chunkId — no agent-driven query deletes)
//   engram_session_resume
//   engram_session_update
//   engram_session_snapshot
// =============================================================================

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Engram, resolveModelSpecOrNull } from 'engram';

import {
  remember,
  recall,
  memoryStats,
  findToForget,
  forgetById,
  looksLikeChunkId,
  resumeSession,
  updateSession,
  snapshotSession,
  consolidationDue,
  planConsolidation,
  runConsolidation,
  DEFAULT_SCHEDULING_CONFIG,
  type SchedulingConfig,
  autoRetain,
  planAutoRetain,
  DEFAULT_AUTO_RETAIN_CONFIG,
  type AutoRetainConfig,
  type RetainableMessage,
  type RunMode,
  startupRecall,
  isFreshSessionStart,
} from './adapter.js';
import {
  RememberParams,
  RecallParams,
  MemoryStatsParams,
  ForgetParams,
  SessionResumeParams,
  SessionUpdateParams,
  SessionSnapshotParams,
  type RememberToolParams,
  type RecallToolParams,
  type ForgetToolParams,
  type SessionResumeToolParams,
  type SessionUpdateToolParams,
  type SessionSnapshotToolParams,
} from './types.js';

const DEFAULT_DB_RELATIVE = '.engram/pi.db';

const SESSION_ADDENDUM = [
  '',
  'You have access to persistent working memory across sessions via Engram:',
  '- engram_session_resume — call early when starting substantive work; returns prior context if this topic has been worked on before',
  '- engram_session_update — call before turn boundaries to record progress notes',
  '- engram_session_snapshot — call when a piece of work is complete; collapses the session to long-term memory',
  'Use these for multi-turn tasks; prefer engram_recall for one-off lookups.',
].join('\n');

let enginePromise: Promise<Engram> | null = null;
let cachedDbPath: string | null = null;

// Module-level transient pointer set by engram_session_* tools so the
// /session slash command can answer "what are you currently working on?"
// Never persisted; lost on reload. Engram remains the only stateful party.
let currentSessionId: string | null = null;

// Set by session_start via isFreshSessionStart(); consumed (and cleared) by
// the very next before_agent_start. Fresh per Pi session, never persisted —
// exactly the one-shot "is this the first turn of a new session" signal
// startup recall needs, since before_agent_start otherwise fires every turn.
let sessionIsFresh = false;

// ---------------------------------------------------------------------------
// Background consolidation scheduling (Phase 2)
//
// turn_end drives a turn counter; extraction/reflection fire fire-and-forget
// off it so Ollama latency never blocks a turn. session_shutdown flushes once.
// All state here is transient per run; Engram is the only durable party.
// ---------------------------------------------------------------------------

const SHUTDOWN_FLUSH_TIMEOUT_MS = 30_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

let schedulingConfig: SchedulingConfig = {
  extractEveryTurns: envInt(
    'ENGRAM_PI_EXTRACT_EVERY_TURNS',
    DEFAULT_SCHEDULING_CONFIG.extractEveryTurns,
  ),
  reflectEveryTurns: envInt(
    'ENGRAM_PI_REFLECT_EVERY_TURNS',
    DEFAULT_SCHEDULING_CONFIG.reflectEveryTurns,
  ),
  extractBatchSize: envInt(
    'ENGRAM_PI_EXTRACT_BATCH',
    DEFAULT_SCHEDULING_CONFIG.extractBatchSize,
  ),
};

let turnCounter = 0;
let consolidationInFlight = false;
let ollamaWarned = false;
let generationErrorWarned = false;
// Holds the most recent detached consolidation promise purely so tests can
// await it deterministically (production never reads this).
let pendingConsolidation: Promise<void> | null = null;

function resetSchedulingState(): void {
  turnCounter = 0;
  consolidationInFlight = false;
  ollamaWarned = false;
  generationErrorWarned = false;
  pendingConsolidation = null;
}

// ---------------------------------------------------------------------------
// Auto-retain (Phase 2)
//
// Capture conversation messages as experience memories off message_end.
// On by default; ENGRAM_PI_AUTO_RETAIN=0 (or false/no/off) disables it.
// ---------------------------------------------------------------------------

function envBoolDefaultTrue(name: string): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

// Valid overrides for a non-interactive 'user'-role message's sourceType
// (see AutoRetainConfig.nonInteractiveSourceType). Anything else in the env
// var falls back to the default rather than failing startup.
const NON_INTERACTIVE_SOURCE_TYPES = [
  'inferred',
  'user_stated',
  'agent_generated',
  'tool_result',
] as const;

function envNonInteractiveSourceType(
  name: string,
  fallback: AutoRetainConfig['nonInteractiveSourceType'],
): AutoRetainConfig['nonInteractiveSourceType'] {
  const raw = process.env[name];
  return (NON_INTERACTIVE_SOURCE_TYPES as readonly string[]).includes(
    raw ?? '',
  )
    ? (raw as AutoRetainConfig['nonInteractiveSourceType'])
    : fallback;
}

let autoRetainEnabled = envBoolDefaultTrue('ENGRAM_PI_AUTO_RETAIN');
let autoRetainConfig: AutoRetainConfig = {
  minChars: envInt(
    'ENGRAM_PI_AUTO_RETAIN_MIN_CHARS',
    DEFAULT_AUTO_RETAIN_CONFIG.minChars,
  ),
  maxChars: envInt(
    'ENGRAM_PI_AUTO_RETAIN_MAX_CHARS',
    DEFAULT_AUTO_RETAIN_CONFIG.maxChars,
  ),
  nonInteractiveSourceType: envNonInteractiveSourceType(
    'ENGRAM_PI_AUTO_RETAIN_NONINTERACTIVE_SOURCE_TYPE',
    DEFAULT_AUTO_RETAIN_CONFIG.nonInteractiveSourceType,
  ),
};
// Most recent detached auto-retain promise, for deterministic test awaits.
let pendingAutoRetain: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Startup recall (fresh-session starting context)
//
// One-shot recall against the first prompt of a genuinely new session
// ('session_start' fired with reason: 'new'), injected into that turn's
// system prompt. On by default; ENGRAM_PI_STARTUP_RECALL=0 disables it.
// ---------------------------------------------------------------------------

interface StartupRecallConfig {
  maxChars: number;
  topK: number;
}

const DEFAULT_STARTUP_RECALL_CONFIG: StartupRecallConfig = {
  maxChars: 1200,
  topK: 8,
};

let startupRecallEnabled = envBoolDefaultTrue('ENGRAM_PI_STARTUP_RECALL');
let startupRecallConfig: StartupRecallConfig = {
  maxChars: envInt(
    'ENGRAM_PI_STARTUP_RECALL_MAX_CHARS',
    DEFAULT_STARTUP_RECALL_CONFIG.maxChars,
  ),
  topK: envInt('ENGRAM_PI_STARTUP_RECALL_TOPK', DEFAULT_STARTUP_RECALL_CONFIG.topK),
};

// Engine factory — overridable from tests to swap in a deterministic embedder
// without paying the LocalEmbedder model download. Production never touches
// this; the only setter is the test-only export below, prefixed `_`.
type EngineFactory = (path: string) => Promise<Engram>;

/**
 * Default (production) engine factory. Resolves the background-consolidation
 * model through the single resolver (role: integration) from env — no silent
 * default. When no model is configured, `reflectModel` is left unset and the
 * engram opens with a fail-loud UnconfiguredGeneration: retain/recall and
 * startup-recall still work, but background extract/reflect surfaces a loud
 * once-per-session warning (see scheduleConsolidation) instead of 404ing on a
 * default model the host may not serve.
 */
function openWithResolvedModel(path: string): Promise<Engram> {
  const spec = resolveModelSpecOrNull({ role: 'integration', env: process.env });
  return Engram.open(path, spec ? { reflectModel: spec.model } : {});
}

let engineFactory: EngineFactory = openWithResolvedModel;

/**
 * Lazy Engram opener. Called on first command/tool invocation. Reuses the
 * same instance across the session — Engram holds a single SQLite connection
 * with WAL mode, safe for many readers.
 */
async function getEngram(): Promise<Engram> {
  if (enginePromise) return enginePromise;

  // ENGRAM_PI_DB_PATH overrides the default project-local <cwd>/.engram/pi.db
  // resolution. Needed for a persistent-identity agent that gets launched
  // from several different working directories (interactive TUI, scheduled
  // jobs, chat bridges) but should always open the same one database rather
  // than silently starting a fresh, empty one per cwd.
  const override = process.env.ENGRAM_PI_DB_PATH;
  const dbPath = override ? resolve(override) : resolve(process.cwd(), DEFAULT_DB_RELATIVE);
  cachedDbPath = dbPath;
  await mkdir(dirname(dbPath), { recursive: true });

  enginePromise = engineFactory(dbPath);
  return enginePromise;
}

/**
 * Test-only escape hatch. Replaces the engine factory and resets any
 * cached promise so the next getEngram() call uses the new factory.
 * The leading underscore + name make it obvious this is not a public API.
 */
export function _setEngineFactoryForTesting(factory: EngineFactory): void {
  enginePromise = null;
  cachedDbPath = null;
  currentSessionId = null;
  sessionIsFresh = false;
  resetSchedulingState();
  pendingAutoRetain = null;
  engineFactory = factory;
}

/** Test-only: reset to default factory and drop any cached engine. */
export function _resetEngineFactoryForTesting(): void {
  enginePromise = null;
  cachedDbPath = null;
  currentSessionId = null;
  sessionIsFresh = false;
  resetSchedulingState();
  schedulingConfig = {
    extractEveryTurns: DEFAULT_SCHEDULING_CONFIG.extractEveryTurns,
    reflectEveryTurns: DEFAULT_SCHEDULING_CONFIG.reflectEveryTurns,
    extractBatchSize: DEFAULT_SCHEDULING_CONFIG.extractBatchSize,
  };
  autoRetainEnabled = true;
  autoRetainConfig = {
    minChars: DEFAULT_AUTO_RETAIN_CONFIG.minChars,
    maxChars: DEFAULT_AUTO_RETAIN_CONFIG.maxChars,
    nonInteractiveSourceType: DEFAULT_AUTO_RETAIN_CONFIG.nonInteractiveSourceType,
  };
  pendingAutoRetain = null;
  startupRecallEnabled = true;
  startupRecallConfig = {
    maxChars: DEFAULT_STARTUP_RECALL_CONFIG.maxChars,
    topK: DEFAULT_STARTUP_RECALL_CONFIG.topK,
  };
  engineFactory = openWithResolvedModel;
}

/** Test-only: shrink the cadence so a test can trigger cycles in a few turns. */
export function _setSchedulingConfigForTesting(
  partial: Partial<SchedulingConfig>,
): void {
  schedulingConfig = { ...schedulingConfig, ...partial };
}

/**
 * Test-only: the most recent detached consolidation promise (or null). Lets
 * tests await fire-and-forget work instead of racing it.
 */
export function _getPendingConsolidationForTesting(): Promise<void> | null {
  return pendingConsolidation;
}

/** Test-only: toggle auto-retain and/or override its gating thresholds. */
export function _setAutoRetainConfigForTesting(opts: {
  enabled?: boolean;
  minChars?: number;
  maxChars?: number;
  nonInteractiveSourceType?: AutoRetainConfig['nonInteractiveSourceType'];
}): void {
  if (opts.enabled !== undefined) autoRetainEnabled = opts.enabled;
  if (opts.minChars !== undefined) autoRetainConfig.minChars = opts.minChars;
  if (opts.maxChars !== undefined) autoRetainConfig.maxChars = opts.maxChars;
  if (opts.nonInteractiveSourceType !== undefined) {
    autoRetainConfig.nonInteractiveSourceType = opts.nonInteractiveSourceType;
  }
}

/** Test-only: toggle startup recall and/or override its topK/budget. */
export function _setStartupRecallConfigForTesting(opts: {
  enabled?: boolean;
  maxChars?: number;
  topK?: number;
}): void {
  if (opts.enabled !== undefined) startupRecallEnabled = opts.enabled;
  if (opts.maxChars !== undefined) startupRecallConfig.maxChars = opts.maxChars;
  if (opts.topK !== undefined) startupRecallConfig.topK = opts.topK;
}

/**
 * Test-only: force the "next before_agent_start is a fresh session" flag
 * without going through a real session_start event.
 */
export function _setSessionFreshForTesting(fresh: boolean): void {
  sessionIsFresh = fresh;
}

/** Test-only: the most recent detached auto-retain promise (or null). */
export function _getPendingAutoRetainForTesting(): Promise<void> | null {
  return pendingAutoRetain;
}

async function closeEngram(): Promise<void> {
  if (!enginePromise) return;
  try {
    const engram = await enginePromise;
    engram.close();
  } catch {
    // Engram may have failed to open; nothing to close.
  } finally {
    enginePromise = null;
    cachedDbPath = null;
  }
}

// Pi's notify accepts "info" | "warning" | "error". We expose a "success"
// alias for callers' clarity and map it to "info" for Pi.
type NotifyLevel = 'info' | 'warning' | 'error' | 'success';

function notifyOrLog(
  ctx: ExtensionContext | ExtensionCommandContext,
  message: string,
  level: NotifyLevel = 'info',
): void {
  const piLevel: 'info' | 'warning' | 'error' =
    level === 'success' ? 'info' : level;
  if (ctx.hasUI) {
    ctx.ui.notify(message, piLevel);
  } else {
    // Non-interactive mode: surface to stderr so the message isn't swallowed.
    const prefix = level === 'error' ? 'engram-pi error:' : 'engram-pi:';
    // eslint-disable-next-line no-console
    console.error(`${prefix} ${message}`);
  }
}

const OLLAMA_DOWN_MESSAGE =
  'Engram: Ollama unreachable — background memory consolidation paused for this session.';

/**
 * Called from turn_end. Decides (purely) whether a cycle is due, then runs it
 * detached so the turn never waits on Ollama. A single in-flight guard means a
 * long extract/reflect spanning several turns won't stack up. Errors are
 * contained; a connection failure warns the user once per session.
 */
function scheduleConsolidation(ctx: ExtensionContext): void {
  turnCounter += 1;
  if (consolidationInFlight) return;
  // Cheap, DB-free pre-check: bail unless a cadence interval is actually hit.
  if (!consolidationDue(turnCounter, schedulingConfig)) return;
  // Preserve lazy-open: if memory was never used this session there's nothing
  // to consolidate, and we must not pay the embedder-load cost for an idle run.
  if (!enginePromise) return;

  consolidationInFlight = true;
  pendingConsolidation = (async () => {
    try {
      const engram = await getEngram();
      const plan = planConsolidation(
        turnCounter,
        engram.getQueueStats().pending,
        schedulingConfig,
      );
      if (!plan.extract && !plan.reflect) return;

      const result = await runConsolidation(engram, plan, schedulingConfig);
      if (!result.ollamaReachable && !ollamaWarned) {
        ollamaWarned = true;
        notifyOrLog(ctx, OLLAMA_DOWN_MESSAGE, 'warning');
      }
      // A config-class generation failure (no model configured, or the host
      // 404ing a model it doesn't serve) won't fix itself — surface it loudly
      // once rather than let the extraction queue fill silently. This is the
      // integration-side guard against the silent-model-fallback class of bug.
      if (result.generationError && !generationErrorWarned) {
        generationErrorWarned = true;
        notifyOrLog(
          ctx,
          `Engram: background consolidation cannot generate — ${result.generationError} ` +
            `(set ENGRAM_MODEL / ENGRAM_INTEGRATION_MODEL to a model your Ollama host serves).`,
          'warning',
        );
      }
    } catch (err) {
      // Background work must never surface as a turn failure.
      // eslint-disable-next-line no-console
      console.error(
        'engram-pi: background consolidation failed:',
        err instanceof Error ? err.message : err,
      );
    } finally {
      consolidationInFlight = false;
    }
  })();
}

/**
 * Called from message_end. Captures the message as an experience memory,
 * fire-and-forget. Gated by a pure pre-check so a message that won't be stored
 * never opens Engram (preserving lazy-open); retain() is fast and in-process,
 * but we still don't block the turn on it.
 */
function scheduleAutoRetain(message: RetainableMessage, mode?: RunMode): void {
  if (!autoRetainEnabled) return;
  if (!planAutoRetain(message, autoRetainConfig, mode)) return;

  pendingAutoRetain = (async () => {
    try {
      const engram = await getEngram();
      await autoRetain(engram, message, autoRetainConfig, mode);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        'engram-pi: auto-retain failed:',
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/** Resolve after `ms`, regardless of the raced promise. */
function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Don't keep the process alive just for the flush timer.
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * session_shutdown flush: wait out any in-flight cycle, then run one final
 * drain + reflect, all bounded by SHUTDOWN_FLUSH_TIMEOUT_MS so a wedged Ollama
 * can't hang the agent's exit. Best-effort and silent (the UI is gone).
 */
async function flushOnShutdown(): Promise<void> {
  if (!enginePromise) return;
  await Promise.race([
    (async () => {
      if (pendingConsolidation) {
        await pendingConsolidation.catch(() => undefined);
      }
      const engram = await enginePromise!;
      const pending = engram.getQueueStats().pending;
      await runConsolidation(
        engram,
        { extract: pending > 0, reflect: true },
        schedulingConfig,
      ).catch(() => undefined);
    })(),
    timeout(SHUTDOWN_FLUSH_TIMEOUT_MS),
  ]);
}

function formatRecallResults(
  query: string,
  response: Awaited<ReturnType<typeof recall>>,
): string {
  if (response.results.length === 0) {
    return `No memories matched "${query}".`;
  }
  const lines = [`${response.results.length} match(es) for "${query}":`, ''];
  for (const r of response.results) {
    const trust = r.trustScore?.toFixed(2) ?? '?';
    const src = r.source ? ` [${r.source}]` : '';
    lines.push(`  • ${r.id} (trust ${trust})${src}`);
    lines.push(`    ${r.text.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  if (response.opinions.length > 0) {
    lines.push('', 'Related opinions:');
    for (const op of response.opinions) {
      lines.push(`  • [${op.confidence.toFixed(2)}] ${op.belief}`);
    }
  }
  return lines.join('\n');
}

export default function engramPiExtension(pi: ExtensionAPI): void {
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  pi.on('session_start', (event, ctx) => {
    // See isFreshSessionStart in adapter.ts: 'new' only fires for an explicit
    // mid-process session switch, never an initial process launch — every
    // launch (interactive or `pi -p`) reports 'startup' whether or not it
    // loaded prior history via --continue/--resume/--session. Prior *message*
    // entry count disambiguates a genuinely blank slate from a continuation
    // (already covered by the working-memory session bridge / SESSION_ADDENDUM
    // nudge) — bookkeeping entries (model_change, thinking_level_change, ...)
    // are appended before session_start fires on every launch, so they must
    // be filtered out or a fresh session would never read as zero.
    const priorMessageCount = ctx.sessionManager
      .getEntries()
      .filter((e) => e.type === 'message').length;
    sessionIsFresh = isFreshSessionStart(event.reason, priorMessageCount);

    const plannedPath = process.env.ENGRAM_PI_DB_PATH
      ? resolve(process.env.ENGRAM_PI_DB_PATH)
      : resolve(process.cwd(), DEFAULT_DB_RELATIVE);
    notifyOrLog(
      ctx,
      `Engram extension ready. DB will open at ${plannedPath} on first use.`,
    );
  });

  pi.on('session_shutdown', async () => {
    await flushOnShutdown();
    await closeEngram();
  });

  // Background consolidation cadence. The handler returns synchronously (void);
  // the actual extract/reflect runs detached so the turn never blocks on Ollama.
  pi.on('turn_end', (_event, ctx) => {
    scheduleConsolidation(ctx);
  });

  // Auto-retain: capture each completed message as an experience memory.
  // ctx.mode distinguishes a live interactive (tui) session from a
  // non-interactive one (rpc/json/print, e.g. `pi -p`) — see planAutoRetain.
  pi.on('message_end', (event, ctx) => {
    const message = (event as { message?: RetainableMessage }).message;
    if (message) scheduleAutoRetain(message, ctx.mode);
  });

  pi.on('before_agent_start', async (event) => {
    // Consume the fresh-session flag immediately — regardless of what happens
    // below, only the first turn of a new session is ever eligible. This is
    // what keeps startup recall one-shot instead of running every turn.
    const isFreshSessionStart = sessionIsFresh;
    sessionIsFresh = false;

    let startingContext: string | null = null;
    if (isFreshSessionStart && startupRecallEnabled) {
      try {
        const engram = await getEngram();
        startingContext = await startupRecall(engram, {
          prompt: event.prompt,
          maxChars: startupRecallConfig.maxChars,
          topK: startupRecallConfig.topK,
        });
      } catch (err) {
        // Never block the turn over this — proceed without starting context.
        // eslint-disable-next-line no-console
        console.error(
          'engram-pi: startup recall failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    try {
      const addition = startingContext
        ? `\n${startingContext}\n${SESSION_ADDENDUM}`
        : `\n${SESSION_ADDENDUM}`;
      return {
        systemPrompt: `${event.systemPrompt}${addition}`,
      };
    } catch (err) {
      // Never break a turn over the addendum — return nothing so Pi keeps
      // the existing system prompt.
      // eslint-disable-next-line no-console
      console.error(
        'engram-pi: failed to append session addendum:',
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  });

  // ---------------------------------------------------------------------------
  // Slash commands
  // ---------------------------------------------------------------------------

  pi.registerCommand('remember', {
    description: 'Store a fact in long-term memory: /remember <text>',
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        notifyOrLog(ctx, 'Usage: /remember <text>', 'warning');
        return;
      }
      const engram = await getEngram();
      const result = await remember(engram, { text, fromLLM: false });
      notifyOrLog(ctx, `Stored ${result.chunkId}`, 'success');
    },
  });

  pi.registerCommand('recall', {
    description: 'Search memory: /recall <query>',
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        notifyOrLog(ctx, 'Usage: /recall <query>', 'warning');
        return;
      }
      const engram = await getEngram();
      const response = await recall(engram, { query, topK: 5 });
      notifyOrLog(ctx, formatRecallResults(query, response));
    },
  });

  pi.registerCommand('memory', {
    description: 'Show memory stats: /memory',
    handler: async (_args, ctx) => {
      const engram = await getEngram();
      const stats = memoryStats(engram);
      const dbInfo = cachedDbPath ? `\n  db: ${cachedDbPath}` : '';
      const message = [
        `Engram memory stats:${dbInfo}`,
        `  chunks:       ${stats.chunks}`,
        `  entities:     ${stats.entities}`,
        `  opinions:     ${stats.opinions}`,
        `  observations: ${stats.observations}`,
        `  extraction queue: ${stats.extractionQueue.pending} pending, ${stats.extractionQueue.processing} processing, ${stats.extractionQueue.failed} failed`,
      ].join('\n');
      notifyOrLog(ctx, message);
    },
  });

  pi.registerCommand('forget', {
    description:
      'Soft-delete a memory: /forget <chunk-id>  OR  /forget <query> (confirms first)',
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (!arg) {
        notifyOrLog(ctx, 'Usage: /forget <chunk-id|query>', 'warning');
        return;
      }
      const engram = await getEngram();

      if (looksLikeChunkId(arg)) {
        const ok = await forgetById(engram, arg);
        notifyOrLog(
          ctx,
          ok ? `Forgot ${arg}` : `No active chunk found with id ${arg}`,
          ok ? 'success' : 'warning',
        );
        return;
      }

      // Query path: find best candidate, ask before deleting.
      const candidate = await findToForget(engram, arg);
      if (!candidate) {
        notifyOrLog(ctx, `No memory matched "${arg}".`, 'warning');
        return;
      }

      if (!ctx.hasUI) {
        notifyOrLog(
          ctx,
          `Refusing to forget by query in non-interactive mode. Re-run with chunk id ${candidate.chunkId}.`,
          'warning',
        );
        return;
      }

      const confirmed = await ctx.ui.confirm(
        'Forget this memory?',
        `${candidate.chunkId} — ${candidate.text.slice(0, 200)}`,
      );
      if (!confirmed) {
        notifyOrLog(ctx, 'Forget cancelled.');
        return;
      }
      const ok = await forgetById(engram, candidate.chunkId);
      notifyOrLog(
        ctx,
        ok ? `Forgot ${candidate.chunkId}` : 'Forget failed.',
        ok ? 'success' : 'error',
      );
    },
  });

  pi.registerCommand('session', {
    description: 'Show the current working session and list active sessions',
    handler: async (_args, ctx) => {
      const engram = await getEngram();
      const active = engram.listWorkingSessions();
      const lines: string[] = [];

      if (currentSessionId) {
        const current = active.find((s) => s.id === currentSessionId);
        if (current) {
          lines.push(`Current: ${current.id} — ${current.goal}`);
          const progress =
            typeof current.progress === 'string' ? current.progress : undefined;
          if (progress) {
            lines.push(`  Progress: ${progress}`);
          }
          lines.push('');
        }
      } else {
        lines.push(
          'No active session in this run — call engram_session_resume to start one.',
        );
        lines.push('');
      }

      if (active.length === 0) {
        lines.push('No active working memory sessions.');
      } else {
        lines.push(`Active sessions (${active.length}):`);
        for (const s of active) {
          const marker = s.id === currentSessionId ? '*' : ' ';
          lines.push(`  ${marker} ${s.id} — ${s.goal}`);
        }
      }

      notifyOrLog(ctx, lines.join('\n'));
    },
  });

  // ---------------------------------------------------------------------------
  // LLM tools
  // ---------------------------------------------------------------------------

  pi.registerTool({
    name: 'engram_remember',
    label: 'Remember',
    description:
      'Store a fact, decision, or piece of context in long-term Engram memory. Use sparingly: only for information that may be useful in a future session.',
    parameters: RememberParams,
    async execute(_id, params: RememberToolParams) {
      const engram = await getEngram();
      const result = await remember(engram, {
        text: params.text,
        source: params.source,
        context: params.context,
        trustScore: params.trustScore,
        fromLLM: true,
      });
      return {
        content: [{ type: 'text', text: `Stored ${result.chunkId}` }],
        details: {
          chunkId: result.chunkId,
          deduplicated: result.deduplicated ?? false,
        },
      };
    },
  });

  pi.registerTool({
    name: 'engram_recall',
    label: 'Recall',
    description:
      'Search Engram memory using semantic, keyword, graph, and temporal strategies. Natural-language queries with phrases like "last week" auto-activate temporal filtering. Optional filters: memoryTypes, after/before (ISO dates), strategies (restrict which of the four run), minScore (drop low-relevance results).',
    parameters: RecallParams,
    async execute(_id, params: RecallToolParams) {
      const engram = await getEngram();
      const response = await recall(engram, {
        query: params.query,
        topK: params.topK,
        minTrust: params.minTrust,
        memoryTypes: params.memoryTypes,
        after: params.after,
        before: params.before,
        strategies: params.strategies,
        minScore: params.minScore,
      });
      return {
        content: [
          { type: 'text', text: formatRecallResults(params.query, response) },
        ],
        details: {
          totalCandidates: response.totalCandidates,
          strategiesUsed: response.strategiesUsed,
          resultCount: response.results.length,
        },
      };
    },
  });

  pi.registerTool({
    name: 'engram_memory_stats',
    label: 'Memory Stats',
    description: 'Report counts of chunks, entities, opinions, observations, and extraction queue depth.',
    parameters: MemoryStatsParams,
    async execute() {
      const engram = await getEngram();
      const stats = memoryStats(engram);
      return {
        content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
        details: stats,
      };
    },
  });

  pi.registerTool({
    name: 'engram_forget',
    label: 'Forget',
    description:
      'Soft-delete a memory chunk by its id (format chk-xxx). Use engram_recall first to find the id; do not invent ids.',
    parameters: ForgetParams,
    async execute(_id, params: ForgetToolParams) {
      const engram = await getEngram();
      const ok = await forgetById(engram, params.chunkId);
      return {
        content: [
          {
            type: 'text',
            text: ok
              ? `Forgot ${params.chunkId}`
              : `No active chunk found with id ${params.chunkId}`,
          },
        ],
        details: { chunkId: params.chunkId, forgotten: ok },
      };
    },
  });

  pi.registerTool({
    name: 'engram_session_resume',
    label: 'Session Resume',
    description:
      'Resume or create a working memory session for the current task. Call early when starting substantive multi-turn work. Returns the session id, goal, prior progress (if any), and related long-term context. Pass the session id to engram_session_update / engram_session_snapshot.',
    parameters: SessionResumeParams,
    async execute(_id, params: SessionResumeToolParams) {
      const engram = await getEngram();
      const result = await resumeSession(engram, {
        message: params.message,
        threshold: params.threshold,
        maxActive: params.maxActive,
      });
      currentSessionId = result.sessionId;
      const summary = [
        `${result.reason === 'new' ? 'New' : 'Resumed'} session ${result.sessionId}`,
        `Goal: ${result.goal}`,
        result.progress ? `Progress: ${result.progress}` : null,
        result.relatedContext ? `\n${result.relatedContext}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        content: [{ type: 'text', text: summary }],
        details: result,
      };
    },
  });

  pi.registerTool<typeof SessionUpdateParams, unknown>({
    name: 'engram_session_update',
    label: 'Session Update',
    description:
      'Update progress on an active working memory session. Call before turn boundaries you want preserved across sessions. Provide the sessionId from engram_session_resume.',
    parameters: SessionUpdateParams,
    async execute(_id, params: SessionUpdateToolParams) {
      const engram = await getEngram();
      try {
        const result = await updateSession(engram, {
          sessionId: params.sessionId,
          progress: params.progress,
          extensions: params.extensions as
            | Record<string, unknown>
            | undefined,
        });
        currentSessionId = result.sessionId;
        return {
          content: [
            {
              type: 'text',
              text: `Updated ${result.sessionId} (updated_at ${result.updated_at})`,
            },
          ],
          details: result,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Update failed: ${msg}` }],
          isError: true,
          details: { sessionId: params.sessionId, error: msg },
        };
      }
    },
  });

  pi.registerTool<typeof SessionSnapshotParams, unknown>({
    name: 'engram_session_snapshot',
    label: 'Session Snapshot',
    description:
      'Snapshot a completed working memory session to long-term memory and end it. The session goal + progress are retained as a chunk; the session is then expired. Use when the agent considers a piece of work complete.',
    parameters: SessionSnapshotParams,
    async execute(_id, params: SessionSnapshotToolParams) {
      const engram = await getEngram();
      try {
        const result = await snapshotSession(engram, {
          sessionId: params.sessionId,
        });
        // Only clear the live pointer when snapshotting the current session;
        // snapshotting an unrelated/explicit sessionId must not clobber active work.
        if (currentSessionId === params.sessionId) {
          currentSessionId = null;
        }
        return {
          content: [
            {
              type: 'text',
              text: `Snapshotted ${result.sessionId} → ${result.chunkId}`,
            },
          ],
          details: result,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Snapshot failed: ${msg}` }],
          isError: true,
          details: { sessionId: params.sessionId, error: msg },
        };
      }
    },
  });
}
