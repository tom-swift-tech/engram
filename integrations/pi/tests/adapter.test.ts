// =============================================================================
// adapter.test.ts — pure adapter tests against a real in-memory Engram.
// No Pi mocking; the adapter knows nothing about Pi types.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import {
  Engram,
  type EmbeddingProvider,
  type GenerationProvider,
} from 'engram';

import {
  remember,
  recall,
  memoryStats,
  findToForget,
  forgetById,
  looksLikeChunkId,
  resumeSession,
  updateSession,
  snapshotSession,
  consolidationDue,
  planConsolidation,
  runConsolidation,
  isConnectionError,
  DEFAULT_SCHEDULING_CONFIG,
  extractMessageText,
  planAutoRetain,
  autoRetain,
  DEFAULT_AUTO_RETAIN_CONFIG,
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

  describe('resumeSession', () => {
    it('creates a new session on a fresh DB (reason "new", confidence 1.0)', async () => {
      const result = await resumeSession(engram, {
        message: 'help me refactor the auth middleware',
      });
      expect(result.sessionId).toMatch(/^wm-/);
      expect(result.reason).toBe('new');
      expect(result.confidence).toBe(1.0);
      expect(result.goal).toContain('auth middleware');
    });

    it('matches an existing session on a similar follow-up message', async () => {
      const first = await resumeSession(engram, {
        message: 'help me refactor the auth middleware',
      });
      const second = await resumeSession(engram, {
        message: 'help me refactor the auth middleware some more',
      });
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.reason).toBe('match');
      expect(second.confidence).toBeLessThan(1.0);
    });

    it('creates a fresh session for an unrelated topic', async () => {
      const first = await resumeSession(engram, {
        message: 'AAAA plan the deployment to staging',
        threshold: 0.999,
      });
      const second = await resumeSession(engram, {
        message: 'ZZZZ compare the cost of two cloud providers',
        threshold: 0.999,
      });
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(second.reason).toBe('new');
    });

    it('passes maxActive through to inferWorkingSession', async () => {
      // alpha/beta/tau chosen because their pairwise cosines in the 8d
      // TestEmbedder are all well below 0.999, so each resumeSession call
      // creates a distinct session rather than matching an existing one.
      const first = await resumeSession(engram, {
        message: 'alpha',
        threshold: 0.999,
      });
      const second = await resumeSession(engram, {
        message: 'beta',
        threshold: 0.999,
      });
      // Both active with default maxActive (5)
      expect(engram.listWorkingSessions().length).toBe(2);

      // Third with maxActive: 2 should snapshot the oldest (first),
      // leaving second + third active.
      await resumeSession(engram, {
        message: 'tau',
        threshold: 0.999,
        maxActive: 2,
      });
      const active = engram.listWorkingSessions();
      expect(active.find((s) => s.id === first.sessionId)).toBeUndefined();
      expect(active.find((s) => s.id === second.sessionId)).toBeDefined();
    });
  });

  describe('updateSession', () => {
    it('merges progress into the stored session state', async () => {
      const resumed = await resumeSession(engram, {
        message: 'alpha refactor work',
        threshold: 0.999,
      });
      const updated = await updateSession(engram, {
        sessionId: resumed.sessionId,
        progress: 'Extracted JWT decoder into its own file',
      });
      expect(updated.sessionId).toBe(resumed.sessionId);
      expect(typeof updated.updated_at).toBe('string');

      // Re-resume the same topic — Engram should return the updated progress
      const reloaded = await resumeSession(engram, {
        message: 'alpha refactor work',
      });
      expect(reloaded.sessionId).toBe(resumed.sessionId);
      expect(reloaded.progress).toBe('Extracted JWT decoder into its own file');
    });

    it('preserves agent-defined extension keys', async () => {
      const resumed = await resumeSession(engram, {
        message: 'beta migration plan',
        threshold: 0.999,
      });
      await updateSession(engram, {
        sessionId: resumed.sessionId,
        extensions: { ticketIds: ['ENG-42', 'ENG-43'] },
      });

      // Read back via Engram's getWorkingSession
      const state = engram.getWorkingSession(resumed.sessionId);
      expect(state).not.toBeNull();
      expect((state as Record<string, unknown>).ticketIds).toEqual([
        'ENG-42',
        'ENG-43',
      ]);
    });

    it('throws when the sessionId is unknown', async () => {
      await expect(
        updateSession(engram, {
          sessionId: 'wm-does-not-exist',
          progress: 'this should fail',
        }),
      ).rejects.toThrow(/not found|expired/i);
    });
  });

  describe('snapshotSession', () => {
    it('returns the new long-term chunkId and expires the session', async () => {
      const resumed = await resumeSession(engram, {
        message: 'tau production rollout planning',
        threshold: 0.999,
      });
      await updateSession(engram, {
        sessionId: resumed.sessionId,
        progress: 'Drafted the rollback plan; coordinated with SRE',
      });

      const result = await snapshotSession(engram, {
        sessionId: resumed.sessionId,
      });
      expect(result.sessionId).toBe(resumed.sessionId);
      expect(result.chunkId).toMatch(/^chk-/);

      // Session no longer active
      const active = engram.listWorkingSessions();
      expect(active.find((s) => s.id === resumed.sessionId)).toBeUndefined();

      // Re-resume on the same topic creates a NEW session
      const reresumed = await resumeSession(engram, {
        message: 'tau production rollout planning',
        threshold: 0.999,
      });
      expect(reresumed.sessionId).not.toBe(resumed.sessionId);
      expect(reresumed.reason).toBe('new');

      // Headline value prop: the snapshotted progress surfaces in
      // relatedContext on a re-resume, so the agent can pick up the thread.
      expect(reresumed.relatedContext).toContain('rollback plan');
    });

    it('throws when the sessionId is unknown', async () => {
      await expect(
        snapshotSession(engram, { sessionId: 'wm-does-not-exist' }),
      ).rejects.toThrow();
    });
  });
});

