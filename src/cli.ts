#!/usr/bin/env node
// =============================================================================
// cli.ts — `engram` command-line transport over the Engram core
//
// A fourth transport alongside the library API and the MCP server. Structurally
// a sibling of mcp-server.ts: parse argv → Engram.open() → dispatch to the SAME
// engram methods → print. No retain/recall/reflect logic lives here.
//
// One subcommand per MCP tool, kebab-cased so skills/cli-memory/SKILL.md maps
// 1:1 to the MCP tool surface:
//
//   engram retain <text>            engram recall <query>
//   engram reflect                  engram process-extractions
//   engram forget <chunkId>         engram supersede <oldChunkId> <newText>
//   engram session <message>        engram queue-stats
//   engram requeue-failed
//
// Contract:
//   --json        emit the raw method return as JSON to stdout, nothing else.
//   (default)     human-readable output to stdout.
//   stdout        data only. All diagnostics/logging go to stderr.
//   stdin         primary text arg for retain/recall/session/supersede-newText
//                 is read from stdin when the positional is omitted.
//   exit codes    0 success · 2 not-found (forget/supersede missing chunk) · 1 error.
//
// Usage:
//   engram recall "terraform" --db ./agent.engram
//   ENGRAM_DB=./agent.engram engram retain "Tom prefers Pulumi" --memory-type world
//   echo "long context" | engram retain --db ./agent.engram --json
// =============================================================================

import Database from 'better-sqlite3';
import { pathToFileURL } from 'url';

import { Engram } from './engram.js';
import type {
  EngramOptions,
  RetainOptions,
  RecallOptions,
  RecallResponse,
  RetainResult,
  ReflectResult,
  WorkingSessionResult,
} from './engram.js';
import type { QueueStats } from './retain.js';
import {
  parseArgs,
  buildEngramOptions,
  resolveDbPath,
  clampTrust,
  filterEnums,
  asNumber,
  asList,
  triStateFlag,
  VALID_MEMORY_TYPES,
  VALID_SOURCE_TYPES,
  VALID_STRATEGIES,
  type ParsedArgs,
} from './cli-args.js';

// ─── Exit codes ──────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_NOT_FOUND = 2;

// ─── IO abstraction (injectable for tests) ───────────────────────────────────

export interface CliIO {
  stdout(s: string): void;
  stderr(s: string): void;
  /** Read the full stdin as text. Called lazily, only when a text arg is omitted. */
  readStdin(): Promise<string>;
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

const defaultIo: CliIO = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin: readAllStdin,
};

// ─── Option builders (input → engram method options) ─────────────────────────

function buildRetainOptions(args: ParsedArgs): RetainOptions {
  const memoryType = args.values.get('--memory-type');
  const sourceType = args.values.get('--source-type');
  return {
    memoryType: VALID_MEMORY_TYPES.has(memoryType ?? '')
      ? (memoryType as RetainOptions['memoryType'])
      : undefined,
    sourceType: VALID_SOURCE_TYPES.has(sourceType ?? '')
      ? (sourceType as RetainOptions['sourceType'])
      : undefined,
    trustScore: clampTrust(asNumber(args.values.get('--trust-score'))),
    source: args.values.get('--source'),
    context: args.values.get('--context'),
    eventTime: args.values.get('--event-time'),
    temporalLabel: args.values.get('--temporal-label'),
  };
}

function buildRecallOptions(args: ParsedArgs): RecallOptions {
  const topK = asNumber(args.values.get('--top-k'));
  return {
    topK: topK !== undefined ? Math.max(1, Math.floor(topK)) : undefined,
    strategies: filterEnums<'semantic' | 'keyword' | 'graph' | 'temporal'>(
      asList(args.values.get('--strategies')),
      VALID_STRATEGIES,
    ),
    memoryTypes: filterEnums<
      'world' | 'experience' | 'observation' | 'opinion'
    >(asList(args.values.get('--memory-types')), VALID_MEMORY_TYPES),
    minTrust: clampTrust(asNumber(args.values.get('--min-trust'))),
    after: args.values.get('--after'),
    before: args.values.get('--before'),
    includeOpinions: triStateFlag(args.bools, '--opinions', '--no-opinions'),
    includeObservations: triStateFlag(
      args.bools,
      '--observations',
      '--no-observations',
    ),
  };
}

