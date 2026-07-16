/**
 * Deterministic fixture builder: seeds a temp .engram file from a labeled
 * FixtureEntry[] corpus via the real Engram.retain() (real local embeddings,
 * no mocking — this harness measures the actual recall pipeline, not a
 * stand-in). `createdAt` is backdated afterward via a direct SQL UPDATE, the
 * same technique tests/recall.test.ts uses for its decay tests: a short-lived
 * second better-sqlite3 connection to the same file (WAL mode makes this
 * safe — Engram.open() already sets journal_mode = WAL / busy_timeout).
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engram } from '../src/engram.js';
import type { FixtureEntry } from './types.js';

export interface BuiltFixture {
  engram: Engram;
  dbPath: string;
  tmpDir: string;
  /** Fixture entry id -> real chunk id assigned by retain(). */
  idMap: Map<string, string>;
}

/** Retain every entry in array order (so `supersedes` can reference an id
 *  retained earlier), backdating created_at where requested. */
export async function buildFixture(
  family: string,
  entries: FixtureEntry[],
): Promise<BuiltFixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'engram-eval-'));
  const dbPath = join(tmpDir, 'fixture.engram');
  // No reflectModel/generator — the harness is embedding-only, no Ollama.
  const engram = await Engram.create(dbPath, {});

  const idMap = new Map<string, string>();

  for (const entry of entries) {
    let supersedesChunkId: string | undefined;
    if (entry.supersedes) {
      supersedesChunkId = idMap.get(entry.supersedes);
      if (!supersedesChunkId) {
        throw new Error(
          `Fixture "${family}": entry "${entry.id}" supersedes unknown id ` +
            `"${entry.supersedes}" (it must appear earlier in the array).`,
        );
      }
    }

    const retainOptions = {
      memoryType: entry.memoryType,
      sourceType: entry.sourceType,
      trustScore: entry.trustScore,
      source: entry.source ?? `eval:${family}:${entry.id}`,
      context: entry.context,
      // 'none' — every fixture entry is a deliberate, distinct row; default
      // dedup (normalized) would collapse the intentional near-duplicates
      // the staleness/contradiction fixtures rely on.
      dedupMode: 'none' as const,
    };
    // Route through Engram.supersede() (not a raw `supersedes` option) for
    // entries that mark an earlier one stale — exercises the same API path
    // an agent's correction loop would use.
    const result = supersedesChunkId
      ? await engram.supersede(supersedesChunkId, entry.text, retainOptions)
      : await engram.retain(entry.text, retainOptions);
    idMap.set(entry.id, result.chunkId);

    if (entry.daysAgo) {
      backdateChunk(dbPath, result.chunkId, daysAgo(entry.daysAgo));
    }
  }

  return { engram, dbPath, tmpDir, idMap };
}

function backdateChunk(
  dbPath: string,
  chunkId: string,
  createdAt: string,
): void {
  const raw = new Database(dbPath);
  raw
    .prepare(`UPDATE chunks SET created_at = ? WHERE id = ?`)
    .run(createdAt, chunkId);
  raw.close();
}

export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

export function cleanupFixture(built: BuiltFixture): void {
  built.engram.close();
  rmSync(built.tmpDir, { recursive: true, force: true });
}
