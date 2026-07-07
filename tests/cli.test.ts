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
});
