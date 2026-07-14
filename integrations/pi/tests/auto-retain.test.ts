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
import { memoryStats, recall } from '../src/adapter.js';

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
      engram = await Engram.create(':memory:', {
        embedder: new TestEmbedder(),
      });
      return engram;
    });
  });

  afterEach(() => {
    _resetEngineFactoryForTesting();
  });

  async function fireMessage(
    fp: FakePi,
    message: unknown,
    ctx: unknown = {},
  ): Promise<void> {
    fp.handlers.get('message_end')!({ message }, ctx);
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

    await fireMessage(fp, {
      role: 'user',
      content: 'run the test suite for me',
    });
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
    await fireMessage(fp, {
      role: 'compactionSummary',
      content: 'internal summary text',
    }); // skipped role

    expect(factoryCalls).toBe(0);
  });

  describe('ctx.mode-aware provenance (issue #21)', () => {
    const CONTENT = 'deploy the staging cluster tonight at 9pm please';

    async function retainedSourceType(): Promise<{
      sourceType: string;
      trustScore: number;
    }> {
      const response = await recall(engram!, { query: CONTENT, topK: 1 });
      expect(response.results).toHaveLength(1);
      return response.results[0];
    }

    it('stores a tui-mode user message as user_stated (unchanged)', async () => {
      const fp = makeFakePi();
      engramPiExtension(fp.pi);
      await fireMessage(
        fp,
        { role: 'user', content: CONTENT },
        { mode: 'tui' },
      );
      await expect(retainedSourceType()).resolves.toMatchObject({
        sourceType: 'user_stated',
        trustScore: 0.7,
      });
    });

    it('falls back to tui when ctx has no mode field (back-compat)', async () => {
      const fp = makeFakePi();
      engramPiExtension(fp.pi);
      await fireMessage(fp, { role: 'user', content: CONTENT }, {});
      await expect(retainedSourceType()).resolves.toMatchObject({
        sourceType: 'user_stated',
        trustScore: 0.7,
      });
    });

    it.each(['rpc', 'json', 'print'] as const)(
      'downgrades a %s-mode user message to inferred',
      async (mode) => {
        const fp = makeFakePi();
        engramPiExtension(fp.pi);
        await fireMessage(fp, { role: 'user', content: CONTENT }, { mode });
        await expect(retainedSourceType()).resolves.toMatchObject({
          sourceType: 'inferred',
          trustScore: 0.3,
        });
      },
    );

    it('honors ENGRAM_PI_AUTO_RETAIN_NONINTERACTIVE_SOURCE_TYPE override', async () => {
      _setAutoRetainConfigForTesting({
        nonInteractiveSourceType: 'user_stated',
      });
      const fp = makeFakePi();
      engramPiExtension(fp.pi);
      await fireMessage(
        fp,
        { role: 'user', content: CONTENT },
        { mode: 'print' },
      );
      await expect(retainedSourceType()).resolves.toMatchObject({
        sourceType: 'user_stated',
        trustScore: 0.7,
      });
    });

    it('never downgrades non-user roles regardless of mode', async () => {
      const fp = makeFakePi();
      engramPiExtension(fp.pi);
      await fireMessage(
        fp,
        { role: 'toolResult', content: 'npm test => 59 passing, 0 failing' },
        { mode: 'print' },
      );
      const response = await recall(engram!, {
        query: 'npm test passing',
        topK: 1,
      });
      expect(response.results[0]).toMatchObject({
        sourceType: 'tool_result',
        trustScore: 0.4,
      });
    });
  });

  describe('job/cron prompt detection (D3-gate, tasks/todo.md Decision 2a)', () => {
    const JOB_CONTENT =
      'Process the retain queue. Execute: bash scripts/run-retain-batch.sh';

    async function retainedSourceType(
      query: string,
    ): Promise<{ sourceType: string; trustScore: number }> {
      const response = await recall(engram!, { query, topK: 1 });
      expect(response.results).toHaveLength(1);
      return response.results[0];
    }

    it('downgrades a job/cron-shaped user prompt to tool_result/0.4 in tui mode', async () => {
      const fp = makeFakePi();
      engramPiExtension(fp.pi);
      await fireMessage(
        fp,
        { role: 'user', content: JOB_CONTENT },
        { mode: 'tui' },
      );
      await expect(retainedSourceType(JOB_CONTENT)).resolves.toMatchObject({
        sourceType: 'tool_result',
        trustScore: 0.4,
      });
    });

    it('downgrades a job/cron-shaped user prompt even with no ctx.mode (back-compat default)', async () => {
      const fp = makeFakePi();
      engramPiExtension(fp.pi);
      await fireMessage(fp, { role: 'user', content: JOB_CONTENT }, {});
      await expect(retainedSourceType(JOB_CONTENT)).resolves.toMatchObject({
        sourceType: 'tool_result',
        trustScore: 0.4,
      });
    });

    it('downgrades a job/cron-shaped user prompt to tool_result even in print mode (not inferred)', async () => {
      const fp = makeFakePi();
      engramPiExtension(fp.pi);
      await fireMessage(
        fp,
        { role: 'user', content: JOB_CONTENT },
        { mode: 'print' },
      );
      // Without the job-prompt check this would land on the non-interactive
      // 'inferred'/0.3 path instead — assert the job check takes priority.
      await expect(retainedSourceType(JOB_CONTENT)).resolves.toMatchObject({
        sourceType: 'tool_result',
        trustScore: 0.4,
      });
    });

    it.each([
      'Process the notifications queue. Execute: curl -X POST https://internal/hook',
      'Running scheduled job: nightly backup rotation',
      'cron task: rotate logs and prune old snapshots',
    ])('downgrades known job/cron shape: %s', async (content) => {
      const fp = makeFakePi();
      engramPiExtension(fp.pi);
      await fireMessage(fp, { role: 'user', content }, { mode: 'tui' });
      await expect(retainedSourceType(content)).resolves.toMatchObject({
        sourceType: 'tool_result',
        trustScore: 0.4,
      });
    });

    it('does not downgrade a genuine user message that merely mentions "queue"', async () => {
      const fp = makeFakePi();
      engramPiExtension(fp.pi);
      const content = 'can you check why the deploy queue is backed up today?';
      await fireMessage(fp, { role: 'user', content }, { mode: 'tui' });
      await expect(retainedSourceType(content)).resolves.toMatchObject({
        sourceType: 'user_stated',
        trustScore: 0.7,
      });
    });
  });
});