// =============================================================================
// Background consolidation scheduling (pure + effectful adapter surface)
// =============================================================================

class FakeGenerator implements GenerationProvider {
  calls = 0;
  constructor(private readonly impl: () => Promise<string>) {}
  async generate(): Promise<string> {
    this.calls += 1;
    return this.impl();
  }
}

describe('consolidation scheduling — pure cadence', () => {
  const cfg = { extractEveryTurns: 3, reflectEveryTurns: 12, extractBatchSize: 10 };

  it('consolidationDue is true only on an interval boundary', () => {
    expect(consolidationDue(1, cfg)).toBe(false);
    expect(consolidationDue(3, cfg)).toBe(true); // extract interval
    expect(consolidationDue(6, cfg)).toBe(true);
    expect(consolidationDue(12, cfg)).toBe(true); // reflect interval
    expect(consolidationDue(7, cfg)).toBe(false);
    expect(consolidationDue(0, cfg)).toBe(false);
  });

  it('planConsolidation gates extract on both interval and a non-empty queue', () => {
    expect(planConsolidation(3, 5, cfg)).toEqual({ extract: true, reflect: false });
    // interval hit but empty queue → no extract (don't wake Ollama for nothing)
    expect(planConsolidation(3, 0, cfg)).toEqual({ extract: false, reflect: false });
    // off-interval → nothing
    expect(planConsolidation(4, 5, cfg)).toEqual({ extract: false, reflect: false });
  });

  it('planConsolidation reflects on the reflect interval (queue-independent)', () => {
    // turn 12 hits both intervals; with pending>0 both fire
    expect(planConsolidation(12, 2, cfg)).toEqual({ extract: true, reflect: true });
    // turn 24 hits reflect (24%12) but not extract (24%3==0 too) — both again
    expect(planConsolidation(12, 0, cfg)).toEqual({ extract: false, reflect: true });
  });

  it('a zero interval disables that cadence', () => {
    const off = { extractEveryTurns: 0, reflectEveryTurns: 0, extractBatchSize: 10 };
    expect(consolidationDue(99, off)).toBe(false);
    expect(planConsolidation(99, 100, off)).toEqual({ extract: false, reflect: false });
  });
});

