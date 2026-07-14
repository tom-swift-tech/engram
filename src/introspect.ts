// =============================================================================
// introspect.ts — structured read primitive for held state (opinions + observations)
//
// PROJECTION ONLY. No LLM call, no embedding, no new state, no schema change.
// Every field is a direct projection of an existing opinions/observations
// column, or a trivial derivation of one (a JSON-array length). Field names
// track the schema vocabulary — `confidence` (not "strength"), and
// `lastChallenged` is included alongside `lastReinforced` — camelCased for the
// TS public API, the same convention as RetainOptions / RecallOptions.
//
// Why this is separate from recall():
//   recall() answers "what chunks are relevant to this query" — RRF-ranked,
//   query-keyed, and (for opinions) gated at confidence >= 0.5 and stripped to
//   {belief, confidence, domain}.
//   introspect() answers "what do I currently believe about this subject, how
//   strongly, and on what evidence" — a direct lookup with NO confidence floor
//   and the full evidence + lifecycle shape. A weakly-held or freshly-challenged
//   opinion (invisible to recall) is exactly what introspect must surface.
//
// Subject matching is lexical Tier-0 (OR-match across belief/domain, summary/
// topic) — deliberately naive and forgiving: for introspection it is safer to
// over-return a possibly-related belief than to hide one. Precise semantic
// subject matching is deferred together with the consistency check.
//
// CONSISTENCY CHECK IS DEFERRED (by explicit team decision). Judging whether a
// candidate statement AGREES WITH or CONTRADICTS a held belief (entailment/NLI)
// is a separate primitive with its own cost/latency/model-role design decision.
// introspect() REPORTS held state; it does not adjudicate truth. The evidence
// shape below is the stable read contract any future mutation primitive must
// maintain (support/challenge provenance + lifecycle timestamps).
// =============================================================================

import type Database from 'better-sqlite3';

/** A held belief, projected in full from the `opinions` table. */
export interface OpinionView {
  id: string;
  belief: string;
  /** opinions.confidence (0.0–1.0). The strength of the belief. */
  confidence: number;
  domain: string | null;
  /** Derived: length of supportingChunks. */
  supportCount: number;
  /** Derived: length of contradictingChunks. */
  challengeCount: number;
  /** opinions.evidence_count */
  evidenceCount: number;
  /** Provenance: chunk IDs supporting the belief (→ chunks.source_type/trust_score). */
  supportingChunks: string[];
  /** Provenance: chunk IDs contradicting the belief. */
  contradictingChunks: string[];
  relatedEntities: string[];
  /** opinions.formed_at */
  formedAt: string;
  /** opinions.last_reinforced */
  lastReinforced: string | null;
  /** opinions.last_challenged */
  lastChallenged: string | null;
  /** opinions.updated_at */
  updatedAt: string;
}

/** A synthesized observation, projected in full from the `observations` table. */
export interface ObservationView {
  id: string;
  summary: string;
  domain: string | null;
  topic: string | null;
  /** Provenance: chunk IDs that informed this observation. */
  sourceChunks: string[];
  sourceEntities: string[];
  /** observations.synthesized_at */
  synthesizedAt: string;
  /** observations.last_refreshed */
  lastRefreshed: string | null;
  /** observations.refresh_count */
  refreshCount: number;
}

export interface IntrospectOptions {
  /** Include opinions in the result. Default true. */
  includeOpinions?: boolean;
  /** Include observations in the result. Default true. */
  includeObservations?: boolean;
  /**
   * Optional confidence floor for opinions (0.0–1.0). Default 0 — NO floor.
   * The absence of a floor is the point of introspect vs. recall: a
   * weakly-held or freshly-challenged belief must remain visible.
   */
  minConfidence?: number;
  /** Max opinions and observations returned, each. Default 20. */
  limit?: number;
}

export interface IntrospectResult {
  /** The subject queried, or null when introspecting top held state overall. */
  subject: string | null;
  opinions: OpinionView[];
  observations: ObservationView[];
}

const DEFAULT_LIMIT = 20;

/** Parse a JSON-array text column into a string[], tolerating null/garbage. */
function parseIdArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Tokenize a subject into lexical match terms. Naive by design (see file
 * header): split on non-alphanumerics, drop 1-char noise, de-duplicate.
 * Returns [] for an absent/empty subject → "top held state overall".
 */
function subjectTerms(subject: string | undefined): string[] {
  if (!subject) return [];
  const terms = subject
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2);
  return [...new Set(terms)];
}

