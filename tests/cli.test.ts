import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runCli, type CliIO } from '../src/cli.js';
import type { EngramOptions } from '../src/engram.js';
import {
  MockEmbedder,
  MockGenerator,
  EXTRACTION_RESPONSE,
  tmpDbPath,
  cleanupDb,
} from './helpers.js';

// ─── Test IO harness ──────────────────────────────────────────────────────────

function captureIo(stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readStdin: async () => stdin,
  };
  return {
    io,
    out,
    err,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

describe('engram CLI', () => {
  let dbPath: string;
  // Inject Ollama-free embedder + generator so commands run offline.
  const overrides: Partial<EngramOptions> = {};

  beforeEach(() => {
    dbPath = tmpDbPath();
    overrides.embedder = new MockEmbedder();
    overrides.generator = new MockGenerator(EXTRACTION_RESPONSE);
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  // Convenience: append --db automatically.
  function args(...parts: string[]): string[] {
    return [...parts, '--db', dbPath];
  }

  // ─── retain ─────────────────────────────────────────────────────────────────

  it('retain stores a chunk and prints chunkId as JSON', async () => {
    const cap = captureIo();
    const code = await runCli(
      args('retain', 'Tom prefers Terraform', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.chunkId).toMatch(/^chk-/);
    expect(parsed).toHaveProperty('queued');
  });

  it('retain human output goes to stdout, diagnostics to stderr', async () => {
    const cap = captureIo();
    const code = await runCli(
      args('retain', 'Tom prefers Pulumi', '--memory-type', 'world'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    expect(cap.stdout()).toMatch(/^retained chk-/);
    // diagnostics never leak into stdout
    expect(cap.stdout()).not.toContain('[engram]');
    expect(cap.stderr()).toContain('[engram]');
  });

  it('retain reads text from stdin when the positional is omitted', async () => {
    const cap = captureIo('Piped fact about Kubernetes');
    const code = await runCli(args('retain', '--json'), cap.io, overrides);
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout()).chunkId).toMatch(/^chk-/);
  });

  // ─── recall ───────────────────────────────────────────────────────────────

  it('recall returns the documented JSON contract shape', async () => {
    await runCli(
      args('retain', 'Tom prefers Terraform with the bpg provider'),
      captureIo().io,
      overrides,
    );
    const cap = captureIo();
    const code = await runCli(
      args('recall', 'Terraform', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(Array.isArray(parsed.opinions)).toBe(true);
    expect(Array.isArray(parsed.observations)).toBe(true);
    expect(parsed).toHaveProperty('strategiesUsed');
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  it('recall reads the query from stdin when omitted', async () => {
    await runCli(
      args('retain', 'Terraform is the chosen IaC tool'),
      captureIo().io,
      overrides,
    );
    const cap = captureIo('Terraform');
    const code = await runCli(args('recall', '--json'), cap.io, overrides);
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  it('--json emits only JSON to stdout (parses in one shot)', async () => {
    const cap = captureIo();
    await runCli(args('recall', 'anything', '--json'), cap.io, overrides);
    // No human prose, no diagnostics — exactly one JSON document.
    expect(() => JSON.parse(cap.stdout().trim())).not.toThrow();
  });

  it('recall --explain-scores carries strategyScores through --json untouched', async () => {
    await runCli(
      args('retain', 'Tom prefers Terraform explain scores cli test'),
      captureIo().io,
      overrides,
    );
    const cap = captureIo();
    const code = await runCli(
      args(
        'recall',
        'Terraform explain scores cli',
        '--strategies',
        'keyword',
        '--explain-scores',
        '--json',
      ),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0].strategyScores).toBeDefined();
    expect(Array.isArray(parsed.results[0].strategyScores.perStrategy)).toBe(
      true,
    );
    expect(typeof parsed.results[0].strategyScores.rawFusedScore).toBe(
      'number',
    );
  });

  it('recall without --explain-scores omits strategyScores from --json', async () => {
    await runCli(
      args('retain', 'Tom prefers Pulumi no explain scores cli test'),
      captureIo().io,
      overrides,
    );
    const cap = captureIo();
    const code = await runCli(
      args(
        'recall',
        'Pulumi no explain scores cli',
        '--strategies',
        'keyword',
        '--json',
      ),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0]).not.toHaveProperty('strategyScores');
  });

  it('recall --min-score filters out low-relevance results via --json', async () => {
    await runCli(
      args('retain', 'MinScore CLI filter test widget content'),
      captureIo().io,
      overrides,
    );

    const baselineCap = captureIo();
    await runCli(
      args(
        'recall',
        'MinScore CLI filter widget',
        '--strategies',
        'keyword',
        '--json',
      ),
      baselineCap.io,
      overrides,
    );
    const baseline = JSON.parse(baselineCap.stdout());
    expect(baseline.results.length).toBeGreaterThan(0);
    const topScore: number = baseline.results[0].score;

    const cap = captureIo();
    const code = await runCli(
      args(
        'recall',
        'MinScore CLI filter widget',
        '--strategies',
        'keyword',
        '--min-score',
        String(topScore + 1),
        '--json',
      ),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.results).toHaveLength(0);
  });

  // ─── reflect ─────────────────────────────────────────────────────────────────

  it('reflect runs and returns a result object', async () => {
    const cap = captureIo();
    const code = await runCli(args('reflect', '--json'), cap.io, {
      ...overrides,
      generator: new MockGenerator(),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('factsProcessed');
  });

  // ─── process-extractions ──────────────────────────────────────────────────

  it('process-extractions returns processed/failed counts', async () => {
    await runCli(
      args('retain', 'Alice prefers Rust for systems work'),
      captureIo().io,
      overrides,
    );
    const cap = captureIo();
    const code = await runCli(
      args('process-extractions', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(typeof parsed.processed).toBe('number');
    expect(typeof parsed.failed).toBe('number');
  });

  // ─── forget ──────────────────────────────────────────────────────────────────

  it('forget soft-deletes an existing chunk and exits 0', async () => {
    const retainCap = captureIo();
    await runCli(
      args('retain', 'Temporary fact', '--json'),
      retainCap.io,
      overrides,
    );
    const chunkId = JSON.parse(retainCap.stdout()).chunkId;

    const cap = captureIo();
    const code = await runCli(
      args('forget', chunkId, '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout())).toEqual({ forgotten: true });
  });

  it('forget on a missing chunk exits 2', async () => {
    const cap = captureIo();
    const code = await runCli(
      args('forget', 'chk-does-not-exist', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(2);
    expect(JSON.parse(cap.stdout())).toEqual({ forgotten: false });
  });

  // ─── supersede ───────────────────────────────────────────────────────────────

  it('supersede replaces an existing fact and exits 0', async () => {
    const retainCap = captureIo();
    await runCli(
      args('retain', 'Tom uses Docker Compose', '--json'),
      retainCap.io,
      overrides,
    );
    const oldChunkId = JSON.parse(retainCap.stdout()).chunkId;

    const cap = captureIo();
    const code = await runCli(
      args('supersede', oldChunkId, 'Tom switched to Kubernetes', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout()).chunkId).toMatch(/^chk-/);
  });

  it('supersede reads newText from stdin when omitted', async () => {
    const retainCap = captureIo();
    await runCli(
      args('retain', 'Old belief', '--json'),
      retainCap.io,
      overrides,
    );
    const oldChunkId = JSON.parse(retainCap.stdout()).chunkId;

    const cap = captureIo('New corrected belief');
    const code = await runCli(
      args('supersede', oldChunkId, '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout()).chunkId).toMatch(/^chk-/);
  });

  it('supersede on a missing chunk exits 2 without creating a chunk', async () => {
    const cap = captureIo();
    const code = await runCli(
      args('supersede', 'chk-missing', 'replacement', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(2);
    expect(cap.stdout()).toBe(''); // nothing emitted on the not-found branch
    expect(cap.stderr()).toContain('not found');
  });

  // ─── session ─────────────────────────────────────────────────────────────────

  it('session creates a new working memory session', async () => {
    const cap = captureIo();
    const code = await runCli(
      args('session', 'Help me plan the deployment', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.session.id).toMatch(/^wm-/);
    expect(parsed.diagnostics.reason).toBe('new');
  });

  // ─── queue-stats ─────────────────────────────────────────────────────────────

  it('queue-stats returns health counts', async () => {
    const cap = captureIo();
    const code = await runCli(args('queue-stats', '--json'), cap.io, overrides);
    expect(code).toBe(0);
    const stats = JSON.parse(cap.stdout());
    expect(stats).toHaveProperty('pending');
    expect(stats).toHaveProperty('completed');
    expect(stats).toHaveProperty('failed');
    expect(typeof stats.pending).toBe('number');
    expect(Array.isArray(stats.failed_reasons)).toBe(true);
  });

  // ─── requeue-failed ──────────────────────────────────────────────────────────

  it('requeue-failed resets failed items and reports the count', async () => {
    // Seed a chunk (its queue item starts pending), then force it to the
    // terminal failed state the way a real exhausted-retries outage would.
    await runCli(
      args('retain', 'A fact that failed extraction'),
      captureIo().io,
      overrides,
    );
    const raw = new Database(dbPath);
    raw
      .prepare(
        `UPDATE extraction_queue SET status = 'failed', attempts = 3, error = 'fetch failed'`,
      )
      .run();
    raw.close();

    const cap = captureIo();
    const code = await runCli(
      args('requeue-failed', '--error-like', 'fetch failed', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout())).toEqual({ requeued: 1 });

    // The item is pending again with fresh attempts
    const check = new Database(dbPath);
    const row = check
      .prepare('SELECT status, attempts FROM extraction_queue LIMIT 1')
      .get() as any;
    check.close();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
  });

  // ─── embed ───────────────────────────────────────────────────────────────

  it('embed returns the embedding vector and its dimensions as JSON', async () => {
    const cap = captureIo();
    const code = await runCli(
      args('embed', 'deploy pipeline', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(Array.isArray(parsed.embedding)).toBe(true);
    expect(parsed.dimensions).toBe(parsed.embedding.length);
    expect(parsed.embedding.every((n: unknown) => Number.isFinite(n))).toBe(
      true,
    );
  });

  it('embed reads text from stdin and accepts --mode document', async () => {
    const cap = captureIo('piped text to embed');
    const code = await runCli(
      args('embed', '--mode', 'document', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.dimensions).toBeGreaterThan(0);
  });

  // ─── error paths ──────────────────────────────────────────────────────────

  it('exits 1 when no database path is given', async () => {
    const prev = process.env.ENGRAM_DB;
    delete process.env.ENGRAM_DB;
    try {
      const cap = captureIo();
      const code = await runCli(['queue-stats'], cap.io, overrides);
      expect(code).toBe(1);
      expect(cap.stderr()).toContain('ENGRAM_DB');
    } finally {
      if (prev !== undefined) process.env.ENGRAM_DB = prev;
    }
  });

  it('resolves the db path from the ENGRAM_DB env var', async () => {
    const prev = process.env.ENGRAM_DB;
    process.env.ENGRAM_DB = dbPath;
    try {
      const cap = captureIo();
      const code = await runCli(['queue-stats', '--json'], cap.io, overrides);
      expect(code).toBe(0);
      expect(JSON.parse(cap.stdout())).toHaveProperty('pending');
    } finally {
      if (prev !== undefined) process.env.ENGRAM_DB = prev;
      else delete process.env.ENGRAM_DB;
    }
  });

  it('exits 1 with usage on an unknown command', async () => {
    const cap = captureIo();
    const code = await runCli(args('frobnicate'), cap.io, overrides);
    expect(code).toBe(1);
    expect(cap.stderr()).toContain('unknown command');
  });

  it('exits 1 when a required text arg is missing and stdin is empty', async () => {
    const cap = captureIo(''); // empty stdin
    const code = await runCli(args('retain', '--json'), cap.io, overrides);
    expect(code).toBe(1);
    expect(cap.stderr()).toContain('text');
  });

  // ─── --json contract (stdout is JSON only, nothing else) ─────────────────────

  it('every command emits exactly one JSON document on stdout, diagnostics on stderr', async () => {
    // Seed a chunk so recall/forget have a real target.
    const seed = captureIo();
    await runCli(
      args('retain', 'Seed fact about Terraform', '--json'),
      seed.io,
      overrides,
    );
    const seededId = JSON.parse(seed.stdout()).chunkId;

    // (command argv, generator) — reflect uses the default canned generator.
    const cases: Array<{ argv: string[]; label: string }> = [
      { argv: args('retain', 'Another fact', '--json'), label: 'retain' },
      { argv: args('recall', 'Terraform', '--json'), label: 'recall' },
      { argv: args('reflect', '--json'), label: 'reflect' },
      {
        argv: args('process-extractions', '--json'),
        label: 'process-extractions',
      },
      { argv: args('session', 'plan something', '--json'), label: 'session' },
      { argv: args('queue-stats', '--json'), label: 'queue-stats' },
      {
        argv: args('requeue-failed', '--json'),
        label: 'requeue-failed',
      },
      { argv: args('embed', 'some text', '--json'), label: 'embed' },
      { argv: args('forget', seededId, '--json'), label: 'forget' },
    ];

    for (const c of cases) {
      const cap = captureIo();
      const generator =
        c.label === 'reflect'
          ? new MockGenerator()
          : new MockGenerator(EXTRACTION_RESPONSE);
      const code = await runCli(c.argv, cap.io, { ...overrides, generator });
      expect(code, `${c.label} should exit 0`).toBe(0);

      const out = cap.stdout();
      // exactly one parseable JSON value — no human prose appended
      expect(
        () => JSON.parse(out.trim()),
        `${c.label} stdout must be pure JSON, got: ${JSON.stringify(out)}`,
      ).not.toThrow();
      expect(typeof JSON.parse(out.trim())).toBe('object');
      // diagnostics never leak to stdout; they live on stderr
      expect(out, `${c.label} leaked diagnostics to stdout`).not.toContain(
        '[engram]',
      );
      expect(cap.stderr()).toContain('[engram]');
    }
  });

  it('supersede emits exactly one JSON document on stdout', async () => {
    const seed = captureIo();
    await runCli(
      args('retain', 'Old superseded belief', '--json'),
      seed.io,
      overrides,
    );
    const oldId = JSON.parse(seed.stdout()).chunkId;

    const cap = captureIo();
    const code = await runCli(
      args('supersede', oldId, 'Corrected belief', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const out = cap.stdout();
    expect(() => JSON.parse(out.trim())).not.toThrow();
    expect(out).not.toContain('[engram]');
    expect(JSON.parse(out.trim()).chunkId).toMatch(/^chk-/);
  });

  // ─── session actions (update / snapshot) ──────────────────────────────────

  it('session --action update merges progress into an existing session', async () => {
    const created = captureIo();
    await runCli(
      args('session', 'Session for CLI update test', '--json'),
      created.io,
      overrides,
    );
    const sessionId = JSON.parse(created.stdout()).session.id;

    const cap = captureIo();
    const code = await runCli(
      args(
        'session',
        '--action',
        'update',
        '--session-id',
        sessionId,
        '--progress',
        'Drafted the rollback plan',
        '--json',
      ),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const state = JSON.parse(cap.stdout());
    expect(state.id).toBe(sessionId);
    expect(state.progress).toBe('Drafted the rollback plan');
  });

  it('session --action snapshot collapses a session and returns a chunkId', async () => {
    const created = captureIo();
    await runCli(
      args('session', 'Session for CLI snapshot test', '--json'),
      created.io,
      overrides,
    );
    const sessionId = JSON.parse(created.stdout()).session.id;

    const cap = captureIo();
    const code = await runCli(
      args(
        'session',
        '--action',
        'snapshot',
        '--session-id',
        sessionId,
        '--json',
      ),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.chunkId).toMatch(/^chk-/);
  });

  it('session --action update exits 2 for an unknown sessionId', async () => {
    const cap = captureIo();
    const code = await runCli(
      args(
        'session',
        '--action',
        'update',
        '--session-id',
        'wm-does-not-exist',
        '--json',
      ),
      cap.io,
      overrides,
    );
    expect(code).toBe(2);
    expect(cap.stderr()).toContain('not found');
  });

  // ─── context-commit / context-query / context-promote ────────────────────

  it('context-commit stores a child artifact and context-query finds it under the parent ref', async () => {
    // A ref is queryable as a PARENT (context-query returns its children,
    // not itself — see context-store.ts's queryContext doc), so the round
    // trip needs a root scope plus a child committed under it.
    const rootCap = captureIo();
    const rootCode = await runCli(
      args(
        'context-commit',
        JSON.stringify({ decision: 'root: plan the release' }),
        '--json',
      ),
      rootCap.io,
      overrides,
    );
    expect(rootCode).toBe(0);
    const root = JSON.parse(rootCap.stdout());
    expect(root.id).toMatch(/^ctx-/);
    expect(root.scope).toBe('task');

    const commitCap = captureIo();
    const commitCode = await runCli(
      args(
        'context-commit',
        JSON.stringify({
          decision: 'Use blue/green deployment for the release',
          rationale: 'Zero-downtime cutover with an easy rollback',
          domain: 'deployment-planning',
          parentRefId: root.id,
        }),
        '--json',
      ),
      commitCap.io,
      overrides,
    );
    expect(commitCode).toBe(0);

    const queryCap = captureIo();
    const queryCode = await runCli(
      args('context-query', root.id, 'deployment strategy', '--json'),
      queryCap.io,
      overrides,
    );
    expect(queryCode).toBe(0);
    const slice = JSON.parse(queryCap.stdout());
    expect(slice.artifacts.length).toBeGreaterThan(0);
    expect(slice.artifacts[0].artifact.decision).toContain('blue/green');
  });

  it('context-commit reads the JSON payload from stdin when omitted', async () => {
    const cap = captureIo(
      JSON.stringify({ decision: 'Piped decision via stdin' }),
    );
    const code = await runCli(
      args('context-commit', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(0);
    const ref = JSON.parse(cap.stdout());
    expect(ref.id).toMatch(/^ctx-/);
  });

  it('context-commit exits 1 on invalid JSON', async () => {
    const cap = captureIo();
    const code = await runCli(
      args('context-commit', 'not json', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(1);
    expect(cap.stderr()).toContain('JSON');
  });

  it('context-promote moves an artifact to durable memory findable by recall', async () => {
    const commitCap = captureIo();
    await runCli(
      args(
        'context-commit',
        JSON.stringify({
          decision: 'PromoteMe: adopt trunk-based development',
        }),
        '--json',
      ),
      commitCap.io,
      overrides,
    );
    const ref = JSON.parse(commitCap.stdout());

    const promoteCap = captureIo();
    const promoteCode = await runCli(
      args('context-promote', ref.id, '--json'),
      promoteCap.io,
      overrides,
    );
    expect(promoteCode).toBe(0);
    expect(JSON.parse(promoteCap.stdout())).toEqual({ promoted: true });

    const recallCap = captureIo();
    await runCli(
      args('recall', 'trunk-based development', '--json'),
      recallCap.io,
      overrides,
    );
    const recallParsed = JSON.parse(recallCap.stdout());
    expect(
      recallParsed.results.some((r: any) => r.text.includes('PromoteMe')),
    ).toBe(true);
  });

  it('context-promote exits 2 and reports {promoted:false} for an unknown refId', async () => {
    const cap = captureIo();
    const code = await runCli(
      args('context-promote', 'ctx-does-not-exist', '--json'),
      cap.io,
      overrides,
    );
    expect(code).toBe(2);
    expect(JSON.parse(cap.stdout())).toEqual({ promoted: false });
  });
});
