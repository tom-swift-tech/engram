// =============================================================================
// smoke-extension.test.ts — verifies the default-exported factory registers
// the commands and tools we expect, with the right names and parameter
// schemas. Does not actually run any of them — that's adapter.test.ts.
//
// Uses a hand-rolled fake ExtensionAPI that only captures registrations.
// Faithful to Pi's signatures via @earendil-works/pi-coding-agent types
// where they're easy to satisfy; cast to `unknown as ExtensionAPI` for the
// unused surface area to keep this test honest about what's covered.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import engramPiExtension from '../src/index.js';

interface CapturedCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface CapturedTool {
  name: string;
  label?: string;
  description: string;
  parameters: { type: string; properties?: Record<string, unknown>; required?: string[] };
  execute: (...args: unknown[]) => Promise<unknown>;
}

interface CapturedHandler {
  event: string;
  handler: (event: unknown, ctx: unknown) => unknown;
}

function makeFakePi(): {
  pi: ExtensionAPI;
  commands: CapturedCommand[];
  tools: CapturedTool[];
  handlers: CapturedHandler[];
} {
  const commands: CapturedCommand[] = [];
  const tools: CapturedTool[] = [];
  const handlers: CapturedHandler[] = [];

  const fake = {
    registerCommand: vi.fn((name: string, def: Omit<CapturedCommand, 'name'>) => {
      commands.push({ name, ...def });
    }),
    registerTool: vi.fn((def: CapturedTool) => {
      tools.push(def);
    }),
    on: vi.fn((event: string, handler: CapturedHandler['handler']) => {
      handlers.push({ event, handler });
    }),
    // Methods referenced indirectly or unused by our extension — provided as
    // no-op spies so any future drift fails loudly rather than silently.
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
  };
}

describe('engram-pi extension factory', () => {
  it('registers the five documented slash commands', () => {
    const { pi, commands } = makeFakePi();
    engramPiExtension(pi);

    const names = commands.map((c) => c.name).sort();
    expect(names).toEqual(['forget', 'memory', 'recall', 'remember', 'session']);

    for (const cmd of commands) {
      expect(typeof cmd.description).toBe('string');
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(typeof cmd.handler).toBe('function');
    }
  });

  it('registers the seven documented LLM tools with engram_ prefix', () => {
    const { pi, tools } = makeFakePi();
    engramPiExtension(pi);

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'engram_forget',
      'engram_memory_stats',
      'engram_recall',
      'engram_remember',
      'engram_session_resume',
      'engram_session_snapshot',
      'engram_session_update',
    ]);

    for (const t of tools) {
      expect(t.name.startsWith('engram_')).toBe(true);
      expect(typeof t.description).toBe('string');
      expect(t.parameters.type).toBe('object');
      expect(typeof t.execute).toBe('function');
    }
  });

  it('engram_remember requires a text parameter', () => {
    const { pi, tools } = makeFakePi();
    engramPiExtension(pi);
    const tool = tools.find((t) => t.name === 'engram_remember');
    expect(tool).toBeDefined();
    expect(tool!.parameters.required).toContain('text');
  });

  it('engram_forget requires a chunkId matching chk- prefix', () => {
    const { pi, tools } = makeFakePi();
    engramPiExtension(pi);
    const tool = tools.find((t) => t.name === 'engram_forget');
    expect(tool).toBeDefined();
    expect(tool!.parameters.required).toContain('chunkId');
    const chunkIdSchema = tool!.parameters.properties?.chunkId as
      | { pattern?: string }
      | undefined;
    expect(chunkIdSchema?.pattern).toBe('^chk-');
  });

  it('subscribes to session_start, session_shutdown, before_agent_start, and turn_end lifecycle events', () => {
    const { pi, handlers } = makeFakePi();
    engramPiExtension(pi);
    const events = handlers.map((h) => h.event).sort();
    expect(events).toEqual([
      'before_agent_start',
      'session_shutdown',
      'session_start',
      'turn_end',
    ]);
  });

  it('engram_session_resume requires a message parameter', () => {
    const { pi, tools } = makeFakePi();
    engramPiExtension(pi);
    const tool = tools.find((t) => t.name === 'engram_session_resume');
    expect(tool).toBeDefined();
    expect(tool!.parameters.required).toContain('message');
  });

  it('engram_session_update and snapshot require a sessionId matching wm- prefix', () => {
    const { pi, tools } = makeFakePi();
    engramPiExtension(pi);
    for (const name of ['engram_session_update', 'engram_session_snapshot']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `tool ${name} should be registered`).toBeDefined();
      expect(tool!.parameters.required).toContain('sessionId');
      const idSchema = tool!.parameters.properties?.sessionId as
        | { pattern?: string }
        | undefined;
      expect(idSchema?.pattern).toBe('^wm-');
    }
  });

  it('before_agent_start handler returns a systemPrompt containing the session addendum', () => {
    const { pi, handlers } = makeFakePi();
    engramPiExtension(pi);
    const handler = handlers.find((h) => h.event === 'before_agent_start');
    expect(handler).toBeDefined();
    const result = handler!.handler(
      { type: 'before_agent_start', prompt: 'hi', systemPrompt: 'BASE' },
      {},
    ) as { systemPrompt?: string } | undefined;
    expect(result?.systemPrompt).toContain('BASE');
    expect(result?.systemPrompt).toContain('engram_session_resume');
    expect(result?.systemPrompt).toContain('engram_session_update');
    expect(result?.systemPrompt).toContain('engram_session_snapshot');
  });
});
