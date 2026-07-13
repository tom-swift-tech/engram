// =============================================================================
// model-resolver.ts — the ONE place a generation model name is chosen
//
// Background: a hardcoded `llama3.1:8b` default was scattered across the
// library and its entrypoints. When a caller left the model unset, the library
// silently substituted that default. If the default was not served on the
// configured host, generation 404'd downstream — decoupled in time and place
// from the misconfiguration. That failure was invisible for days and produced
// thousands of failed extractions.
//
// This module removes the class of bug. It is the single reader of model
// configuration. It applies NO silent default: an unconfigured role either
// throws (`resolveModelSpec`) or returns null (`resolveModelSpecOrNull`), and
// the returned spec can be preflighted against the host BEFORE any pipeline
// commits to it (`preflightModel`). "Fail loud, never silent" — the same
// principle the reflect path already applies to parse failures (issue #17).
// =============================================================================

import { DEFAULT_OLLAMA_URL } from './generation.js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Generation roles that actually exist in this library.
 *
 * NOTE: `recall` is deliberately absent — recall ranks via the embedder, not
 * the LLM generator, so there is no recall generation model. `extract` and
 * `reflect` share a single generator on an Engram instance; the roles are
 * distinct at the *config* layer (a deployment may point them at different
 * hosts/models) even though the core wires one generator. `integration` is the
 * in-repo Pi adapter's background consolidation.
 */
export type ModelRole = 'reflect' | 'extract' | 'integration';

/** A fully-resolved generation target. Never a bare string. */
export interface ModelSpec {
  /** Ollama-compatible base URL, e.g. http://localhost:11434 */
  host: string;
  /** Model name, e.g. "llama3.1:8b". Guaranteed non-empty. */
  model: string;
  /**
   * True when the model leaves the local host — a `:cloud` suffix, or a host
   * that is not loopback/private. Surfaced in log lines so a config that ships
   * memory content off-box is never silent.
   */
  isRemote: boolean;
}

export interface ResolveModelInput {
  role: ModelRole;
  /** Environment to read from (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Explicit model from a CLI flag / option — highest precedence when set. */
  explicitModel?: string;
  /** Explicit host from a CLI flag / option — highest precedence when set. */
  explicitHost?: string;
}

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

function roleEnvKey(role: ModelRole): string {
  return `ENGRAM_${role.toUpperCase()}_MODEL`;
}

function nonEmpty(v: string | undefined | null): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/**
 * Resolve the host for a role. A host default (localhost) is retained on
 * purpose: an unset *host* is not the dangerous case — an unset *model* is,
 * and preflight validates host reachability regardless. Precedence:
 * explicit > ENGRAM_<ROLE>_HOST > ENGRAM_OLLAMA_URL > OLLAMA_URL > default.
 */
function resolveHost(input: ResolveModelInput): string {
  const env = input.env ?? process.env;
  return (
    nonEmpty(input.explicitHost) ??
    nonEmpty(env[`ENGRAM_${input.role.toUpperCase()}_HOST`]) ??
    nonEmpty(env.ENGRAM_OLLAMA_URL) ??
    nonEmpty(env.OLLAMA_URL) ??
    DEFAULT_OLLAMA_URL
  );
}

/**
 * Resolve the model name for a role from config. NO default is applied.
 * Precedence: explicit flag/option > ENGRAM_<ROLE>_MODEL > ENGRAM_MODEL.
 * Returns undefined when nothing is configured — callers decide throw vs null.
 */
function resolveModelName(input: ResolveModelInput): string | undefined {
  const env = input.env ?? process.env;
  return (
    nonEmpty(input.explicitModel) ??
    nonEmpty(env[roleEnvKey(input.role)]) ??
    nonEmpty(env.ENGRAM_MODEL)
  );
}

const LOCAL_HOST_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|(?:10|127)\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?\/?$/i;

/** A model or host is "remote" if it carries a :cloud tag or leaves the LAN. */
function computeIsRemote(host: string, model: string): boolean {
  if (model.endsWith(':cloud')) return true;
  return !LOCAL_HOST_RE.test(host.trim());
}

/**
 * Resolve a `{ host, model }` spec for a role, or throw if the model is
 * unconfigured. This is the throwing form — use it at generation entrypoints
 * where an unset model must halt the run at startup, not 404 mid-cron.
 */
