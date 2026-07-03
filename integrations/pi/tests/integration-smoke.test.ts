// =============================================================================
// integration-smoke.test.ts — full end-to-end smoke through the extension
// binding layer.
//
// Loads the built dist/index.js (the artifact Pi actually loads), invokes the
// factory with a faithful fake ExtensionAPI that captures handlers, then
// drives every command and LLM tool against a real Engram instance backed by
// a temp .engram/pi.db inside a temp project directory.
//
// What this catches that adapter.test.ts and smoke-extension.test.ts don't:
//   - The lazy getEngram() opener and its mkdir + cwd resolution
//   - The notifyOrLog stderr fallback in non-UI contexts
//   - formatRecallResults output structure
//   - The /forget command's chunkId-vs-query routing
//   - LLM tool execute() return shape (content[], details)
//   - session_start and session_shutdown wiring
// =============================================================================

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Capture handlers/registrations
interface Captured {
  commands: Map<
    string,
    { description: string; handler: (args: string, ctx: unknown) => Promise<void> }
  >;
  tools: Map<
    string,
    {
      description: string;
      parameters: { required?: string[]; properties?: Record<string, unknown> };
      execute: (
        toolCallId: string,
        params: unknown,
        signal?: unknown,
        onUpdate?: unknown,
        ctx?: unknown,
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        details: unknown;
      }>;
    }
  >;
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
}

interface FakeUi {
  notifications: Array<{ message: string; level: string }>;
  confirmAnswer: boolean;
  notify: (msg: string, level: string) => void;
  confirm: (title: string, body: string) => Promise<boolean>;
}

function makeFakeUi(confirmAnswer = true): FakeUi {
  const notifications: FakeUi['notifications'] = [];
  return {
    notifications,
    confirmAnswer,
    notify(msg, level) {
      notifications.push({ message: msg, level });
    },
    async confirm() {
      return this.confirmAnswer;
    },
  };
}

function makeCtx(ui: FakeUi, hasUI = true): unknown {
  return { hasUI, ui };
}

function makePi(captured: Captured): unknown {
  return {
    registerCommand: (name: string, def: unknown) => {
      captured.commands.set(
        name,
        def as { description: string; handler: (args: string, ctx: unknown) => Promise<void> },
      );
    },
    registerTool: (def: unknown) => {
      const t = def as {
        name: string;
        description: string;
        parameters: { required?: string[]; properties?: Record<string, unknown> };
        execute: (
          toolCallId: string,
          params: unknown,
        ) => Promise<{
          content: Array<{ type: string; text: string }>;
          details: unknown;
        }>;
      };
      captured.tools.set(t.name, t);
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      captured.handlers.set(event, handler);
    },
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
    appendEntry: vi.fn(),
  };
}

// Static path to the built extension. The build:pi step writes here.
const EXTENSION_DIST = join(__dirname, '..', 'dist', 'index.js');

// Deterministic embedder so the integration test doesn't trigger the
// ~150MB Transformers.js model download and works in sandboxed CI.
class TestEmbedder {
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

describe('engram-pi integration smoke (built dist + real Engram)', () => {
  let projectDir: string;
  let originalCwd: string;
  let captured: Captured;
  let factory: (pi: unknown) => void;
  let setEngineFactoryForTesting: (
    f: (path: string) => Promise<unknown>,
  ) => void;
  let resetEngineFactoryForTesting: () => void;
  let EngramCtor: { open(path: string, opts?: unknown): Promise<unknown> };

  beforeAll(async () => {
    if (!existsSync(EXTENSION_DIST)) {
      throw new Error(
        `Built extension not found at ${EXTENSION_DIST}. Run 'npm run build' in integrations/pi first.`,
      );
    }
    const mod = (await import(EXTENSION_DIST)) as {
      default: (pi: unknown) => void;
      _setEngineFactoryForTesting: (
        f: (path: string) => Promise<unknown>,
      ) => void;
      _resetEngineFactoryForTesting: () => void;
    };
    factory = mod.default;
    setEngineFactoryForTesting = mod._setEngineFactoryForTesting;
    resetEngineFactoryForTesting = mod._resetEngineFactoryForTesting;

    // Import Engram via the alias resolved by vitest config (../../dist/engram.js).
    EngramCtor = (await import('engram' as string)) as unknown as {
      Engram: typeof EngramCtor;
    } & { open: typeof EngramCtor.open };
    // Defensive — `engram` package exports the class as a named export
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    EngramCtor = ((await import('engram' as string)) as any).Engram;
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'engram-pi-smoke-'));
    process.chdir(projectDir);
    captured = {
      commands: new Map(),
      tools: new Map(),
      handlers: new Map(),
    };

    // Inject a factory that opens Engram with our deterministic embedder.
    // This avoids the ~150MB Transformers.js model download.
    setEngineFactoryForTesting(async (path: string) => {
      return EngramCtor.open(path, { embedder: new TestEmbedder() });
    });

    factory(makePi(captured));
  });

