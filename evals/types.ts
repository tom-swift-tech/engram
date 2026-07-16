/**
 * Shared types for the retrieval-quality eval harness (T3/T4,
 * tasks/sprint-hermes-observability.md). Deliberately independent of
 * src/recall.ts's option types — a fixture/scenario describes labeled data,
 * not a live RecallOptions object, though a scenario may pass a subset of
 * RecallOptions through to override the family default.
 */

import type { RecallOptions } from '../src/recall.js';

export type MemoryType = 'world' | 'experience' | 'observation' | 'opinion';
export type SourceType =
  | 'user_stated'
  | 'inferred'
  | 'external_doc'
  | 'tool_result'
  | 'agent_generated';

/** One row of a fixture corpus, retained in array order via Engram.retain(). */
export interface FixtureEntry {
  /** Stable label used only inside the harness — never written to the DB
   *  (it is stashed in `source` for debugging), used to cross-reference
   *  scenario `relevantIds`/`supersedes`/`targetId` back to a real chunk id
   *  once retained. */
  id: string;
  text: string;
  memoryType: MemoryType;
  sourceType: SourceType;
  trustScore: number;
  /**
   * Age in days to backdate `chunks.created_at` to (relative to when the
   * harness runs, via direct SQL after retain — see backdateChunk() in
   * fixture-builder.ts). A fixed ISO date would go stale the day after
   * authoring; expressing age relatively keeps the fixture evergreen.
   * Omitted = now (age 0).
   */
  daysAgo?: number;
  source?: string;
  context?: string;
  /** Fixture id of an earlier entry this one supersedes (Engram.supersede()
   *  semantics — the old chunk is marked is_active = FALSE). Must reference
   *  an id retained earlier in the same fixture array. */
  supersedes?: string;
}

/** One labeled query against a fixture corpus. */
export interface ScenarioQuery {
  query: string;
  /** Fixture ids considered relevant/correct for this query. */
  relevantIds: string[];
  /**
   * Fixture id of a "wrong answer" this query is specifically designed to
   * out-rank (a stale/superseded/noise chunk) — used for the contradiction
   * and contamination families to report distractor rank alongside the
   * generic P@5/R@5/MRR numbers. Optional; ignored by the relevance family.
   */
  distractorId?: string;
  /** True when the distractor is expected to be structurally excluded from
   *  recall (a superseded chunk, is_active = FALSE) rather than merely
   *  out-ranked (a still-active conflicting or noise chunk). */
  distractorExcluded?: boolean;
  /** Per-query RecallOptions overrides layered on top of the family default. */
  recallOptions?: Partial<RecallOptions>;
}

export interface ScenarioFile {
  name: string;
  description: string;
  queries: ScenarioQuery[];
}

/** A staleness probe: the same fact retained at several backdated ages;
 *  targetId is the freshest variant, expected to win as decay increases. */
export interface StalenessProbe {
  query: string;
  targetId: string;
  ageVariantIds: string[];
}

export interface StalenessScenarioFile {
  name: string;
  description: string;
  decayHalfLifeDaysToTest: number[];
  probes: StalenessProbe[];
}