export function resolveModelSpec(input: ResolveModelInput): ModelSpec {
  const model = resolveModelName(input);
  if (!model) {
    const key = roleEnvKey(input.role);
    throw new Error(
      `No generation model configured for role "${input.role}". ` +
        `Set ${key} or ENGRAM_MODEL (or pass an explicit model), ` +
        `then ensure it is served on the target host. ` +
        `The library applies no default model — an unset model is a hard error, ` +
        `never a silent fallback.`,
    );
  }
  const host = resolveHost(input);
  return { host, model, isRemote: computeIsRemote(host, model) };
}

/**
 * Resolve a spec, or return null when no model is configured. Use this where a
 * model is optional (e.g. building EngramOptions for a process that may only
 * retain/recall) — a null result flows to `UnconfiguredGeneration`, which is
 * still loud on first generation use, never a silent default.
 */
export function resolveModelSpecOrNull(
  input: ResolveModelInput,
): ModelSpec | null {
  return resolveModelName(input) ? resolveModelSpec(input) : null;
}

// -----------------------------------------------------------------------------
// Preflight
// -----------------------------------------------------------------------------

export interface PreflightResult {
  ok: boolean;
  host: string;
  model: string;
  isRemote: boolean;
  /** Models the host reports serving (present when reachable). */
  servedModels?: string[];
  /** Human-readable failure reason (present when !ok). */
  error?: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

/**
 * Does the served-model list satisfy the configured model name?
 *
 * DESIGN NOTE (a genuine judgment call — adjust to your hosts if needed):
 * Ollama's /api/tags reports fully-qualified names ("llama3.1:8b"). A model
 * configured without a tag ("llama3.1") is served as ":latest", so we accept an
 * exact match OR "<model>:latest" when the config omits a tag. `:cloud` models
 * are routed to Ollama's cloud and may NOT appear in a local host's tag list —
 * we still require a match here (a missing :cloud model is a real
 * misconfiguration on a local host) but the failure line flags it as remote so
 * the operator can tell a routing gap from a missing pull.
 */
export function isModelServed(model: string, served: string[]): boolean {
  if (served.includes(model)) return true;
  if (!model.includes(':')) return served.includes(`${model}:latest`);
  return false;
}

/**
 * Confirm a resolved spec is actually runnable: the host is reachable AND the
 * model is served. Returns a structured result — the caller logs and decides
 * exit/skip. Never throws for an unreachable host or missing model (those are
 * expected outcomes carried in the result); only a programming error would
 * throw.
 */
export async function preflightModel(
  spec: ModelSpec,
  deps?: { fetch?: typeof globalThis.fetch },
): Promise<PreflightResult> {
  const doFetch = deps?.fetch ?? globalThis.fetch;
  const base: Omit<PreflightResult, 'ok'> = {
    host: spec.host,
    model: spec.model,
    isRemote: spec.isRemote,
  };

  let res: Response;
  try {
    res = await doFetch(`${spec.host}/api/tags`, { method: 'GET' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      ok: false,
      error: `host unreachable at ${spec.host}/api/tags (${reason})`,
    };
  }

  if (!res.ok) {
    return {
      ...base,
      ok: false,
      error: `host returned ${res.status} from ${spec.host}/api/tags`,
    };
  }

  const data = (await res.json()) as OllamaTagsResponse;
  const served = (data.models ?? [])
    .map((m) => m.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);

  if (!isModelServed(spec.model, served)) {
    return {
      ...base,
      ok: false,
      servedModels: served,
      error: `model "${spec.model}" is not served by ${spec.host}`,
    };
  }

  return { ...base, ok: true, servedModels: served };
}

/** One-line, log-ready description of a preflight failure. Flags remote models. */
export function formatPreflightFailure(r: PreflightResult): string {
  const remoteTag = r.isRemote ? ' [remote/:cloud — leaves this host]' : '';
  const head = `Model preflight FAILED for "${r.model}" @ ${r.host}${remoteTag}: ${r.error}`;
  if (r.servedModels) {
    const list = r.servedModels.length
      ? r.servedModels.join(', ')
      : '(none served)';
    return `${head}\n  Host serves: ${list}`;
  }
  return head;
}
