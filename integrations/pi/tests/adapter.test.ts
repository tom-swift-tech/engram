// =============================================================================
// adapter.test.ts — pure adapter tests against a real in-memory Engram.
// No Pi mocking; the adapter knows nothing about Pi types.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { Engram, type EmbeddingProvider } from 'engram';

import {
  remember,
  recall,
  memoryStats,
  findToForget,
  forgetById,
  looksLikeChunkId,
} from '../src/adapter.js';

// Deterministic embedder (no Ollama, no model download).
class TestEmbedder implements EmbeddingProvider {
  readonly dimensions = 8;
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i < text.length; i++) {
      v[i % this.dimensions] += text.charCodeAt(i) / 256;
    }
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return mag > 0 ? new Float32Array(v.map((x) => x / mag)) : v;
  }
}

function tmpDbPath(): string {
  return join(tmpdir(), `engram-pi-test-${randomUUID()}.engram`);
}

function cleanup(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // ignore
    }
  }
}

describe('Pi adapter', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new TestEmbedder() });
  });

  afterEach(() => {
    engram.close();
    cleanup(dbPath);
  });

  describe('remember', () => {
    it('stores user-stated text with high trust', async () => {
      const result = await remember(engram, {
        text: 'Tom uses Terraform with the bpg provider',
      });
      expect(result.chunkId).toMatch(/^chk-/);
    });

    it('marks LLM-generated facts with lower trust and agent_generated source', async () => {
      const result = await remember(engram, {
        text: 'Inferred preference for SQLite over Postgres',
        fromLLM: true,
      });
      // Adapter doesn't expose source_type directly; verify via recall metadata
      const back = await recall(engram, {
        query: 'Inferred preference for SQLite',
      });
      const found = back.results.find((r) => r.id === result.chunkId);
      expect(found).toBeDefined();
      expect(found!.trustScore).toBeCloseTo(0.6, 1);
    });

    it('honors explicit trustScore and context overrides', async () => {
      const result = await remember(engram, {
        text: 'Migration deadline is 2026-06-01',
        context: 'project:migration',
        trustScore: 0.95,
      });
      const back = await recall(engram, { query: 'migration deadline' });
      const found = back.results.find((r) => r.id === result.chunkId);
      expect(found?.trustScore).toBeCloseTo(0.95, 2);
    });
  });

  describe('recall', () => {
    it('finds previously stored facts', async () => {
      await remember(engram, { text: 'API gateway runs on port 8443' });
      const response = await recall(engram, { query: 'API gateway port' });
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results[0].text).toContain('API gateway');
    });

    it('respects topK', async () => {
      for (let i = 0; i < 5; i++) {
        await remember(engram, { text: `fact number ${i} about deployment` });
      }
      const response = await recall(engram, {
        query: 'deployment',
        topK: 2,
      });
      expect(response.results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('memoryStats', () => {
    it('counts active chunks and reports empty queue on a fresh DB', async () => {
      const before = memoryStats(engram);
      expect(before.chunks).toBe(0);
      expect(before.extractionQueue.pending).toBe(0);

      await remember(engram, { text: 'first fact' });
      await remember(engram, { text: 'second fact' });

      const after = memoryStats(engram);
      expect(after.chunks).toBe(2);
      // Each retain queues an extraction
      expect(after.extractionQueue.pending).toBe(2);
    });
  });

  describe('looksLikeChunkId', () => {
    it('recognizes chk- prefixed ids', () => {
      expect(looksLikeChunkId('chk-abc123')).toBe(true);
      expect(looksLikeChunkId('  chk-with-leading-space')).toBe(true);
    });

    it('rejects free-form queries', () => {
      expect(looksLikeChunkId('what did I learn last week')).toBe(false);
      expect(looksLikeChunkId('chunk-foo')).toBe(false);
      expect(looksLikeChunkId('')).toBe(false);
    });
  });

  describe('findToForget + forgetById', () => {
    it('returns the top-1 candidate for a query, then forgets it on confirmation', async () => {
      const stored = await remember(engram, {
        text: 'temporary note about the staging environment',
      });
      await remember(engram, {
        text: 'unrelated fact about user preferences',
      });

      const candidate = await findToForget(engram, 'staging environment');
      expect(candidate).not.toBeNull();
      expect(candidate!.chunkId).toBe(stored.chunkId);

      const ok = await forgetById(engram, candidate!.chunkId);
      expect(ok).toBe(true);

      // After forget, recall should not return it
      const after = await recall(engram, { query: 'staging environment' });
      expect(after.results.find((r) => r.id === stored.chunkId)).toBeUndefined();
    });

    it('returns null when nothing matches', async () => {
      const candidate = await findToForget(engram, 'unicorns and rainbows');
      expect(candidate).toBeNull();
    });

    it('forgetById returns false for unknown ids', async () => {
      const ok = await forgetById(engram, 'chk-does-not-exist');
      expect(ok).toBe(false);
    });
  });
});
