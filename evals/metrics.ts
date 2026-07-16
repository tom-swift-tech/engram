/**
 * Retrieval-quality metrics: precision@k, recall@k, and (reciprocal rank,
 * which the caller averages across queries into MRR).
 *
 * `retrieved` is the ranked list of chunk ids in the order recall() actually
 * returned them (tier-major, not pure relevance order — see CLAUDE.md's
 * "Consumers must NOT read results[0] as highest-relevance overall" note).
 * That is deliberate: this harness measures what an agent calling recall()
 * actually sees, not an idealized re-sort.
 */

export function precisionAtK(
  retrieved: string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  const topK = retrieved.slice(0, k);
  if (topK.length === 0) return 0;
  const hits = topK.filter((id) => relevant.has(id)).length;
  return hits / topK.length;
}

export function recallAtK(
  retrieved: string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) return 0;
  const topK = retrieved.slice(0, k);
  const hits = topK.filter((id) => relevant.has(id)).length;
  return hits / relevant.size;
}

export function reciprocalRank(
  retrieved: string[],
  relevant: ReadonlySet<string>,
): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

/** 1-based rank of `id` in `retrieved`, or null if absent from the list. */
export function rankOf(retrieved: string[], id: string): number | null {
  const idx = retrieved.indexOf(id);
  return idx === -1 ? null : idx + 1;
}

export function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function round(n: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}
