/**
 * Retrieval-quality eval harness entry point (T3/T4,
 * tasks/sprint-hermes-observability.md). Embedding-only: exercises
 * Engram.retain()/recall() with the real local embedder, no Ollama, no
 * reflect/extract. Report-only — no thresholds, no non-zero exit on a
 * "bad" score; this is a baseline measurement tool, not a CI gate.
 *
 * Run: npm run eval  (== tsx evals/run.ts)
 * Output: evals/results.json (machine) + a markdown table per family (stdout).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecallOptions } from '../src/recall.js';
import {
  buildFixture,
  cleanupFixture,
  type BuiltFixture,
} from './fixture-builder.js';
import {
  mean,
  precisionAtK,
  rankOf,
  recallAtK,
  reciprocalRank,
  round,
} from './metrics.js';
import type {
  FixtureEntry,
  ScenarioFile,
  ScenarioQuery,
  StalenessScenarioFile,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const K = 5;

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(__dirname, relativePath), 'utf8')) as T;
}

// ---------------------------------------------------------------------------
// Generic family runner (relevance, contradiction, contamination): retain a
// fixture, run every labeled query, score against relevantIds.
// ---------------------------------------------------------------------------

interface QueryResult {
  query: string;
  precisionAt5: number;
  recallAt5: number;
  reciprocalRank: number;
  distractorId?: string;
  distractorRank: number | null;
  distractorExcluded?: boolean;
  distractorExcludedAsExpected?: boolean;
  noiseInTop5?: number;
}

interface FamilyReport {
  name: string;
  description: string;
  queries: QueryResult[];
  aggregate: {
    precisionAt5: number;
    recallAt5: number;
    mrr: number;
    avgNoiseInTop5?: number;
  };
}

async function runGenericFamily(
  familyName: string,
  fixtureEntries: FixtureEntry[],
  scenario: ScenarioFile,
  // Every family but staleness pins decayHalfLifeDays: 0 — none of them are
  // *about* decay, and scores would otherwise drift with wall-clock time.
  recallOptions: RecallOptions = { topK: 10, decayHalfLifeDays: 0 },
): Promise<FamilyReport> {
  const built = await buildFixture(familyName, fixtureEntries);
  try {
    const results: QueryResult[] = [];
    for (const q of scenario.queries) {
      results.push(
        await runQuery(built, q, recallOptions, familyName === 'contamination'),
      );
    }
    return {
      name: scenario.name,
      description: scenario.description,
      queries: results,
      aggregate: {
        precisionAt5: round(mean(results.map((r) => r.precisionAt5))),
        recallAt5: round(mean(results.map((r) => r.recallAt5))),
        mrr: round(mean(results.map((r) => r.reciprocalRank))),
        ...(familyName === 'contamination'
          ? {
              avgNoiseInTop5: round(
                mean(results.map((r) => r.noiseInTop5 ?? 0)),
              ),
            }
          : {}),
      },
    };
  } finally {
    cleanupFixture(built);
  }
}

async function runQuery(
  built: BuiltFixture,
  q: ScenarioQuery,
  baseOptions: RecallOptions,
  trackNoise: boolean,
): Promise<QueryResult> {
  const response = await built.engram.recall(q.query, {
    ...baseOptions,
    ...q.recallOptions,
  });
  const retrieved = response.results.map((r) => r.id);
  const relevant = new Set(
    q.relevantIds
      .map((fid) => built.idMap.get(fid))
      .filter((x): x is string => !!x),
  );

  const distractorChunkId = q.distractorId
    ? built.idMap.get(q.distractorId)
    : undefined;
  const distractorRank = distractorChunkId
    ? rankOf(retrieved, distractorChunkId)
    : null;

  const result: QueryResult = {
    query: q.query,
    precisionAt5: precisionAtK(retrieved, relevant, K),
    recallAt5: recallAtK(retrieved, relevant, K),
    reciprocalRank: reciprocalRank(retrieved, relevant),
    distractorId: q.distractorId,
    distractorRank,
    distractorExcluded: q.distractorExcluded,
    distractorExcludedAsExpected:
      q.distractorExcluded === undefined
        ? undefined
        : q.distractorExcluded
          ? distractorRank === null
          : distractorRank !== null,
  };

  if (trackNoise) {
    const reverseId = new Map<string, string>();
    for (const [fid, cid] of built.idMap) reverseId.set(cid, fid);
    result.noiseInTop5 = retrieved
      .slice(0, K)
      .filter((cid) => reverseId.get(cid)?.startsWith('noise-')).length;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Staleness family: one fixture, same query re-run under several
// decayHalfLifeDays values to show the ranking-vs-decay tradeoff side by side.
// ---------------------------------------------------------------------------

interface StalenessProbeResult {
  query: string;
  targetId: string;
  byDecay: Record<
    string,
    {
      targetRank: number | null;
      precisionAt5: number;
      recallAt5: number;
      reciprocalRank: number;
      order: string[];
    }
  >;
}

interface StalenessReport {
  name: string;
  description: string;
  decayHalfLifeDaysToTest: number[];
  probes: StalenessProbeResult[];
}

async function runStalenessFamily(
  fixtureEntries: FixtureEntry[],
  scenario: StalenessScenarioFile,
): Promise<StalenessReport> {
  const built = await buildFixture('staleness', fixtureEntries);
  try {
    const probes: StalenessProbeResult[] = [];
    for (const probe of scenario.probes) {
      const targetChunkId = built.idMap.get(probe.targetId)!;
      const relevant = new Set([targetChunkId]);
      const byDecay: StalenessProbeResult['byDecay'] = {};

      for (const decayHalfLifeDays of scenario.decayHalfLifeDaysToTest) {
        const response = await built.engram.recall(probe.query, {
          topK: 10,
          decayHalfLifeDays,
        });
        const retrieved = response.results.map((r) => r.id);
        const idToLabel = new Map<string, string>();
        for (const [fid, cid] of built.idMap) idToLabel.set(cid, fid);

        byDecay[String(decayHalfLifeDays)] = {
          targetRank: rankOf(retrieved, targetChunkId),
          precisionAt5: precisionAtK(retrieved, relevant, K),
          recallAt5: recallAtK(retrieved, relevant, K),
          reciprocalRank: reciprocalRank(retrieved, relevant),
          order: probe.ageVariantIds
            .map((fid) => built.idMap.get(fid))
            .filter((x): x is string => !!x)
            .map(
              (cid) =>
                `${idToLabel.get(cid)}(rank ${rankOf(retrieved, cid) ?? 'absent'})`,
            ),
        };
      }

      probes.push({ query: probe.query, targetId: probe.targetId, byDecay });
    }

    return {
      name: scenario.name,
      description: scenario.description,
      decayHalfLifeDaysToTest: scenario.decayHalfLifeDaysToTest,
      probes,
    };
  } finally {
    cleanupFixture(built);
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printGenericTable(report: FamilyReport): void {
  console.log(`\n## ${report.name}\n`);
  console.log(report.description + '\n');
  console.log('| query | P@5 | R@5 | RR | distractor rank |');
  console.log('|---|---|---|---|---|');
  for (const q of report.queries) {
    const distractor =
      q.distractorRank === null
        ? q.distractorId
          ? 'excluded'
          : '—'
        : String(q.distractorRank);
    console.log(
      `| ${q.query} | ${q.precisionAt5.toFixed(2)} | ${q.recallAt5.toFixed(2)} | ${q.reciprocalRank.toFixed(2)} | ${distractor} |`,
    );
  }
  console.log(
    `\n**Aggregate:** P@5=${report.aggregate.precisionAt5} R@5=${report.aggregate.recallAt5} MRR=${report.aggregate.mrr}` +
      (report.aggregate.avgNoiseInTop5 !== undefined
        ? ` avgNoiseInTop5=${report.aggregate.avgNoiseInTop5}`
        : ''),
  );
}

function printStalenessTable(report: StalenessReport): void {
  console.log(`\n## ${report.name}\n`);
  console.log(report.description + '\n');
  for (const probe of report.probes) {
    console.log(
      `Query: "${probe.query}" — target (freshest): ${probe.targetId}\n`,
    );
    console.log('| decayHalfLifeDays | target rank | P@5 | R@5 | RR | order |');
    console.log('|---|---|---|---|---|---|');
    for (const decay of report.decayHalfLifeDaysToTest) {
      const r = probe.byDecay[String(decay)];
      console.log(
        `| ${decay} | ${r.targetRank ?? 'absent'} | ${r.precisionAt5.toFixed(2)} | ${r.recallAt5.toFixed(2)} | ${r.reciprocalRank.toFixed(2)} | ${r.order.join(', ')} |`,
      );
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const relevanceFixture = loadJson<FixtureEntry[]>(
    './fixtures/relevance.json',
  );
  const relevanceScenario = loadJson<ScenarioFile>(
    './scenarios/relevance.json',
  );
  const contradictionFixture = loadJson<FixtureEntry[]>(
    './fixtures/contradiction.json',
  );
  const contradictionScenario = loadJson<ScenarioFile>(
    './scenarios/contradiction.json',
  );
  const contaminationFixture = loadJson<FixtureEntry[]>(
    './fixtures/contamination.json',
  );
  const contaminationScenario = loadJson<ScenarioFile>(
    './scenarios/contamination.json',
  );
  const stalenessFixture = loadJson<FixtureEntry[]>(
    './fixtures/staleness.json',
  );
  const stalenessScenario = loadJson<StalenessScenarioFile>(
    './scenarios/staleness.json',
  );

  console.log(
    'Engram retrieval-quality eval harness — building fixtures and running queries...',
  );
  console.log(
    '(first run downloads the local embedding model — same as `npm test`)\n',
  );

  const relevance = await runGenericFamily(
    'relevance',
    relevanceFixture,
    relevanceScenario,
  );
  const contradiction = await runGenericFamily(
    'contradiction',
    contradictionFixture,
    contradictionScenario,
  );
  const contamination = await runGenericFamily(
    'contamination',
    contaminationFixture,
    contaminationScenario,
  );
  const staleness = await runStalenessFamily(
    stalenessFixture,
    stalenessScenario,
  );

  printGenericTable(relevance);
  printGenericTable(contradiction);
  printGenericTable(contamination);
  printStalenessTable(staleness);

  const output = {
    generatedAt: new Date().toISOString(),
    k: K,
    families: { relevance, contradiction, contamination, staleness },
  };
  writeFileSync(
    join(__dirname, 'results.json'),
    JSON.stringify(output, null, 2) + '\n',
  );
  console.log(`\nWrote ${join(__dirname, 'results.json')}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
