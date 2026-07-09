// =============================================================================
// surface-parity.test.ts — MCP ↔ CLI surface drift guard
//
// The repo's contract (CLAUDE.md "CLI transport" decision) is one kebab-cased
// CLI subcommand per engram_* MCP tool, so skills/cli-memory/SKILL.md maps 1:1
// to the MCP tool surface. This suite makes that contract a test failure
// instead of a docs promise: it broke silently once already, when engram_embed
// (AQL Phase 2a) landed with no CLI twin and the "9 tools" docs went stale.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { ENGRAM_TOOLS } from '../src/mcp-tools.js';
import { CLI_COMMANDS } from '../src/cli-args.js';
import { runCli, type CliIO } from '../src/cli.js';
import {
  MockEmbedder,
  MockGenerator,
  EXTRACTION_RESPONSE,
  tmpDbPath,
  cleanupDb,
} from './helpers.js';

/** engram_queue_stats → queue-stats */
function toolToCommand(toolName: string): string {
  return toolName.replace(/^engram_/, '').replace(/_/g, '-');
}

describe('MCP ↔ CLI surface parity', () => {
  it('every MCP tool has exactly one kebab-cased CLI twin, and vice versa', () => {
    const fromTools = ENGRAM_TOOLS.map((t) => toolToCommand(t.name)).sort();
    const fromCli = [...CLI_COMMANDS].sort();
    expect(fromCli).toEqual(fromTools);
  });

  it('tool count is pinned — when this fails, update the docs that state the count (CLAUDE.md, AGENTS.md, README, skills/engram.md, skills/cli-memory/SKILL.md) along with CLI_COMMANDS', () => {
    expect(ENGRAM_TOOLS.length).toBe(10);
    expect(CLI_COMMANDS.length).toBe(10);
  });

  it('cli.ts dispatch handles every declared command (none fall through to unknown-command)', async () => {
    const dbPath = tmpDbPath();
    try {
      for (const cmd of CLI_COMMANDS) {
        const err: string[] = [];
        const io: CliIO = {
          stdout: () => {},
          stderr: (s) => err.push(s),
          readStdin: async () => '',
        };
        // Commands with a required text arg exit 1 ("missing required
        // argument") on empty stdin — that's fine; only the unknown-command
        // branch means the CLI_COMMANDS list drifted from the switch.
        await runCli([cmd, '--db', dbPath], io, {
          embedder: new MockEmbedder(),
          generator: new MockGenerator(EXTRACTION_RESPONSE),
        });
        expect(
          err.join(''),
          `command "${cmd}" hit the unknown-command branch`,
        ).not.toContain('unknown command');
      }
    } finally {
      cleanupDb(dbPath);
    }
  });
});
