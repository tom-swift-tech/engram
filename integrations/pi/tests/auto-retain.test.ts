// =============================================================================
// auto-retain.test.ts — binding-level tests for message_end auto-retain.
//
// Drives the real message_end handler through a fake Pi API with a real
// in-memory Engram. The fire-and-forget retain is awaited deterministically
// via _getPendingAutoRetainForTesting().
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Engram, type EmbeddingProvider } from 'engram';

import engramPiExtension, {
  _setEngineFactoryForTesting,
  _resetEngineFactoryForTesting,
  _setAutoRetainConfigForTesting,
  _getPendingAutoRetainForTesting,
} from '../src/index.js';
import { memoryStats } from '../src/adapter.js';

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

interface FakePi {
  pi: ExtensionAPI;
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
}

function makeFakePi(): FakePi {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const fake = {
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    on: vi.fn((event: string, handler: (e: unknown, c: unknown) => unknown) => {
      handlers.set(event, handler);
    }),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
    appendEntry: vi.fn(),
  };
  return { pi: fake as unknown as ExtensionAPI, handlers };
}

describe('auto-retain (binding)', () => {
  let factoryCalls: number;
  let engram: Engram | null;

  beforeEach(() => {
    factoryCalls = 0;
    engram = null;
    _setEngineFactoryForTesting(async () => {
      factoryCalls += 1;
      engram = await Engram.create(':memory:', { embedder: new TestEmbedder() });
      return engram;
    });
  });

  afterEach(() => {
    _resetEngineFactoryForTesting();
  });

  async function fireMessage(fp: FakePi, message: unknown): Promise<void> {
    fp.handlers.get('message_end')!({ message }, {});
    const pending = _getPendingAutoRetainForTesting();
    if (pending) await pending;
  }

  it('retains a completed user message as an experience by default', async () => {
    const fp = makeFakePi();
    engramPiExtension(fp.pi);

    await fireMessage(fp, {
      role: 'user',
      content: 'deploy the staging cluster tonight at 9pm',
    });

    expect(factoryCalls).toBe(1);
    expect(memoryStats(engram!).chunks).toBe(1);
  });

  it('captures tool output too (lowest-trust tier)', async () => {
    const fp = makeFakePi();
    engramPiExtension(fp.pi);

    await fireMessage(fp, { role: 'user', content: 'run the test suite for me' });
    await fireMessage(fp, {
      role: 'toolResult',
      content: 'npm test => 59 passing, 0 failing',
    });

    expect(memoryStats(engram!).chunks).toBe(2);
  });

  it('does nothing when disabled via config (ENGRAM_PI_AUTO_RETAIN=0)', async () => {
    _setAutoRetainConfigForTesting({ enabled: false });
    const fp = makeFakePi();
    engramPiExtension(fp.pi);

    await fireMessage(fp, {
      role: 'user',
      content: 'this should not be stored at all',
    });

    // Disabled → never even opens the DB.
    expect(factoryCalls).toBe(0);
    expect(_getPendingAutoRetainForTesting()).toBeNull();
  });

  it('preserves lazy-open: a skipped message never opens Engram', async () => {
    const fp = makeFakePi();
    engramPiExtension(fp.pi);

    await fireMessage(fp, { role: 'user', content: '/memory' }); // slash command
    await fireMessage(fp, { role: 'user', content: 'ok' }); // too short
    await fireMessage(fp, { role: 'compactionSummary', content: 'internal summary text' }); // skipped role

    expect(factoryCalls).toBe(0);
  });
});
