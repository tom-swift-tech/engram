// =============================================================================
// Shared helper for subprocess-based AQL tests
//
// Spawns the `engram-aql query` binary against a .engram file and parses the
// JSON result. Used by both the end-to-end cross-process test suite and the
// semantic-equivalence test suite. Lazy-builds the binary on first use so
// TS-only iterations don't pay a cargo cost.
//
// The binary exits 0 on successful queries (including zero-row results) and
// exit 1 on parse errors or write-rejection. In both cases it writes the full
// QueryResult JSON to stdout; we parse it either way. Only throw when stdout
// is empty (schema error / binary missing / cargo failure).
// =============================================================================

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { platform } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CRATE_DIR = join(__dirname, '..', 'engram-aql');
const MANIFEST_PATH = join(CRATE_DIR, 'Cargo.toml');
const BINARY_NAME = platform() === 'win32' ? 'engram-aql.exe' : 'engram-aql';
const BINARY_PATH = join(CRATE_DIR, 'target', 'debug', BINARY_NAME);

/** Mirrors the Rust `QueryResult` struct. Fields with `#[serde(skip_serializing_if)]` are optional here. */
export interface AqlResult {
  success: boolean;
  statement: string;
  data: Array<Record<string, unknown>>;
  count: number;
  timing_ms: number;
  error?: string;
  warnings?: string[];
  links?: Array<{
    source_id: string;
    target_id: string;
    link_type: string;
    confidence: number;
  }>;
  pipeline_stages?: number;
}

let binaryReady = false;

/**
 * Ensure the engram-aql binary is built. Runs `cargo build --bin engram-aql`
 * on first call if the binary is missing. Subsequent calls are no-ops. Throws
 * if the build fails or cargo is unavailable.
 */
export function ensureAqlBinary(): string {
  if (binaryReady && existsSync(BINARY_PATH)) return BINARY_PATH;

  if (!existsSync(BINARY_PATH)) {
    const build = spawnSync(
      'cargo',
      ['build', '--bin', 'engram-aql', '--manifest-path', MANIFEST_PATH],
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    if (build.error) {
      throw new Error(
        `cargo not available — cannot build engram-aql for subprocess tests: ${build.error.message}`,
      );
    }
    if (build.status !== 0) {
      throw new Error(
        `cargo build failed (exit ${build.status}):\n${build.stderr}`,
      );
    }
    if (!existsSync(BINARY_PATH)) {
      throw new Error(
        `cargo build succeeded but binary not found at ${BINARY_PATH}`,
      );
    }
  }

  binaryReady = true;
  return BINARY_PATH;
}

/**
 * Run a single AQL query against a .engram file via the `engram-aql query`
 * subcommand. Returns the parsed QueryResult. Does NOT throw on query-level
 * errors (success=false with an error message) — those are returned for the
 * caller to inspect. Throws only on infrastructure failures (missing binary,
 * empty stdout, invalid JSON).
 */
export function aqlQuery(dbPath: string, query: string): AqlResult {
  const binary = ensureAqlBinary();
  const result = spawnSync(binary, ['query', dbPath, query], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  if (!result.stdout || result.stdout.trim() === '') {
    throw new Error(
      `engram-aql produced no stdout (exit ${result.status}). stderr:\n${result.stderr}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as AqlResult;
  } catch (parseErr) {
    throw new Error(
      `engram-aql produced non-JSON stdout (exit ${result.status}):\n${result.stdout}\nstderr:\n${result.stderr}\nparse error: ${parseErr}`,
    );
  }
}

/** Extract the `id` field from every row in an AqlResult, sorted for set comparison. */
export function aqlChunkIds(result: AqlResult): string[] {
  return result.data
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string')
    .sort();
}
