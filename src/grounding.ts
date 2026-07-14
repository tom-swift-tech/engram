// =============================================================================
// grounding.ts — Subagent Grounding Layer (Product A)
//
// "Grounding in, report out, nothing written by the subagent."
//
// An orchestrator (any agent holding a read/write Engram) spawns a STATELESS
// subagent, injects scoped situated context at spawn, and receives a plain
// report back. The subagent writes nothing durable — every durable write
// happens on the orchestrator's side, before spawn and after report.
//
// This module is pure composition over existing primitives — it adds NO recall
// scoring path and NO MCP tool. See docs/GROUNDING-LAYER-SPEC.md.
//
//   - groundSubagent()  — the read path: recall() hard-capped to grounding
//     types (world/experience/observation), beliefs structurally excluded.
//   - taskContext()     — deliberate, explicit task-context injection seam.
//   - SubagentReport    — the hand-back shape (a plain object; no db handle).
//   - metabolizeReport() — reference orchestrator-side helper composing
//     commitContext()/retain() on a returned report. The orchestrator is the
//     single writer; candidate experiences land as tier-1 agent_generated.
//
// Belief-free by construction (spec §2): a stateless subagent has no revision
// loop, so it can't tell a sound belief from a stale one. Grounding types carry
// facts and episodes, not adjudicated confidence — safe to inject universally.
// opinion-type memory is dropped even when a caller explicitly asks for it.
// =============================================================================

import { formatForPrompt } from './recall.js';
import type { RecallResult, RecallResponse } from './recall.js';
import type { ReadonlyEngram } from './readonly-engram.js';
import type {
  ContextRef,
  ContextSlice,
  TokenBudget,
  DecisionArtifact,
  TaskScope,
} from './context-store.js';
import type { RetainOptions, RetainResult } from './retain.js';

/** The only memory types a subagent may be grounded from. `opinion` is absent by design. */
export const GROUNDING_TYPES = ['world', 'experience', 'observation'] as const;
export type GroundingType = (typeof GROUNDING_TYPES)[number];

// =============================================================================
// 4.1 — the read path
// =============================================================================

export interface GroundingScope {
  /** Relevance query describing the subagent's task. Drives RRF retrieval. */
  task: string;
  /** Char budget for the injected block. Default 2000 (formatForPrompt default). */
  maxChars?: number;
  /** Durable memory types to ground from. Hard-capped to the grounding set. */
  memoryTypes?: GroundingType[];
  /**
   * Max results pulled before formatting. Minor extension beyond the spec's
   * GroundingScope — harmless, and callers situating a broad task want it.
   * Default 10.
   */
  topK?: number;
}

export interface Grounding {
  /** Ready-to-inject system-prompt block (headered, budgeted). */
  prompt: string;
  /** Structured form, for callers that assemble their own prompt. */
  facts: RecallResult[];
  observations: RecallResponse['observations'];
  /** Provenance: what scope/query produced this, for the report audit trail. */
  meta: { task: string; injectedChars: number };
}

/**
 * Situate a stateless subagent with scoped, belief-free context (spec §4.1).
 *
 * Runs recall() with `memoryTypes` INTERSECTED with the grounding set —
 * `opinion` is dropped even if passed. If the intersection is empty (e.g. a
 * caller asked only for `opinion`), all three grounding types are used: a
 * subagent is always grounded, just never with beliefs. `includeOpinions` is
 * forced false; `includeObservations` follows whether `observation` survives
 * the intersection. Grounds from DURABLE memory only — task context is injected
 * separately and deliberately via taskContext() (spec §8).
 */
export async function groundSubagent(
  engram: ReadonlyEngram,
  scope: GroundingScope,
): Promise<Grounding> {
  const maxChars = scope.maxChars ?? 2000;
  const topK = scope.topK ?? 10;

  // Intersect requested types with the grounding set — the hard belief cap.
  const requested = scope.memoryTypes ?? [...GROUNDING_TYPES];
  const grounded = requested.filter((t) =>
    (GROUNDING_TYPES as readonly string[]).includes(t),
  );
  // Never zero — a caller asking only for opinion still gets grounded (belief-free).
  const memoryTypes: GroundingType[] =
    grounded.length > 0 ? grounded : [...GROUNDING_TYPES];

  const response = await engram.recall(scope.task, {
    memoryTypes,
    includeOpinions: false,
    includeObservations: memoryTypes.includes('observation'),
    scope: ['durable'],
    topK,
  });

  const prompt = formatForPrompt(response, { maxChars });

  return {
    prompt,
    facts: response.results,
    observations: response.observations,
    meta: { task: scope.task, injectedChars: prompt.length },
  };
}

