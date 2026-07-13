#!/usr/bin/env node
// =============================================================================
// mcp-server.ts — Standalone MCP stdio server for Engram
//
// Launches an MCP server over stdin/stdout that exposes Engram's memory
// tools to any MCP-compatible client (Claude Code, Claude Desktop, Cursor, etc.)
//
// Usage:
//   npx engram-mcp ./path/to/agent.engram
//   npx engram-mcp ./agent.engram --ollama-url http://localhost:11434
//   npx engram-mcp ./agent.engram --use-ollama-embeddings
// =============================================================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Engram, DEFAULT_OLLAMA_URL } from './engram.js';
import { ENGRAM_TOOLS, createEngramToolHandler } from './mcp-tools.js';
import type { EngramToolName } from './mcp-tools.js';
import {
  resolveModelSpecOrNull,
  preflightModel,
  formatPreflightFailure,
  type ModelSpec,
} from './model-resolver.js';

// ─── CLI Args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith('--'));

if (!dbPath) {
  console.error('Usage: engram-mcp <path-to-engram-file> [options]');
  console.error('');
  console.error('Options:');
  console.error(
    '  --ollama-url <url>          Ollama endpoint (default: http://localhost:11434)',
  );
  console.error(
    '  --use-ollama-embeddings     Use Ollama for embeddings instead of local Transformers.js',
  );
  console.error(
    '  --reflect-model <model>     LLM for extraction + reflection (or ENGRAM_MODEL; no default)',
  );
  console.error(
    '  --generation-endpoint <url> OpenAI-compatible endpoint for generation',
  );
  console.error(
    '  --generation-model <model>  Model for OpenAI-compatible generation',
  );
  console.error(
    '  --generation-api-key <key>  API key for generation endpoint',
  );
  console.error(
    '  --anthropic-api-key <key>   Anthropic API key (uses Claude for generation)',
  );
  console.error(
    '  --anthropic-model <model>   Anthropic model (required with --anthropic-api-key)',
  );
  process.exit(1);
}

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const ollamaUrl = getArg('--ollama-url') ?? DEFAULT_OLLAMA_URL;
const useOllamaEmbeddings = args.includes('--use-ollama-embeddings');
const generationEndpointUrl = getArg('--generation-endpoint');
const generationModel = getArg('--generation-model');
const generationApiKey = getArg('--generation-api-key');
const anthropicApiKey = getArg('--anthropic-api-key');
const anthropicModel = getArg('--anthropic-model');

// ─── Server Setup ───────────────────────────────────────────────────────────

async function main() {
  const engramOptions: Parameters<typeof Engram.open>[1] = {
    ollamaUrl,
    useOllamaEmbeddings,
  };

  // Ollama-model spec (resolved once) — kept for the startup preflight below.
  // Only meaningful on the default Ollama path.
  let ollamaSpec: ModelSpec | null = null;

  if (anthropicApiKey) {
    if (!anthropicModel || !anthropicModel.trim()) {
      console.error(
        'engram-mcp: --anthropic-api-key requires --anthropic-model — no default model.',
      );
      process.exit(1);
    }
    engramOptions.anthropicGeneration = {
      apiKey: anthropicApiKey,
      model: anthropicModel,
    };
  } else if (generationEndpointUrl && generationModel) {
    engramOptions.generationEndpoint = {
      baseUrl: generationEndpointUrl,
      model: generationModel,
      apiKey: generationApiKey,
    };
  } else {
    // Ollama path: choose the model through the single resolver (no default).
    // Leave reflectModel unset when unconfigured — the engram opens with a
    // fail-loud UnconfiguredGeneration, so retain/recall still serve and only
    // reflect/extract error. We surface the state loudly at startup below.
    ollamaSpec = resolveModelSpecOrNull({
      role: 'reflect',
      explicitModel: getArg('--reflect-model'),
      explicitHost: getArg('--ollama-url'),
    });
    if (ollamaSpec) engramOptions.reflectModel = ollamaSpec.model;
  }

  // Startup preflight (Ollama path only). The server is long-lived and may only
  // ever serve retain/recall, so a preflight failure WARNS loudly rather than
  // exiting — but it is never silent, and reflect/extract will still fail loud
  // on use if the model is missing/unserved.
  if (ollamaSpec) {
    const pf = await preflightModel(ollamaSpec);
    if (!pf.ok) {
      console.error(`engram-mcp: ${formatPreflightFailure(pf)}`);
      console.error(
        'engram-mcp: retain/recall will work; reflect/extract will fail until the model is served.',
      );
    }
  } else if (!anthropicApiKey && !(generationEndpointUrl && generationModel)) {
    console.error(
      'engram-mcp: no generation model configured (set --reflect-model or ENGRAM_MODEL). ' +
        'retain/recall work; reflect/extract are disabled until a model is set.',
    );
  }

  const engram = await Engram.open(dbPath!, engramOptions);

  const handleTool = createEngramToolHandler(engram);

  const server = new Server(
    {
      name: 'engram',
      version: '0.1.0',
      description:
        'Memory system for AI agents. All parameters use camelCase (memoryType, trustScore, sourceType). Store facts with engram_retain, search with engram_recall (temporal queries like "last week" auto-activate date filtering), manage sessions with engram_session.',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ENGRAM_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    return handleTool(
      name as EngramToolName,
      (toolArgs ?? {}) as Record<string, unknown>,
    );
  });

  process.on('SIGINT', () => {
    engram.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    engram.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[engram-mcp] Serving ${dbPath} via MCP stdio`);
  console.error(
    `[engram-mcp] Ollama: ${ollamaUrl} | Ollama embeddings: ${useOllamaEmbeddings}`,
  );
  console.error(`[engram-mcp] ${ENGRAM_TOOLS.length} tools registered`);
}

main().catch((err) => {
  console.error('[engram-mcp] Fatal:', err);
  process.exit(1);
});