describe('isConnectionError', () => {
  it('classifies connection-class failures as Ollama-down', () => {
    expect(isConnectionError(new Error('fetch failed'))).toBe(true);
    expect(isConnectionError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe(true);
    const wrapped = new Error('fetch failed');
    (wrapped as { cause?: unknown }).cause = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    expect(isConnectionError(wrapped)).toBe(true);
  });

  it('does not swallow genuine (non-connection) errors', () => {
    expect(isConnectionError(new Error('JSON parse error'))).toBe(false);
    expect(isConnectionError(new TypeError('bad shape'))).toBe(false);
  });
});

describe('runConsolidation — effectful', () => {
  let dbPath: string;
  let engram: Engram;

  afterEach(() => {
    engram?.close();
    cleanup(dbPath);
  });

  async function make(gen: GenerationProvider): Promise<Engram> {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new TestEmbedder(),
      generator: gen,
    });
    return engram;
  }

  it('no-op plan touches neither Ollama nor returns results', async () => {
    const gen = new FakeGenerator(async () => '{}');
    const e = await make(gen);
    const res = await runConsolidation(e, { extract: false, reflect: false }, DEFAULT_SCHEDULING_CONFIG);
    expect(res).toEqual({ extracted: null, reflected: null, ollamaReachable: true });
    expect(gen.calls).toBe(0);
  });

  it('reports Ollama unreachable when extraction hits a connection error', async () => {
    const gen = new FakeGenerator(async () => {
      throw new Error('fetch failed');
    });
    const e = await make(gen);
    // Retain queues an extraction job so processExtractions actually calls Ollama.
    await remember(e, { text: 'Tom ships Engram on a homelab Proxmox cluster' });
    expect(e.getQueueStats().pending).toBeGreaterThan(0);

    const res = await runConsolidation(
      e,
      { extract: true, reflect: true },
      DEFAULT_SCHEDULING_CONFIG,
    );
    expect(res.ollamaReachable).toBe(false);
    // reflect must be skipped once extraction proves Ollama is down
    expect(res.reflected).toBeNull();
  });

  it('reflect below the min-facts threshold stays reachable and skips the LLM', async () => {
    const gen = new FakeGenerator(async () => {
      throw new Error('should not be called below threshold');
    });
    const e = await make(gen);
    await remember(e, { text: 'one lonely fact, well under the reflect threshold' });

    const res = await runConsolidation(
      e,
      { extract: false, reflect: true },
      DEFAULT_SCHEDULING_CONFIG,
    );
    expect(res.ollamaReachable).toBe(true);
    expect(gen.calls).toBe(0); // early return, generator never invoked
  });

  it('does not cry wolf: a non-connection extraction failure leaves Ollama reachable', async () => {
    // A malformed-response / parse-class failure is recorded on the queue but
    // is NOT an outage — reachability must stay true so we never warn falsely.
    const gen = new FakeGenerator(async () => {
      throw new Error('totally unexpected parse explosion');
    });
    const e = await make(gen);
    await remember(e, { text: 'a fact to enqueue extraction work' });

    const res = await runConsolidation(
      e,
      { extract: true, reflect: false },
      DEFAULT_SCHEDULING_CONFIG,
    );
    expect(res.extracted?.failed).toBeGreaterThan(0);
    expect(res.ollamaReachable).toBe(true);
  });
});

// =============================================================================
// Auto-retain (pure planning + effectful retain)
// =============================================================================

describe('extractMessageText', () => {
  it('returns a string content as-is', () => {
    expect(extractMessageText('hello world')).toBe('hello world');
  });

  it('joins text parts and ignores non-text (e.g. image) parts', () => {
    const content = [
      { type: 'text', text: 'first line' },
      { type: 'image', url: 'data:...' },
      { type: 'text', text: 'second line' },
    ];
    expect(extractMessageText(content)).toBe('first line\nsecond line');
  });

  it('returns empty string for unsupported content shapes', () => {
    expect(extractMessageText(undefined)).toBe('');
    expect(extractMessageText(42)).toBe('');
    expect(extractMessageText([{ type: 'image' }])).toBe('');
  });
});

