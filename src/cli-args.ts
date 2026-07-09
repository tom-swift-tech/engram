// =============================================================================
// cli-args.ts — Argument parsing + validation shared by the `engram` CLI
//
// The CLI (src/cli.ts) is a thin transport over the Engram core, structurally
// a sibling of mcp-server.ts. This module holds everything the CLI needs that
// is NOT dispatch logic: argv parsing, the Engram.open option-builder (mirrors
// the flag set mcp-server.ts accepts), and the input-validation/clamp helpers.
//
// The validation helpers (clampTrust, filterEnums, VALID_* sets) intentionally
// mirror the private copies inside mcp-tools.ts. mcp-tools.ts is frozen (its
// existing Vitest suite must pass unchanged), so rather than re-export from
// there we keep a single canonical copy here that any future transport can
// import alongside the CLI.
// =============================================================================

import type { EngramOptions } from './engram.js';
import { DEFAULT_OLLAMA_URL } from './engram.js';

// ─── Validation / clamp helpers (mirror mcp-tools.ts) ────────────────────────

export const VALID_MEMORY_TYPES = new Set([
  'world',
  'experience',
  'observation',
  'opinion',
]);
export const VALID_SOURCE_TYPES = new Set([
  'user_stated',
  'inferred',
  'external_doc',
  'tool_result',
  'agent_generated',
]);
export const VALID_STRATEGIES = new Set([
  'semantic',
  'keyword',
  'graph',
  'temporal',
]);

/** Clamp a numeric trust value to [0, 1]. Returns undefined if not a number. */
export function clampTrust(v: unknown): number | undefined {
  if (typeof v !== 'number' || isNaN(v)) return undefined;
  return Math.max(0, Math.min(1, v));
}

/**
 * Filter an array to only values present in a valid set. Returns undefined if
 * the result is empty or the input is not an array.
 */
export function filterEnums<T extends string>(
  arr: unknown,
  valid: Set<string>,
): T[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  const filtered = arr.filter(
    (v) => typeof v === 'string' && valid.has(v),
  ) as T[];
  return filtered.length > 0 ? filtered : undefined;
}

// ─── Subcommand surface ──────────────────────────────────────────────────────

/**
 * Canonical CLI subcommand list — one kebab-cased twin per `engram_*` MCP tool
 * in mcp-tools.ts. tests/surface-parity.test.ts asserts this stays 1:1 with
 * ENGRAM_TOOLS (and that cli.ts dispatch handles every entry), so adding an
 * MCP tool without its CLI twin fails the suite instead of drifting silently.
 */
export const CLI_COMMANDS = [
  'retain',
  'recall',
  'reflect',
  'process-extractions',
  'forget',
  'supersede',
  'session',
  'queue-stats',
  'requeue-failed',
  'embed',
] as const;

// ─── argv parsing ────────────────────────────────────────────────────────────

/** Flags that take no value — their presence is the signal. */
const BOOLEAN_FLAGS = new Set([
  '--json',
  '--use-ollama-embeddings',
  '--opinions',
  '--no-opinions',
  '--observations',
  '--no-observations',
]);

export interface ParsedArgs {
  /** First positional token — the subcommand (undefined if none). */
  command: string | undefined;
  /** Remaining positional tokens (text args, ids), command removed. */
  positionals: string[];
  /** `--flag value` pairs. */
  values: Map<string, string>;
  /** Boolean flags that were present. */
  bools: Set<string>;
}

/**
 * Parse argv (already sliced past `node script`). Tokens starting with `--` are
 * flags: known boolean flags consume nothing, everything else consumes the next
 * token as its value. Non-flag tokens are positionals; the first is the command.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const bools = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      if (BOOLEAN_FLAGS.has(tok)) {
        bools.add(tok);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        values.set(tok, next);
        i++;
      } else {
        // value-flag given without a value — record presence, no value
        bools.add(tok);
      }
    } else {
      positionals.push(tok);
    }
  }

  const command = positionals.shift();
  return { command, positionals, values, bools };
}

/** Parse a flag value as a number. Returns undefined if absent or NaN. */
export function asNumber(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/** Split a comma-separated flag value into a trimmed list. */
export function asList(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/**
 * Resolve the tri-state of a `--x` / `--no-x` flag pair.
 * Returns true if `--x` present, false if `--no-x` present, undefined if neither.
 */
export function triStateFlag(
  bools: Set<string>,
  positive: string,
  negative: string,
): boolean | undefined {
  if (bools.has(negative)) return false;
  if (bools.has(positive)) return true;
  return undefined;
}

// ─── DB path + Engram.open options ───────────────────────────────────────────

/**
 * Resolve the engram file path: `--db <path>` first, then the ENGRAM_DB env var.
 * Returns undefined if neither is set (caller errors out).
 */
export function resolveDbPath(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return args.values.get('--db') ?? env.ENGRAM_DB ?? undefined;
}

/**
 * Build the EngramOptions passed to Engram.open from generation/embedding flags.
 * Mirrors the precedence in mcp-server.ts: Anthropic > OpenAI-compatible endpoint
 * > default Ollama.
 */
export function buildEngramOptions(args: ParsedArgs): EngramOptions {
  const opts: EngramOptions = {
    ollamaUrl: args.values.get('--ollama-url') ?? DEFAULT_OLLAMA_URL,
    useOllamaEmbeddings: args.bools.has('--use-ollama-embeddings'),
    reflectModel: args.values.get('--reflect-model') ?? 'llama3.1:8b',
  };

  const anthropicApiKey = args.values.get('--anthropic-api-key');
  const anthropicModel = args.values.get('--anthropic-model');
  const generationEndpoint = args.values.get('--generation-endpoint');
  const generationModel = args.values.get('--generation-model');
  const generationApiKey = args.values.get('--generation-api-key');

  if (anthropicApiKey) {
    opts.anthropicGeneration = {
      apiKey: anthropicApiKey,
      model: anthropicModel,
    };
  } else if (generationEndpoint && generationModel) {
    opts.generationEndpoint = {
      baseUrl: generationEndpoint,
      model: generationModel,
      apiKey: generationApiKey,
    };
  }

  return opts;
}