  afterEach(async () => {
    // Fire session_shutdown so the extension closes its Engram instance and
    // releases the SQLite file before we rmSync the temp dir on Windows
    // (where open handles block deletion).
    const shutdown = captured?.handlers.get('session_shutdown');
    if (shutdown) {
      await shutdown({}, makeCtx(makeFakeUi()));
    }
    resetEngineFactoryForTesting?.();
    if (originalCwd) process.chdir(originalCwd);
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; tmp dir cleaner will get it eventually.
    }
  });

  afterAll(() => {
    // No-op; here for symmetry if we add module-level state later.
  });

  it('registers five commands, seven tools, and five lifecycle handlers', () => {
    expect([...captured.commands.keys()].sort()).toEqual([
      'forget',
      'memory',
      'recall',
      'remember',
      'session',
    ]);
    expect([...captured.tools.keys()].sort()).toEqual([
      'engram_forget',
      'engram_memory_stats',
      'engram_recall',
      'engram_remember',
      'engram_session_resume',
      'engram_session_snapshot',
      'engram_session_update',
    ]);
    expect([...captured.handlers.keys()].sort()).toEqual([
      'before_agent_start',
      'message_end',
      'session_shutdown',
      'session_start',
      'turn_end',
    ]);
  });

  it('session_start notifies and the DB path is created lazily on first use', async () => {
    const ui = makeFakeUi();
    const start = captured.handlers.get('session_start')!;
    await start({}, makeCtx(ui));

    expect(ui.notifications.length).toBeGreaterThan(0);
    expect(ui.notifications[0].message).toContain('Engram extension ready');

    // DB doesn't exist yet — opening is lazy
    expect(existsSync(join(projectDir, '.engram', 'pi.db'))).toBe(false);

    // Trigger lazy open via /memory
    const ui2 = makeFakeUi();
    await captured.commands.get('memory')!.handler('', makeCtx(ui2));
    expect(existsSync(join(projectDir, '.engram', 'pi.db'))).toBe(true);
  });

  it('fresh session (reason: "new"): before_agent_start injects starting context from prior memory', async () => {
    // Seed memory in a "previous session" before the fresh one starts.
    await captured.commands.get('remember')!.handler(
      'The staging cluster runs on Talos Linux, fronted by an nginx ingress',
      makeCtx(makeFakeUi()),
    );

    const start = captured.handlers.get('session_start')!;
    await start({ type: 'session_start', reason: 'new' }, makeCtx(makeFakeUi()));

    const beforeAgentStart = captured.handlers.get('before_agent_start')!;
    const result = (await beforeAgentStart(
      {
        type: 'before_agent_start',
        prompt: 'what does the staging cluster run on?',
        systemPrompt: 'BASE PROMPT',
      },
      makeCtx(makeFakeUi()),
    )) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).toContain('BASE PROMPT');
    expect(result?.systemPrompt).toContain('## Relevant memory from prior work');
    expect(result?.systemPrompt).toContain('Talos Linux');
    // Still appends the session addendum — startup recall is additive, not a replacement.
    expect(result?.systemPrompt).toContain('engram_session_resume');
  });

  it('fresh session: startup recall only fires on the first before_agent_start, not later turns', async () => {
    await captured.commands.get('remember')!.handler(
      'The staging cluster runs on Talos Linux',
      makeCtx(makeFakeUi()),
    );

    const start = captured.handlers.get('session_start')!;
    await start({ type: 'session_start', reason: 'new' }, makeCtx(makeFakeUi()));

    const beforeAgentStart = captured.handlers.get('before_agent_start')!;
    const first = (await beforeAgentStart(
      { type: 'before_agent_start', prompt: 'staging cluster os?', systemPrompt: 'TURN 1' },
      makeCtx(makeFakeUi()),
    )) as { systemPrompt?: string } | undefined;
    expect(first?.systemPrompt).toContain('## Relevant memory from prior work');

    const second = (await beforeAgentStart(
      { type: 'before_agent_start', prompt: 'staging cluster os?', systemPrompt: 'TURN 2' },
      makeCtx(makeFakeUi()),
    )) as { systemPrompt?: string } | undefined;
    expect(second?.systemPrompt).toContain('TURN 2');
    expect(second?.systemPrompt).not.toContain('## Relevant memory from prior work');
  });

  it('resumed session (reason: "resume"): before_agent_start does not inject starting context', async () => {
    await captured.commands.get('remember')!.handler(
      'The staging cluster runs on Talos Linux',
      makeCtx(makeFakeUi()),
    );

    const start = captured.handlers.get('session_start')!;
    await start({ type: 'session_start', reason: 'resume' }, makeCtx(makeFakeUi()));

    const beforeAgentStart = captured.handlers.get('before_agent_start')!;
    const result = (await beforeAgentStart(
      {
        type: 'before_agent_start',
        prompt: 'what does the staging cluster run on?',
        systemPrompt: 'BASE PROMPT',
      },
      makeCtx(makeFakeUi()),
    )) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).toContain('BASE PROMPT');
    expect(result?.systemPrompt).not.toContain('## Relevant memory from prior work');
    // Addendum still present — only the recall injection is reason-gated.
    expect(result?.systemPrompt).toContain('engram_session_resume');
  });

  it('round-trip: /remember then /recall finds the stored fact', async () => {
    const rememberUi = makeFakeUi();
    await captured.commands.get('remember')!.handler(
      'The staging cluster runs on Talos Linux',
      makeCtx(rememberUi),
    );
    const stored = rememberUi.notifications.find((n) =>
      n.message.startsWith('Stored chk-'),
    );
    expect(stored).toBeDefined();

    const recallUi = makeFakeUi();
    await captured.commands.get('recall')!.handler(
      'staging cluster',
      makeCtx(recallUi),
    );
    const recallOutput = recallUi.notifications.map((n) => n.message).join('\n');
    expect(recallOutput).toContain('Talos Linux');
  });

  it('/memory reports non-zero counts after a remember', async () => {
    await captured.commands.get('remember')!.handler(
      'fact one for stats test',
      makeCtx(makeFakeUi()),
    );
    const ui = makeFakeUi();
    await captured.commands.get('memory')!.handler('', makeCtx(ui));
    const out = ui.notifications.map((n) => n.message).join('\n');
    expect(out).toContain('chunks:       1');
    expect(out).toContain('extraction queue: 1 pending');
  });

  it('/forget chk-id deletes directly without prompting', async () => {
    const rememberUi = makeFakeUi();
    await captured.commands.get('remember')!.handler(
      'an ephemeral note',
      makeCtx(rememberUi),
    );
    const stored = rememberUi.notifications.find((n) =>
      n.message.startsWith('Stored chk-'),
    )!.message;
    const chunkId = stored.replace('Stored ', '').trim();

    const forgetUi = makeFakeUi(false); // confirm would be NO if asked
    await captured.commands.get('forget')!.handler(chunkId, makeCtx(forgetUi));

    // No confirm prompt for direct ID deletes
    expect(
      forgetUi.notifications.some((n) =>
        n.message.includes(`Forgot ${chunkId}`),
      ),
    ).toBe(true);
  });

  it('/forget <query> asks for confirmation and respects yes', async () => {
    await captured.commands.get('remember')!.handler(
      'a deletable observation about pipelines',
      makeCtx(makeFakeUi()),
    );
    const ui = makeFakeUi(true); // confirm yes
    await captured.commands.get('forget')!.handler(
      'deletable observation pipelines',
      makeCtx(ui),
    );
    expect(ui.notifications.some((n) => n.message.startsWith('Forgot chk-'))).toBe(
      true,
    );
  });

  it('/forget <query> respects no (cancellation)', async () => {
    await captured.commands.get('remember')!.handler(
      'a precious memory I do not want erased',
      makeCtx(makeFakeUi()),
    );
    const ui = makeFakeUi(false); // confirm no
    await captured.commands.get('forget')!.handler(
      'precious memory',
      makeCtx(ui),
    );
    expect(ui.notifications.some((n) => n.message === 'Forget cancelled.')).toBe(
      true,
    );

    // Verify the chunk still exists via recall
    const recallUi = makeFakeUi();
    await captured.commands.get('recall')!.handler(
      'precious memory',
      makeCtx(recallUi),
    );
    const out = recallUi.notifications.map((n) => n.message).join('\n');
    expect(out).toContain('precious');
  });

  it('engram_remember LLM tool returns the documented shape', async () => {
    const tool = captured.tools.get('engram_remember')!;
    const result = await tool.execute(
      'tool-call-1',
      { text: 'agent-stored fact via LLM tool' },
      undefined,
      undefined,
      makeCtx(makeFakeUi()),
    );
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toMatch(/^Stored chk-/);
    expect(result.details).toMatchObject({
      chunkId: expect.stringMatching(/^chk-/),
      deduplicated: false,
    });
  });

  it('engram_recall LLM tool returns strategiesUsed and resultCount in details', async () => {
    await captured.commands.get('remember')!.handler(
      'we use Cloudflare Tunnels for ingress',
      makeCtx(makeFakeUi()),
    );
    const tool = captured.tools.get('engram_recall')!;
    const result = await tool.execute(
      'tool-call-2',
      { query: 'Cloudflare ingress', topK: 3 },
      undefined,
      undefined,
      makeCtx(makeFakeUi()),
    );
    expect(result.content[0].text).toContain('Cloudflare Tunnels');
    expect(result.details).toMatchObject({
      resultCount: expect.any(Number),
      strategiesUsed: expect.any(Array),
    });
  });

  it('engram_forget LLM tool succeeds for a known id and reports failure for an unknown id', async () => {
    const rememberUi = makeFakeUi();
    await captured.commands.get('remember')!.handler(
      'a fact to forget via tool',
      makeCtx(rememberUi),
    );
    const chunkId = rememberUi.notifications[0].message
      .replace('Stored ', '')
      .trim();

    const tool = captured.tools.get('engram_forget')!;
    const ok = await tool.execute(
      't',
      { chunkId },
      undefined,
      undefined,
      makeCtx(makeFakeUi()),
    );
    expect(ok.details).toMatchObject({ chunkId, forgotten: true });

    const miss = await tool.execute(
      't',
      { chunkId: 'chk-does-not-exist' },
      undefined,
      undefined,
      makeCtx(makeFakeUi()),
    );
    expect(miss.details).toMatchObject({
      chunkId: 'chk-does-not-exist',
      forgotten: false,
    });
  });

  it('non-UI mode: notifications fall through to stderr without throwing', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctxNoUi = makeCtx(makeFakeUi(), false);
    await captured.commands.get('remember')!.handler(
      'no-ui mode fact',
      ctxNoUi,
    );
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('non-UI mode refuses /forget by query (would need confirmation)', async () => {
    await captured.commands.get('remember')!.handler(
      'protected from headless deletes',
      makeCtx(makeFakeUi()),
    );
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctxNoUi = makeCtx(makeFakeUi(), false);
    await captured.commands.get('forget')!.handler(
      'protected from headless',
      ctxNoUi,
    );
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stderrCalls).toContain('Refusing to forget by query');
    stderrSpy.mockRestore();
  });
});