// ─── Human-readable formatters ───────────────────────────────────────────────

function formatRetain(r: RetainResult): string {
  const flags = [
    `queued=${r.queued}`,
    r.deduplicated ? 'deduplicated' : null,
    r.tier1
      ? `entities=${r.tier1.entitiesLinked} relations=${r.tier1.relationsCreated}`
      : null,
  ]
    .filter(Boolean)
    .join(' ');
  return `retained ${r.chunkId} (${flags})\n`;
}

function formatRecall(r: RecallResponse): string {
  const lines: string[] = [];
  lines.push(
    `${r.results.length} result(s) · ${r.totalCandidates} candidate(s) · strategies: ${r.strategiesUsed.join(', ') || 'none'}`,
  );
  r.results.forEach((res, i) => {
    lines.push(
      `\n[${i + 1}] score=${res.score.toFixed(3)} ${res.memoryType} trust=${res.trustScore.toFixed(2)} via=${res.strategies.join('+')}`,
    );
    lines.push(`    ${res.text}`);
  });
  if (r.opinions.length > 0) {
    lines.push('\nOpinions:');
    for (const o of r.opinions) {
      lines.push(`  (${o.confidence.toFixed(2)}) ${o.belief}`);
    }
  }
  if (r.observations.length > 0) {
    lines.push('\nObservations:');
    for (const o of r.observations) {
      lines.push(`  - ${o.summary}`);
    }
  }
  return lines.join('\n') + '\n';
}

function formatReflect(r: ReflectResult): string {
  return (
    `reflect: status=${r.status} facts=${r.factsProcessed} ` +
    `observations=+${r.observationsCreated}/~${r.observationsUpdated} ` +
    `opinions=new${r.opinionsFormed}/+${r.opinionsReinforced}/-${r.opinionsChallenged} ` +
    `(${r.durationMs}ms)\n`
  );
}

function formatSession(r: WorkingSessionResult): string {
  const lines = [
    `session ${r.session.id} (${r.diagnostics.reason}, confidence=${r.confidence.toFixed(2)}, candidates=${r.diagnostics.candidatesEvaluated})`,
    `goal: ${r.session.goal}`,
  ];
  if (r.relatedContext.trim()) {
    lines.push('related context:', r.relatedContext);
  }
  return lines.join('\n') + '\n';
}