// =============================================================================
// 4.1a — explicit task-context injection (deliberate, orchestrator-controlled)
// =============================================================================

/**
 * Pull the specific parent-task artifacts an orchestrator chooses to show a
 * subagent (spec §4.1a / §8). A thin, named pass-through to queryContext(): its
 * value is being a first-class seam, so "what task-context does this subagent
 * get" stays an explicit orchestrator decision rather than auto-inheritance.
 * The orchestrator reviews the slice and concatenates it into the subagent
 * prompt itself — the subagent never queries the task scope.
 */
export async function taskContext(
  engram: ReadonlyEngram,
  parent: ContextRef,
  relevanceQuery: string,
  budget?: TokenBudget,
): Promise<ContextSlice> {
  return engram.queryContext(parent, relevanceQuery, budget);
}

// =============================================================================
// 4.2 — the hand-back
// =============================================================================

export interface SubagentReport {
  /** The subagent's task output — freeform, consumed by the orchestrator. */
  result: unknown;
  /**
   * Optional structured decision record. Present when the subagent reached a
   * decision worth metabolizing. The orchestrator — not the subagent — decides
   * whether this becomes task-scoped context or durable memory.
   */
  artifact?: DecisionArtifact;
  /**
   * Optional raw experiences the subagent thinks are worth remembering. These
   * are CANDIDATES. The orchestrator reflects on them; it is the single writer.
   */
  candidateExperiences?: Array<{ text: string; context?: string }>;
}

// =============================================================================
// 4.3 — orchestrator-side metabolism (reference helper)
// =============================================================================

/**
 * Minimal write surface metabolizeReport needs from an orchestrator. `Engram`
 * satisfies this structurally — typed here (rather than importing the concrete
 * class) to keep grounding.ts free of a cycle with engram.ts.
 */
export interface OrchestratorWriter {
  commitContext(
    artifact: DecisionArtifact,
    scope?: TaskScope,
  ): Promise<ContextRef>;
  retain(text: string, options?: RetainOptions): Promise<RetainResult>;
}

export interface MetabolizeOptions {
  /** TaskScope for the artifact commit (parent chain, TTL). */
  scope?: TaskScope;
  /**
   * Per-item gate on candidate experiences — the orchestrator's judgment about
   * what's worth retaining. Default: keep all.
   */
  keepExperiences?: (c: { text: string; context?: string }) => boolean;
}

export interface MetabolizeResult {
  /** Ref of the committed artifact, if the report carried one. */
  artifactRef?: ContextRef;
  /** Chunk ids of retained candidate experiences (agent_generated, tier 1). */
  retainedExperienceIds: string[];
}

/**
 * Reference orchestrator-side metabolism of a SubagentReport (spec §4.3). Thin
 * composition — real orchestrators may inline their own policy. Every durable
 * write traces to the orchestrator, not the ephemeral subagent:
 *
 *   - report.artifact → commitContext() (task-scoped, TTL'd). Promotion to
 *     durable is left to the orchestrator later (promoteContext) — not here.
 *   - each surviving candidateExperience → retain() as `experience` /
 *     `agent_generated` / trust 0.6 (tier 1 — cannot outrank user-stated
 *     facts). Reflection metabolizes them into beliefs on the NEXT cycle,
 *     under the orchestrator's identity, with full provenance.
 */
export async function metabolizeReport(
  orchestrator: OrchestratorWriter,
  report: SubagentReport,
  options: MetabolizeOptions = {},
): Promise<MetabolizeResult> {
  const keep = options.keepExperiences ?? (() => true);

  let artifactRef: ContextRef | undefined;
  if (report.artifact) {
    artifactRef = await orchestrator.commitContext(
      report.artifact,
      options.scope,
    );
  }

  const retainedExperienceIds: string[] = [];
  for (const candidate of report.candidateExperiences ?? []) {
    if (!keep(candidate)) continue;
    const result = await orchestrator.retain(candidate.text, {
      memoryType: 'experience',
      sourceType: 'agent_generated',
      trustScore: 0.6,
      context: candidate.context,
    });
    retainedExperienceIds.push(result.chunkId);
  }

  return { artifactRef, retainedExperienceIds };
}
