// =============================================================================
// scheduling.test.ts — binding-level tests for background consolidation.
//
// Drives the real turn_end / session_shutdown handlers through a fake Pi API,
// with a real in-memory Engram (deterministic embedder + injectable generator).
// The fire-and-forget cycle is awaited deterministically via the test-only
// _getPendingConsolidationForTesting() hook rather than raced.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  Engram,
  type EmbeddingProvider,
  type GenerationProvider,
} from 'engram';

import engramPiExtension, {
  _setEngineFactoryForTesting,
  _resetEngineFactoryForTesting,
  _setSchedulingConfigForTesting,
  _getPendingConsolidationForTesting,
} from '../src/index.js';

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

/** Generator that always fails as if Ollama were unreachable. */
class DownGenerator implements GenerationProvider {
  calls = 0;
  async generate(): Promise<string> {
    this.calls += 1;
    throw new Error('fetch failed');
  }
}

/** Generator whose calls block until `release()` is invoked. */
class BlockingGenerator implements GenerationProvider {
  calls = 0;
  private gate: Promise<void>;
  private open!: () => void;
  constructor() {
    this.gate = new Promise((r) => (this.open = r));
  }
  release(): void {
    this.open();
  }
  async generate(): Promise<string> {
    this.calls += 1;
    await this.gate;
    throw new Error('fetch failed');
  }
}

interface FakePi {
  pi: ExtensionAPI;
  ctx: unknown;
  commands: Map<string, (args: string) => Promise<void>>;
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  notifications: { message: string; level: string }[];
}

function makeFakePi(): FakePi {
  const commands = new Map<string, (args: string) => Promise<void>>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const notifications: { message: string; level: string }[] = [];

  const ui = {
    notify: (message: string, level: string) => {
      notifications.push({ message, level });
    },
    confirm: vi.fn(async () => true),
  };
  const ctx = { hasUI: true, ui };

  const fake = {
    registerCommand: vi.fn(
      (
        name: string,
        def: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => {
        commands.set(name, (args: string) => def.handler(args, ctx));
      },
    ),
    registerTool: vi.fn(),
    on: vi.fn((event: string, handler: (e: unknown, c: unknown) => unknown) => {
      handlers.set(event, handler);
    }),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
    appendEntry: vi.fn(),
  };

  return {
    pi: fake as unknown as ExtensionAPI,
    ctx,
    commands,
    handlers,
    notifications,
  };
}

/** Yield to the event loop until `cond()` holds (or time out). */
async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('background consolidation scheduling (binding)', () => {
  let factoryCalls: number;
  let dbPath: string;

  // File-backed temp DB (not :memory:) — reflect() opens a second connection by
  // path, and isolated :memory: connections wouldn't share the schema.
  function installEngine(gen: GenerationProvider): void {
    factoryCalls = 0;
    dbPath = join(tmpdir(), `engram-pi-sched-${randomUUID()}.engram`);
    _setEngineFactoryForTesting(async () => {
      factoryCalls += 1;
      return Engram.create(dbPath, {
        embedder: new TestEmbedder(),
        generator: gen,
      });
    });
  }

  beforeEach(() => {
    factoryCalls = 0;
    // Every turn is "due" so tests don't have to spin many turns.
    _setSchedulingConfigForTesting({
      extractEveryTurns: 1,
      reflectEveryTurns: 1,
      extractBatchSize: 10,
    });
  });

  afterEach(() => {
    _resetEngineFactoryForTesting();
    if (dbPath) {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          unlinkSync(dbPath + suffix);
        } catch {
          // ignore
        }
      }
    }
  });

  async function fireTurn(fp: FakePi): Promise<void> {
    fp.handlers.get('turn_end')!({}, fp.ctx);
    const pending = _getPendingConsolidationForTesting();
    if (pending) await pending;
  }

  it('does not open Engram on turn_end when memory was never used (lazy-open preserved)', async () => {
    installEngine(new DownGenerator());
    const fp = makeFakePi();
    engramPiExtension(fp.pi);

    await fireTurn(fp);
    await fireTurn(fp);

    expect(factoryCalls).toBe(0);
    expect(fp.notifications).toHaveLength(0);
  });

  it('runs a cycle after memory is used and warns once when Ollama is unreachable', async () => {
    const gen = new DownGenerator();
    installEngine(gen);
    const fp = makeFakePi();
    engramPiExtension(fp.pi);

    // Use a slash command to open Engram and queue an extraction job.
    await fp.commands.get('remember')!('Tom runs Engram on a Proxmox homelab');
    expect(factoryCalls).toBe(1);

    // Several due turns; Ollama is down for all of them.
    await fireTurn(fp);
    await fireTurn(fp);
    await fireTurn(fp);

    expect(gen.calls).toBeGreaterThan(0); // background work actually ran
    const warnings = fp.notifications.filter((n) => n.level === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/Ollama unreachable/i);
  });

  it('overlap guard: a turn_end during an in-flight cycle does not start a second', async () => {
    const gen = new BlockingGenerator();
    installEngine(gen);
    const fp = makeFakePi();
    engramPiExtension(fp.pi);

    await fp.commands.get('remember')!('a fact that queues extraction work');

    // First turn starts a cycle that blocks inside the generator.
    fp.handlers.get('turn_end')!({}, fp.ctx);
    const inflight = _getPendingConsolidationForTesting();
    expect(inflight).not.toBeNull();
    await waitFor(() => gen.calls === 1); // chain reached the (blocked) generator

    // Second turn while the first is still blocked — must be skipped.
    fp.handlers.get('turn_end')!({}, fp.ctx);
    await new Promise((r) => setTimeout(r, 20)); // give a skipped cycle a chance to (not) run

    expect(gen.calls).toBe(1); // overlap guard held — not 2

    gen.release();
    await inflight;
  });

  it('session_shutdown flushes (attempts reflect/extract) then closes Engram', async () => {
    const gen = new DownGenerator();
    installEngine(gen);
    const fp = makeFakePi();
    engramPiExtension(fp.pi);

    await fp.commands.get('remember')!('a fact to flush on shutdown');
    const callsBefore = gen.calls;

    await fp.handlers.get('session_shutdown')!({}, {});

    // The flush ran at least the extraction drain against the (down) generator.
    expect(gen.calls).toBeGreaterThan(callsBefore);
    // Shutdown is silent — no UI warning even though Ollama is down.
    expect(fp.notifications.filter((n) => n.level === 'warning')).toHaveLength(0);
  });
});