function formatQueueStats(s: QueueStats): string {
  let out =
    `queue: pending=${s.pending} processing=${s.processing} ` +
    `completed=${s.completed} failed=${s.failed} ` +
    `oldest_pending=${s.oldest_pending ?? 'none'}\n`;
  if (s.failed_reasons.length > 0) {
    out += 'failed reasons:\n';
    for (const r of s.failed_reasons) {
      out += `  ${r.count}x ${r.error ?? '(no error recorded)'}\n`;
    }
  }
  return out;
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

/**
 * Does an active chunk with this id exist? Engram exposes no chunk getter and
 * engram.supersede() always succeeds (creating a new chunk regardless), so we
 * pre-check via a short-lived read-only connection — this both honors the
 * exit-code-2 contract and avoids leaving an orphan chunk when the target id
 * does not exist.
 */
function chunkExists(dbPath: string, chunkId: string): boolean {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare('SELECT 1 AS x FROM chunks WHERE id = ? AND is_active = TRUE')
      .get(chunkId);
    return Boolean(row);
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function emitJson(io: CliIO, value: unknown): void {
  io.stdout(JSON.stringify(value) + '\n');
}

const USAGE = `Usage: engram <command> [args] [options]

Commands:
  retain <text>                    Store a memory trace (text from stdin if omitted)
  recall <query>                   Four-way retrieval (query from stdin if omitted)
  reflect                          Run a reflection cycle
  process-extractions              Drain the entity extraction queue
  forget <chunkId>                 Soft-delete a chunk
  supersede <oldChunkId> <newText> Replace a fact (newText from stdin if omitted)
  session <message>                Infer/resume a working memory session
  queue-stats                      Extraction queue health
  requeue-failed                   Re-queue failed extractions for retry
                                   (--error-like <substring> to filter)

Database:
  --db <path>                      Path to the .engram file (or set ENGRAM_DB)

Common options:
  --json                           Emit the raw method return as JSON to stdout
  --ollama-url <url>               Ollama endpoint (default: http://localhost:11434)
  --use-ollama-embeddings          Use Ollama for embeddings
  --reflect-model <model>          LLM for extraction + reflection
  --generation-endpoint <url>      OpenAI-compatible generation endpoint
  --generation-model <model>       Model for the OpenAI-compatible endpoint
  --generation-api-key <key>       API key for the generation endpoint
  --anthropic-api-key <key>        Anthropic API key (Claude generation)
  --anthropic-model <model>        Anthropic model

retain / supersede write options:
  --memory-type <world|experience|observation|opinion>
  --source <id>  --context <tag>
  --source-type <user_stated|inferred|external_doc|tool_result|agent_generated>
  --trust-score <0..1>  --event-time <iso8601>  --temporal-label <text>

recall options:
  --top-k <n>  --strategies <semantic,keyword,graph,temporal>
  --memory-types <world,experience,...>  --min-trust <0..1>
  --after <iso8601>  --before <iso8601>
  --[no-]opinions  --[no-]observations

session options:
  --max-active <n>  --threshold <0..1>

process-extractions options:
  --batch-size <n>

Exit codes: 0 success · 2 not-found · 1 error
`;

// ─── Main dispatch ────────────────────────────────────────────────────────────

/**
 * Run the CLI. Returns the process exit code (the entry point calls
 * process.exit with it). Injectable IO + option overrides keep this testable
 * in-process without spawning a subprocess.
 */
export async function runCli(
  argv: string[],
  io: CliIO = defaultIo,
  optionOverrides: Partial<EngramOptions> = {},
): Promise<number> {
  const args = parseArgs(argv);

  if (!args.command || args.command === 'help' || args.bools.has('--help')) {
    io.stderr(USAGE);
    return args.command ? EXIT_OK : EXIT_ERROR;
  }

  const dbPath = resolveDbPath(args, process.env);
  if (!dbPath) {
    io.stderr('engram: no database path. Pass --db <path> or set ENGRAM_DB.\n');
    return EXIT_ERROR;
  }

  const engramOptions: EngramOptions = {
    ...buildEngramOptions(args),
    ...optionOverrides,
  };

  let engram: Engram;
  try {
    engram = await Engram.open(dbPath, engramOptions);
  } catch (err) {
    io.stderr(`engram: failed to open ${dbPath}: ${errMessage(err)}\n`);
    return EXIT_ERROR;
  }

  io.stderr(`[engram] ${args.command} on ${dbPath}\n`);

  const json = args.bools.has('--json');

  try {
    return await dispatch(args, engram, dbPath, io, json);
  } catch (err) {
    io.stderr(`engram: ${errMessage(err)}\n`);
    return EXIT_ERROR;
  } finally {
    engram.close();
  }
}

async function dispatch(
  args: ParsedArgs,
  engram: Engram,
  dbPath: string,
  io: CliIO,
  json: boolean,
): Promise<number> {
  switch (args.command) {
    case 'retain': {
      const text = await resolveText(args.positionals[0], io);
      if (!text) return missingArg(io, 'text');
      const result = await engram.retain(text, buildRetainOptions(args));
      if (json) emitJson(io, result);
      else io.stdout(formatRetain(result));
      return EXIT_OK;
    }

    case 'recall': {
      const query = await resolveText(args.positionals[0], io);
      if (!query) return missingArg(io, 'query');
      const result = await engram.recall(query, buildRecallOptions(args));
      if (json) emitJson(io, result);
      else io.stdout(formatRecall(result));
      return EXIT_OK;
    }

    case 'reflect': {
      const result = await engram.reflect();
      if (json) emitJson(io, result);
      else io.stdout(formatReflect(result));
      return EXIT_OK;
    }

    case 'process-extractions': {
      const batchSize = asNumber(args.values.get('--batch-size'));
      const result = await engram.processExtractions(
        batchSize !== undefined
          ? Math.max(1, Math.floor(batchSize))
          : undefined,
      );
      if (json) emitJson(io, result);
      else
        io.stdout(
          `extractions: processed=${result.processed} failed=${result.failed}\n`,
        );
      return EXIT_OK;
    }

    case 'forget': {
      const chunkId = args.positionals[0];
      if (!chunkId) return missingArg(io, 'chunkId');
      const forgotten = await engram.forget(chunkId);
      if (json) emitJson(io, { forgotten });
      else
        io.stdout(
          forgotten ? `forgot ${chunkId}\n` : `not found: ${chunkId}\n`,
        );
      return forgotten ? EXIT_OK : EXIT_NOT_FOUND;
    }

    case 'supersede': {
      const oldChunkId = args.positionals[0];
      if (!oldChunkId) return missingArg(io, 'oldChunkId');
      const newText = await resolveText(args.positionals[1], io);
      if (!newText) return missingArg(io, 'newText');
      if (!chunkExists(dbPath, oldChunkId)) {
        io.stderr(`engram: chunk not found: ${oldChunkId}\n`);
        return EXIT_NOT_FOUND;
      }
      const result = await engram.supersede(
        oldChunkId,
        newText,
        buildRetainOptions(args),
      );
      if (json) emitJson(io, result);
      else io.stdout(`superseded ${oldChunkId} -> ${result.chunkId}\n`);
      return EXIT_OK;
    }

    case 'session': {
      const message = await resolveText(args.positionals[0], io);
      if (!message) return missingArg(io, 'message');
      const result = await engram.inferWorkingSession(message, {
        maxActive: asNumber(args.values.get('--max-active')),
        threshold: asNumber(args.values.get('--threshold')),
      });
      if (json) emitJson(io, result);
      else io.stdout(formatSession(result));
      return EXIT_OK;
    }

    case 'queue-stats': {
      const stats = engram.getQueueStats();
      if (json) emitJson(io, stats);
      else io.stdout(formatQueueStats(stats));
      return EXIT_OK;
    }

    case 'requeue-failed': {
      const result = engram.requeueFailedExtractions({
        errorLike: args.values.get('--error-like'),
      });
      if (json) emitJson(io, result);
      else io.stdout(`requeued ${result.requeued} failed item(s)\n`);
      return EXIT_OK;
    }

    default: {
      io.stderr(`engram: unknown command "${args.command}"\n\n${USAGE}`);
      return EXIT_ERROR;
    }
  }
}

/** Use the positional if present, otherwise read from stdin. */
async function resolveText(
  positional: string | undefined,
  io: CliIO,
): Promise<string> {
  if (positional !== undefined && positional.trim() !== '') return positional;
  return (await io.readStdin()).trim();
}

function missingArg(io: CliIO, name: string): number {
  io.stderr(`engram: missing required argument: ${name}\n`);
  return EXIT_ERROR;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
// Only auto-run when invoked directly (engram-cli), not when imported by tests.

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`engram: fatal: ${errMessage(err)}\n`);
      process.exit(EXIT_ERROR);
    });
}