describe('planAutoRetain — pure', () => {
  const cfg = { minChars: 8, maxChars: 50 };

  it('maps user/assistant/tool roles to the right provenance', () => {
    const user = planAutoRetain({ role: 'user', content: 'deploy the staging cluster tonight' }, cfg);
    expect(user).toMatchObject({ memoryType: 'experience', sourceType: 'user_stated', trustScore: 0.7 });

    const asst = planAutoRetain({ role: 'assistant', content: 'I will deploy the staging cluster now' }, cfg);
    expect(asst).toMatchObject({ sourceType: 'agent_generated', trustScore: 0.5 });

    const tool = planAutoRetain({ role: 'toolResult', content: 'exit code 0, build succeeded fine' }, cfg);
    expect(tool).toMatchObject({ sourceType: 'tool_result', trustScore: 0.4 });

    const bash = planAutoRetain({ role: 'bashExecution', content: 'npm test => 59 passing tests' }, cfg);
    expect(bash).toMatchObject({ sourceType: 'tool_result', trustScore: 0.4 });
  });

  it('skips internal / unknown roles', () => {
    expect(planAutoRetain({ role: 'compactionSummary', content: 'summary text here long enough' }, cfg)).toBeNull();
    expect(planAutoRetain({ role: 'branchSummary', content: 'another summary that is long enough' }, cfg)).toBeNull();
    expect(planAutoRetain({ role: 'custom', content: 'custom payload long enough to pass' }, cfg)).toBeNull();
  });

  it('skips empty, too-short, and user slash-command messages', () => {
    expect(planAutoRetain({ role: 'user', content: '   ' }, cfg)).toBeNull();
    expect(planAutoRetain({ role: 'user', content: 'ok' }, cfg)).toBeNull(); // below minChars
    expect(planAutoRetain({ role: 'user', content: '/recall staging deploy' }, cfg)).toBeNull();
    // a slash from a tool result is NOT a command — still captured
    expect(planAutoRetain({ role: 'toolResult', content: '/usr/bin/node not found here' }, cfg)).not.toBeNull();
  });

  it('truncates over-long text with a marker', () => {
    const long = 'x'.repeat(200);
    const plan = planAutoRetain({ role: 'toolResult', content: long }, cfg);
    expect(plan).not.toBeNull();
    expect(plan!.text.length).toBe(cfg.maxChars);
    expect(plan!.text.endsWith('… [truncated]')).toBe(true);
  });

  it('tags the source and role context', () => {
    const plan = planAutoRetain({ role: 'user', content: 'a sufficiently long user message' }, cfg);
    expect(plan!.source).toBe('pi:conversation');
    expect(plan!.context).toBe('role:user');
  });
});

describe('autoRetain — effectful', () => {
  let dbPath: string;
  let e: Engram;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    e = await Engram.create(dbPath, { embedder: new TestEmbedder() });
  });
  afterEach(() => {
    e.close();
    cleanup(dbPath);
  });

  it('stores a captured user message as an experience and returns the result', async () => {
    const res = await autoRetain(
      e,
      { role: 'user', content: 'Tom prefers Terraform with the bpg provider' },
      DEFAULT_AUTO_RETAIN_CONFIG,
    );
    expect(res?.chunkId).toMatch(/^chk-/);
    expect(memoryStats(e).chunks).toBe(1);
  });

  it('returns null and stores nothing for a skipped message', async () => {
    const res = await autoRetain(e, { role: 'user', content: '/memory' }, DEFAULT_AUTO_RETAIN_CONFIG);
    expect(res).toBeNull();
    expect(memoryStats(e).chunks).toBe(0);
  });

  it('deduplicates a repeated message via normalized text_hash', async () => {
    const msg = { role: 'assistant', content: 'the deployment finished without errors at all' };
    const first = await autoRetain(e, msg, DEFAULT_AUTO_RETAIN_CONFIG);
    const second = await autoRetain(e, msg, DEFAULT_AUTO_RETAIN_CONFIG);
    expect(first?.deduplicated ?? false).toBe(false);
    expect(second?.deduplicated).toBe(true);
    expect(memoryStats(e).chunks).toBe(1);
  });
});
