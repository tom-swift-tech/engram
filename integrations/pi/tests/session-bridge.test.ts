// =============================================================================
// session-bridge.test.ts — end-to-end binding test for the engram_session_*
// tools, the before_agent_start addendum, and the /session slash command.
//
// Uses a fake ExtensionAPI that actually runs handlers so we can observe
// currentSessionId lifecycle and /session output. The Engram instance is
// real (in-memory SQLite + deterministic embedder) and injected via the
// _setEngineFactoryForTesting hook so we don't pay the model download.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Engram, type EmbeddingProvider } from 'engram';

import engramPiExtension, {
  _setEngineFactoryForTesting,
  _resetEngineFactoryForTesting,
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

interface CapturedCommand {
  name: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
    details?: unknown;
  }>;
}

interface CapturedHandler {
  event: string;
  handler: (event: unknown, ctx: unknown) => unknown;
}

function makeFakePi(): {
  pi: ExtensionAPI;
  commands: Map<string, CapturedCommand>;
  tools: Map<string, CapturedTool>;
  handlers: Map<string, CapturedHandler['handler']>;
  notifications: string[];
} {
  const commands = new Map<string, CapturedCommand>();
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, CapturedHandler['handler']>();
  const notifications: string[] = [];

  const ui = {
    notify: (msg: string) => {
      notifications.push(msg);
    },
    confirm: vi.fn(async () => true),
  };
  const ctx = {
    hasUI: true,
    ui,
  };

  const fake = {
    registerCommand: vi.fn(
      (
        name: string,
        def: {
          description: string;
          handler: (args: string, ctx: unknown) => Promise<void>;
        },
      ) => {
        commands.set(name, {
          name,
          handler: (args: string) => def.handler(args, ctx),
        });
      },
    ),
    registerTool: vi.fn((def: CapturedTool) => {
      tools.set(def.name, def);
    }),
    on: vi.fn((event: string, handler: CapturedHandler['handler']) => {
      handlers.set(event, handler);
    }),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
    appendEntry: vi.fn(),
  };

  return {
    pi: fake as unknown as ExtensionAPI,
    commands,
    tools,
    handlers,
    notifications,
  };
}

describe('session bridge binding', () => {
  beforeEach(() => {
    _setEngineFactoryForTesting(async () =>
      Engram.create(':memory:', { embedder: new TestEmbedder() }),
    );
  });

  afterEach(() => {
    _resetEngineFactoryForTesting();
  });

  it('engram_session_resume sets currentSessionId and /session reflects it', async () => {
    const { pi, tools, commands, notifications } = makeFakePi();
    engramPiExtension(pi);

    const resume = tools.get('engram_session_resume')!;
    const result = await resume.execute('call-1', {
      message: 'refactor the auth middleware',
    });
    expect(result.isError).toBeUndefined();
    const details = result.details as { sessionId: string; reason: string };
    expect(details.sessionId).toMatch(/^wm-/);
    expect(details.reason).toBe('new');

    const session = commands.get('session')!;
    await session.handler('');
    const out = notifications.join('\n');
    expect(out).toContain(`Current: ${details.sessionId}`);
    expect(out).toContain('refactor the auth middleware');
  });

  it('engram_session_update merges progress and keeps currentSessionId set', async () => {
    const { pi, tools, commands, notifications } = makeFakePi();
    engramPiExtension(pi);

    const resume = tools.get('engram_session_resume')!;
    const r = await resume.execute('call-1', {
      message: 'plan the production rollout',
    });
    const sessionId = (r.details as { sessionId: string }).sessionId;

    const update = tools.get('engram_session_update')!;
    const u = await update.execute('call-2', {
      sessionId,
      progress: 'Drafted the rollback plan',
    });
    expect(u.isError).toBeUndefined();

    const session = commands.get('session')!;
    await session.handler('');
    const out = notifications.at(-1) ?? '';
    expect(out).toContain('Progress: Drafted the rollback plan');
  });

  it('engram_session_snapshot clears currentSessionId on the snapshotted id', async () => {
    const { pi, tools, commands, notifications } = makeFakePi();
    engramPiExtension(pi);

    const resume = tools.get('engram_session_resume')!;
    const r = await resume.execute('call-1', { message: 'audit dependencies' });
    const sessionId = (r.details as { sessionId: string }).sessionId;

    const snapshot = tools.get('engram_session_snapshot')!;
    const s = await snapshot.execute('call-2', { sessionId });
    expect(s.isError).toBeUndefined();
    const sDetails = s.details as { chunkId: string };
    expect(sDetails.chunkId).toMatch(/^chk-/);

    const session = commands.get('session')!;
    await session.handler('');
    const out = notifications.at(-1) ?? '';
    expect(out).toContain('No active session');
  });

  it('engram_session_update returns isError on unknown sessionId', async () => {
    const { pi, tools } = makeFakePi();
    engramPiExtension(pi);

    const update = tools.get('engram_session_update')!;
    const result = await update.execute('call-1', {
      sessionId: 'wm-does-not-exist',
      progress: 'this should fail',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Update failed/);
  });

  it('engram_session_snapshot returns isError on unknown sessionId', async () => {
    const { pi, tools } = makeFakePi();
    engramPiExtension(pi);

    const snapshot = tools.get('engram_session_snapshot')!;
    const result = await snapshot.execute('call-1', {
      sessionId: 'wm-does-not-exist',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Snapshot failed/);
  });
});
