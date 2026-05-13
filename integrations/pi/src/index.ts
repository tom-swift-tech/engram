// =============================================================================
// index.ts — Pi extension entry point. Default-exports the factory Pi calls
// when loading the extension.
//
// Lifecycle:
//   - On factory invocation: register slash commands and LLM tools (synchronous
//     so /reload works predictably and registration is visible immediately).
//   - On 'session_start': lazily open Engram (project-local .engram/pi.db) so
//     the embedding model only loads when actually used.
//   - On 'session_shutdown': close Engram. Pi may not always fire this (e.g.
//     crash); SQLite WAL is durable across abrupt exits.
//
// Slash commands:
//   /remember <text>       store a fact
//   /recall   <query>      retrieve relevant memories
//   /memory                show memory stats
//   /forget   <id|query>   soft-delete a chunk (confirms before query-based deletes)
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
import { Engram } from 'engram';

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

let enginePromise: Promise<Engram> | null = null;
let cachedDbPath: string | null = null;

// Module-level transient pointer set by engram_session_* tools so the
// /session slash command can answer "what are you currently working on?"
// Never persisted; lost on reload. Engram remains the only stateful party.
let currentSessionId: string | null = null;

// Engine factory — overridable from tests to swap in a deterministic embedder
// without paying the LocalEmbedder model download. Production never touches
// this; the only setter is the test-only export below, prefixed `_`.
type EngineFactory = (path: string) => Promise<Engram>;
let engineFactory: EngineFactory = (path) => Engram.open(path);

/**
 * Lazy Engram opener. Called on first command/tool invocation. Reuses the
 * same instance across the session — Engram holds a single SQLite connection
 * with WAL mode, safe for many readers.
 */
async function getEngram(): Promise<Engram> {
  if (enginePromise) return enginePromise;

  const dbPath = resolve(process.cwd(), DEFAULT_DB_RELATIVE);
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
  engineFactory = factory;
}

/** Test-only: reset to default factory and drop any cached engine. */
export function _resetEngineFactoryForTesting(): void {
  enginePromise = null;
  cachedDbPath = null;
  currentSessionId = null;
  engineFactory = (path) => Engram.open(path);
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

  pi.on('session_start', (_event, ctx) => {
    notifyOrLog(
      ctx,
      `Engram extension ready. DB will open at ${resolve(process.cwd(), DEFAULT_DB_RELATIVE)} on first use.`,
    );
  });

  pi.on('session_shutdown', async () => {
    await closeEngram();
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
      'Search Engram memory using semantic, keyword, graph, and temporal strategies. Natural-language queries with phrases like "last week" auto-activate temporal filtering.',
    parameters: RecallParams,
    async execute(_id, params: RecallToolParams) {
      const engram = await getEngram();
      const response = await recall(engram, {
        query: params.query,
        topK: params.topK,
        minTrust: params.minTrust,
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
