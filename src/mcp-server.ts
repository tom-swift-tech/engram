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

// ─── CLI Args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dbPath = args.find(a => !a.startsWith('--'));

if (!dbPath) {
  console.error('Usage: engram-mcp <path-to-engram-file> [options]');
  console.error('');
  console.error('Options:');
  console.error('  --ollama-url <url>          Ollama endpoint (default: http://localhost:11434)');
  console.error('  --use-ollama-embeddings     Use Ollama for embeddings instead of local Transformers.js');
  console.error('  --reflect-model <model>     LLM for extraction + reflection (default: llama3.1:8b)');
  console.error('  --generation-endpoint <url> OpenAI-compatible endpoint for generation');
  console.error('  --generation-model <model>  Model for OpenAI-compatible generation');
  console.error('  --generation-api-key <key>  API key for generation endpoint');
  console.error('  --anthropic-api-key <key>   Anthropic API key (uses Claude for generation)');
  console.error('  --anthropic-model <model>   Anthropic model (default: claude-haiku-4-5-20251001)');
  process.exit(1);
}

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const ollamaUrl = getArg('--ollama-url') ?? DEFAULT_OLLAMA_URL;
const useOllamaEmbeddings = args.includes('--use-ollama-embeddings');
const reflectModel = getArg('--reflect-model') ?? 'llama3.1:8b';
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
    reflectModel,
  };

  if (anthropicApiKey) {
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
  }

  const engram = await Engram.open(dbPath!, engramOptions);

  const handleTool = createEngramToolHandler(engram);

  const server = new Server(
    {
      name: 'engram',
      version: '0.1.0',
      description: 'Memory system for AI agents. All parameters use camelCase (memoryType, trustScore, sourceType). Store facts with engram_retain, search with engram_recall (temporal queries like "last week" auto-activate date filtering), manage sessions with engram_session.',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ENGRAM_TOOLS.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    return handleTool(
      name as EngramToolName,
      (toolArgs ?? {}) as Record<string, unknown>
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
  console.error(`[engram-mcp] Ollama: ${ollamaUrl} | Ollama embeddings: ${useOllamaEmbeddings}`);
  console.error(`[engram-mcp] ${ENGRAM_TOOLS.length} tools registered`);
}

main().catch(err => {
  console.error('[engram-mcp] Fatal:', err);
  process.exit(1);
});
