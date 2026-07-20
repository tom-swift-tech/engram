// =============================================================================
// insight-shared.ts — helpers shared between reflect.ts (opinions/
// observations) and suggest.ts (procedural suggestions, issue #39).
//
// Pure move from reflect.ts (issue #39 Slice 1): zero behavior change. Every
// pre-existing reflect test passes unedited against this extraction — that is
// the proof of purity.
// =============================================================================

import type Database from 'better-sqlite3';

/**
 * Strip delimiter-token impersonations from text interpolated into an LLM
 * prompt, so untrusted content can't close a block early and smuggle
 * instructions outside it. In-band labeling is a prompt-injection
 * MITIGATION, not a guarantee.
 */
export function stripPromptMarkers(text: string): string {
  return text.replace(/<\/?(untrusted_data|operator_config)>/gi, '');
}

/** Clamp an LLM-stated rationale to a bounded, trimmed string (or null). */
export function clampRationale(rationale: unknown): string | null {
  if (typeof rationale !== 'string') return null;
  const trimmed = rationale.trim();
  return trimmed ? trimmed.slice(0, 1000) : null;
}

/** Normalize text for lexical belief/summary comparison: lowercase, strip punctuation, collapse whitespace. */
export function normalizeBelief(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token-overlap similarity in [0, 1] between two belief/summary strings. */
export function beliefSimilarity(a: string, b: string): number {
  const aNorm = normalizeBelief(a);
  const bNorm = normalizeBelief(b);

  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return 1;

  const aTokens = new Set(aNorm.split(' ').filter(Boolean));
  const bTokens = new Set(bNorm.split(' ').filter(Boolean));
  const intersection = [...aTokens].filter((token) =>
    bTokens.has(token),
  ).length;
  return intersection / Math.max(aTokens.size, bTokens.size, 1);
}

/**
 * Clean raw LLM output into parseable JSON: strip markdown fencing,
 * truncate after the last top-level closing brace (drops trailing
 * commentary), and fix trailing commas — a common LLM mistake. Shared by
 * every JSON-emitting prompt harness (reflect, counter-evidence judge,
 * suggest).
 */
export function cleanLlmJson(raw: string): string {
  let cleaned = raw
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace !== -1 && lastBrace < cleaned.length - 1) {
    cleaned = cleaned.substring(0, lastBrace + 1);
  }

  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  return cleaned;
}

/** Per-gate measurement: required threshold, measured value, pass/fail. */
export interface GateCheck {
  required: number;
  measured: number;
  pass: boolean;
}

/** Aggregate gate evaluation result, shared by opinion and suggestion formation. */
export interface GateEvaluation {
  pass: boolean;
  /** Per-gate measurements, keyed min_evidence_count / min_distinct_days / min_distinct_sources. */
  gates: Record<string, GateCheck>;
  /** Verified evidence ids (exist [+ active, when requireActive]), unioned with any merged prior rejection's. */
  evidenceIds: string[];
}

/** Evidence thresholds shared by OpinionGates (reflect.ts) and SuggestionGates (suggest.ts). */
export interface EvidenceGates {
  minEvidenceCount?: number;
  minDistinctDays?: number;
  minDistinctSources?: number;
}

/**
 * Evaluate evidence gates over the union of a candidate's cited evidence and
 * any prior rejection's. Only chunk ids that actually exist (and, when
 * `requireActive` is set, are active) count — an LLM can cite ids that don't
 * exist; hallucinated evidence must not pass a gate.
 *
 * `requireActive` differs by caller: opinion formation requires active
 * evidence (`true` — byte-identical to the pre-issue-#39 behavior); suggestion
 * formation is existence-only (`false`), because its evidence — corrections,
 * forgotten facts — is inactive by construction.
 */
export function evaluateEvidenceGates(
  db: Database.Database,
  gates: EvidenceGates,
  candidateEvidenceIds: string[],
  priorEvidenceIds: string[],
  options: { requireActive: boolean },
): GateEvaluation {
  const unionIds = [
    ...new Set([...candidateEvidenceIds, ...priorEvidenceIds]),
  ].filter(Boolean);

  let rows: Array<{ id: string; source: string | null; day: string }> = [];
  if (unionIds.length > 0) {
    const placeholders = unionIds.map(() => '?').join(',');
    const activeClause = options.requireActive ? ' AND is_active = TRUE' : '';
    rows = db
      .prepare(
        `SELECT id, source, date(COALESCE(event_time, created_at)) AS day
         FROM chunks
         WHERE id IN (${placeholders})${activeClause}`,
      )
      .all(...unionIds) as typeof rows;
  }

  const evidenceIds = rows.map((r) => r.id);
  const distinctDays = new Set(rows.map((r) => r.day)).size;
  // NULL sources collectively bucket as one "(none)" source.
  const distinctSources = new Set(rows.map((r) => r.source ?? '(none)')).size;

  const checks: Record<string, GateCheck> = {};
  if (gates.minEvidenceCount !== undefined) {
    checks['min_evidence_count'] = {
      required: gates.minEvidenceCount,
      measured: evidenceIds.length,
      pass: evidenceIds.length >= gates.minEvidenceCount,
    };
  }
  if (gates.minDistinctDays !== undefined) {
    checks['min_distinct_days'] = {
      required: gates.minDistinctDays,
      measured: distinctDays,
      pass: distinctDays >= gates.minDistinctDays,
    };
  }
  if (gates.minDistinctSources !== undefined) {
    checks['min_distinct_sources'] = {
      required: gates.minDistinctSources,
      measured: distinctSources,
      pass: distinctSources >= gates.minDistinctSources,
    };
  }

  return {
    pass: Object.values(checks).every((c) => c.pass),
    gates: checks,
    evidenceIds,
  };
}