type OpinionRow = {
  id: string;
  belief: string;
  confidence: number;
  domain: string | null;
  supporting_chunks: string | null;
  contradicting_chunks: string | null;
  evidence_count: number | null;
  related_entities: string | null;
  formed_at: string;
  last_reinforced: string | null;
  last_challenged: string | null;
  updated_at: string;
};

type ObservationRow = {
  id: string;
  summary: string;
  domain: string | null;
  topic: string | null;
  source_chunks: string | null;
  source_entities: string | null;
  synthesized_at: string;
  last_refreshed: string | null;
  refresh_count: number | null;
};

function selectOpinions(
  db: Database.Database,
  terms: string[],
  minConfidence: number,
  limit: number,
): OpinionView[] {
  // Lexical OR-match: any term appearing in belief or domain qualifies.
  // Parameterized (no interpolation) — each term contributes two placeholders.
  const params: unknown[] = [minConfidence];
  let termClause = '';
  if (terms.length > 0) {
    const groups = terms.map(() => '(belief LIKE ? OR domain LIKE ?)');
    termClause = ` AND (${groups.join(' OR ')})`;
    for (const t of terms) {
      params.push(`%${t}%`, `%${t}%`);
    }
  }
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT id, belief, confidence, domain, supporting_chunks,
              contradicting_chunks, evidence_count, related_entities,
              formed_at, last_reinforced, last_challenged, updated_at
         FROM opinions
        WHERE is_active = TRUE
          AND confidence >= ?${termClause}
        ORDER BY confidence DESC, formed_at DESC
        LIMIT ?`,
    )
    .all(...params) as OpinionRow[];

  return rows.map((r) => {
    const supportingChunks = parseIdArray(r.supporting_chunks);
    const contradictingChunks = parseIdArray(r.contradicting_chunks);
    return {
      id: r.id,
      belief: r.belief,
      confidence: r.confidence,
      domain: r.domain,
      supportCount: supportingChunks.length,
      challengeCount: contradictingChunks.length,
      evidenceCount: r.evidence_count ?? 0,
      supportingChunks,
      contradictingChunks,
      relatedEntities: parseIdArray(r.related_entities),
      formedAt: r.formed_at,
      lastReinforced: r.last_reinforced,
      lastChallenged: r.last_challenged,
      updatedAt: r.updated_at,
    };
  });
}

function selectObservations(
  db: Database.Database,
  terms: string[],
  limit: number,
): ObservationView[] {
  const params: unknown[] = [];
  let termClause = '';
  if (terms.length > 0) {
    const groups = terms.map(
      () => '(summary LIKE ? OR domain LIKE ? OR topic LIKE ?)',
    );
    termClause = ` AND (${groups.join(' OR ')})`;
    for (const t of terms) {
      params.push(`%${t}%`, `%${t}%`, `%${t}%`);
    }
  }
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT id, summary, domain, topic, source_chunks, source_entities,
              synthesized_at, last_refreshed, refresh_count
         FROM observations
        WHERE is_active = TRUE${termClause}
        ORDER BY COALESCE(last_refreshed, synthesized_at) DESC
        LIMIT ?`,
    )
    .all(...params) as ObservationRow[];

  return rows.map((r) => ({
    id: r.id,
    summary: r.summary,
    domain: r.domain,
    topic: r.topic,
    sourceChunks: parseIdArray(r.source_chunks),
    sourceEntities: parseIdArray(r.source_entities),
    synthesizedAt: r.synthesized_at,
    lastRefreshed: r.last_refreshed,
    refreshCount: r.refresh_count ?? 0,
  }));
}

/**
 * Introspect held state about a subject: current opinions (with full evidence
 * and lifecycle) and synthesized observations. Pure read — no LLM, no embedding.
 *
 * @param subject — lexical subject to introspect; omit for top held state overall.
 */
export function introspect(
  db: Database.Database,
  subject?: string,
  options?: IntrospectOptions,
): IntrospectResult {
  const includeOpinions = options?.includeOpinions !== false;
  const includeObservations = options?.includeObservations !== false;
  const minConfidence =
    typeof options?.minConfidence === 'number'
      ? Math.max(0, Math.min(1, options.minConfidence))
      : 0;
  const limit =
    typeof options?.limit === 'number' && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_LIMIT;

  const terms = subjectTerms(subject);
  const normalizedSubject = subject && subject.trim() !== '' ? subject : null;

  return {
    subject: normalizedSubject,
    opinions: includeOpinions
      ? selectOpinions(db, terms, minConfidence, limit)
      : [],
    observations: includeObservations
      ? selectObservations(db, terms, limit)
      : [],
  };
}
