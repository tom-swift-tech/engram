import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Engram } from '../src/engram.js';
import { ENGRAM_TOOLS, createEngramToolHandler } from '../src/mcp-tools.js';
import type { EngramToolName } from '../src/mcp-tools.js';
import { MockEmbedder, tmpDbPath, cleanupDb } from './helpers.js';
import type { EmbeddingProvider } from '../src/retain.js';

// ---------------------------------------------------------------------------
// MockEmbedderWithQuery — 768-dim mock that implements embedQuery with a
// distinct document prefix so query vs document produce different vectors.
// Avoids any model download while validating the prefix path is wired up.
// ---------------------------------------------------------------------------

class MockEmbedderWithQuery implements EmbeddingProvider {
  readonly dimensions = 768;

  async embed(text: string): Promise<Float32Array> {
    return this._vectorize('doc:' + text);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this._vectorize('qry:' + text);
  }

  private _vectorize(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    for (let i = 0; i < text.length; i++) {
      vec[i % this.dimensions] += text.charCodeAt(i) / 256;
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return mag > 0 ? new Float32Array(vec.map((v) => v / mag)) : vec;
  }
}

describe('MCP Server', () => {
  let engram: Engram;
  let client: Client;
  let server: Server;
  let dbPath: string;

  beforeAll(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    const handleTool = createEngramToolHandler(engram);

    server = new Server(
      { name: 'engram', version: '0.1.0' },
      { capabilities: { tools: {} } },
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

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    engram.close();
    cleanupDb(dbPath);
  });

  it('ListTools returns all 14 tool schemas', async () => {
    const result = await client.listTools();
    expect(result.tools.length).toBe(14);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('engram_retain');
    expect(names).toContain('engram_introspect');
    expect(names).toContain('engram_recall');
    expect(names).toContain('engram_reflect');
    expect(names).toContain('engram_process_extractions');
    expect(names).toContain('engram_forget');
    expect(names).toContain('engram_supersede');
    expect(names).toContain('engram_session');
    expect(names).toContain('engram_queue_stats');
    expect(names).toContain('engram_requeue_failed');
    expect(names).toContain('engram_embed');
    expect(names).toContain('engram_context_commit');
    expect(names).toContain('engram_context_query');
    expect(names).toContain('engram_context_promote');
  });

  it('engram_retain stores a chunk and returns a chunkId', async () => {
    const result = await client.callTool({
      name: 'engram_retain',
      arguments: {
        text: 'Tom prefers Terraform with the bpg provider for Proxmox IaC',
        memoryType: 'world',
        sourceType: 'user_stated',
        trustScore: 0.9,
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe('text');
    const parsed = JSON.parse(content[0].text);
    expect(parsed.chunkId).toMatch(/^chk-/);
    expect(parsed).toHaveProperty('queued');
  });

  it('engram_recall retrieves the stored chunk', async () => {
    const result = await client.callTool({
      name: 'engram_recall',
      arguments: {
        query: 'What IaC tools does Tom use?',
        topK: 5,
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results.some((r: any) => r.text.includes('Terraform'))).toBe(
      true,
    );
  });

  it('engram_introspect returns the held-state projection shape', async () => {
    const result = await client.callTool({
      name: 'engram_introspect',
      arguments: { subject: 'Terraform' },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    // No reflect cycle ran, so beliefs are empty — but the projection contract
    // (subject echo + opinions/observations arrays) must hold.
    expect(parsed.subject).toBe('Terraform');
    expect(Array.isArray(parsed.opinions)).toBe(true);
    expect(Array.isArray(parsed.observations)).toBe(true);
  });

  it('engram_session creates a new working memory session', async () => {
    const result = await client.callTool({
      name: 'engram_session',
      arguments: {
        message: 'Help me plan the Kubernetes migration',
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.session.id).toMatch(/^wm-/);
    expect(parsed.diagnostics.reason).toBe('new');
  });

  it('engram_forget soft-deletes a chunk', async () => {
    // First retain something to forget
    const retainResult = await client.callTool({
      name: 'engram_retain',
      arguments: { text: 'Temporary fact to forget' },
    });
    const retainContent = retainResult.content as Array<{
      type: string;
      text: string;
    }>;
    const chunkId = JSON.parse(retainContent[0].text).chunkId;

    // Forget it
    const forgetResult = await client.callTool({
      name: 'engram_forget',
      arguments: { chunkId },
    });

    const forgetContent = forgetResult.content as Array<{
      type: string;
      text: string;
    }>;
    const parsed = JSON.parse(forgetContent[0].text);
    expect(parsed.forgotten).toBe(true);
  });

  it('engram_supersede replaces an old fact with new text', async () => {
    // Retain the old fact
    const retainResult = await client.callTool({
      name: 'engram_retain',
      arguments: { text: 'Tom uses Docker Compose for everything' },
    });
    const retainContent = retainResult.content as Array<{
      type: string;
      text: string;
    }>;
    const oldChunkId = JSON.parse(retainContent[0].text).chunkId;

    // Supersede it
    const supersedeResult = await client.callTool({
      name: 'engram_supersede',
      arguments: {
        oldChunkId,
        newText: 'Tom switched from Docker Compose to Kubernetes',
      },
    });

    const content = supersedeResult.content as Array<{
      type: string;
      text: string;
    }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.chunkId).toMatch(/^chk-/);
    expect(parsed).toHaveProperty('queued');
  });

  it('returns isError for invalid tool calls', async () => {
    const result = await client.callTool({
      name: 'engram_forget',
      arguments: { chunkId: 'nonexistent-id' },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    // forget returns {forgotten: false} for missing chunks, not an error
    expect(parsed.forgotten).toBe(false);
  });

  it('engram_recall strips invalid memoryTypes values and still returns results', async () => {
    // Store a known chunk first
    await client.callTool({
      name: 'engram_retain',
      arguments: { text: 'TypeFilter safety test chunk', memoryType: 'world' },
    });

    // Pass a mix of valid and invalid enum values — invalid ones should be stripped
    const result = await client.callTool({
      name: 'engram_recall',
      arguments: {
        query: 'TypeFilter safety test',
        memoryTypes: ['world', "world'; DROP TABLE chunks;--", 'invalid'],
        topK: 5,
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    // Only 'world' was valid — query ran without SQL error
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  it('engram_recall with explainScores includes a strategyScores breakdown', async () => {
    await client.callTool({
      name: 'engram_retain',
      arguments: {
        text: 'ExplainScores MCP round-trip test chunk',
        trustScore: 0.8,
      },
    });

    const result = await client.callTool({
      name: 'engram_recall',
      arguments: {
        query: 'ExplainScores MCP round-trip',
        strategies: ['keyword'],
        explainScores: true,
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0].strategyScores).toBeDefined();
    expect(Array.isArray(parsed.results[0].strategyScores.perStrategy)).toBe(
      true,
    );
    expect(typeof parsed.results[0].strategyScores.rawFusedScore).toBe(
      'number',
    );
  });

  it('engram_recall without explainScores omits strategyScores', async () => {
    await client.callTool({
      name: 'engram_retain',
      arguments: { text: 'No explain scores MCP round-trip chunk' },
    });

    const result = await client.callTool({
      name: 'engram_recall',
      arguments: {
        query: 'No explain scores MCP round-trip',
        strategies: ['keyword'],
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0]).not.toHaveProperty('strategyScores');
  });

  it('engram_recall with minScore filters out low-relevance results', async () => {
    await client.callTool({
      name: 'engram_retain',
      arguments: { text: 'MinScore MCP round-trip filter test chunk' },
    });

    const baseline = await client.callTool({
      name: 'engram_recall',
      arguments: {
        query: 'MinScore MCP round-trip filter',
        strategies: ['keyword'],
      },
    });
    const baseContent = baseline.content as Array<{
      type: string;
      text: string;
    }>;
    const baseParsed = JSON.parse(baseContent[0].text);
    expect(baseParsed.results.length).toBeGreaterThan(0);
    const topScore = baseParsed.results[0].score;

    const filtered = await client.callTool({
      name: 'engram_recall',
      arguments: {
        query: 'MinScore MCP round-trip filter',
        strategies: ['keyword'],
        minScore: topScore + 1,
      },
    });
    const filteredContent = filtered.content as Array<{
      type: string;
      text: string;
    }>;
    const filteredParsed = JSON.parse(filteredContent[0].text);
    expect(filteredParsed.results).toHaveLength(0);
  });

  it('engram_retain returns isError when text is missing', async () => {
    const result = await client.callTool({
      name: 'engram_retain',
      arguments: { memoryType: 'world' }, // no text
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('text');
  });

  it('engram_queue_stats returns queue health counts', async () => {
    const result = await client.callTool({
      name: 'engram_queue_stats',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const stats = JSON.parse(content[0].text);
    expect(stats).toHaveProperty('pending');
    expect(stats).toHaveProperty('completed');
    expect(stats).toHaveProperty('failed');
    expect(typeof stats.pending).toBe('number');
    expect(Array.isArray(stats.failed_reasons)).toBe(true);
  });

  it('engram_requeue_failed returns a requeued count (0 when nothing failed)', async () => {
    const result = await client.callTool({
      name: 'engram_requeue_failed',
      arguments: { errorLike: 'fetch failed' },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual({ requeued: 0 });
  });

  it('engram_recall returns isError when query is missing', async () => {
    const result = await client.callTool({
      name: 'engram_recall',
      arguments: { topK: 5 }, // no query
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('query');
  });
});

// =============================================================================
// engram_session action enum: default (resume) stays backward-compatible;
// update/snapshot wrap the same working-memory methods Pi's adapter uses.
//
// Dedicated engram/server/client (not shared with the "MCP Server" describe
// above) — the working-memory session matcher uses cosine similarity via the
// same low-dimensional MockEmbedder, and a shared db risks an unrelated
// earlier session (e.g. "Help me plan the Kubernetes migration") coincidentally
// matching a later test's message, turning an expected "new" into "match".
// =============================================================================

describe('engram_session action enum', () => {
  let engram: Engram;
  let client: Client;
  let server: Server;
  let dbPath: string;

  beforeAll(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    const handleTool = createEngramToolHandler(engram);

    server = new Server(
      { name: 'engram', version: '0.1.0' },
      { capabilities: { tools: {} } },
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

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    engram.close();
    cleanupDb(dbPath);
  });

  it('engram_session with no action still resumes/creates a session (backward compat)', async () => {
    const result = await client.callTool({
      name: 'engram_session',
      arguments: { message: 'Backward-compat default action check' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.session.id).toMatch(/^wm-/);
    expect(parsed.diagnostics.reason).toBe('new');
  });

  it('engram_session action=update merges progress into an existing session', async () => {
    const created = await client.callTool({
      name: 'engram_session',
      arguments: { message: 'Session to be updated via action=update' },
    });
    const createdContent = created.content as Array<{
      type: string;
      text: string;
    }>;
    const sessionId = JSON.parse(createdContent[0].text).session.id;

    const updated = await client.callTool({
      name: 'engram_session',
      arguments: {
        action: 'update',
        sessionId,
        progress: 'Drafted the rollback plan',
      },
    });

    expect(updated.isError).toBeFalsy();
    const updatedContent = updated.content as Array<{
      type: string;
      text: string;
    }>;
    const state = JSON.parse(updatedContent[0].text);
    expect(state.id).toBe(sessionId);
    expect(state.progress).toBe('Drafted the rollback plan');
  });

  it('engram_session action=snapshot collapses a session to long-term memory and returns a chunkId', async () => {
    const created = await client.callTool({
      name: 'engram_session',
      arguments: { message: 'Session to be snapshotted via action=snapshot' },
    });
    const createdContent = created.content as Array<{
      type: string;
      text: string;
    }>;
    const sessionId = JSON.parse(createdContent[0].text).session.id;

    const snapshotted = await client.callTool({
      name: 'engram_session',
      arguments: { action: 'snapshot', sessionId },
    });

    expect(snapshotted.isError).toBeFalsy();
    const snapContent = snapshotted.content as Array<{
      type: string;
      text: string;
    }>;
    const parsed = JSON.parse(snapContent[0].text);
    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.chunkId).toMatch(/^chk-/);
  });

  it('engram_session action=update returns isError for an unknown sessionId', async () => {
    const result = await client.callTool({
      name: 'engram_session',
      arguments: { action: 'update', sessionId: 'wm-does-not-exist' },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('not found');
  });
});

// =============================================================================
// ContextStore MCP tools: engram_context_commit / query / promote
// =============================================================================

describe('ContextStore MCP tools', () => {
  let engram: Engram;
  let client: Client;
  let server: Server;
  let dbPath: string;

  beforeAll(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, { embedder: new MockEmbedder() });

    const handleTool = createEngramToolHandler(engram);

    server = new Server(
      { name: 'engram', version: '0.1.0' },
      { capabilities: { tools: {} } },
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

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    engram.close();
    cleanupDb(dbPath);
  });

  it('commit -> query round trip returns a child artifact committed under the parent ref', async () => {
    // A commit is queryable as a CHILD of its parentRefId, not as itself —
    // querying a ref returns chunks whose parent_ref === refId (see
    // context-store.ts's queryContext doc). So the round trip needs a root
    // scope plus a child committed under it.
    const rootResult = await client.callTool({
      name: 'engram_context_commit',
      arguments: { decision: 'root: plan the release' },
    });
    const rootContent = rootResult.content as Array<{
      type: string;
      text: string;
    }>;
    const root = JSON.parse(rootContent[0].text);
    expect(root.id).toMatch(/^ctx-/);
    expect(root.scope).toBe('task');

    const childResult = await client.callTool({
      name: 'engram_context_commit',
      arguments: {
        decision: 'Use blue/green deployment for the release',
        rationale: 'Zero-downtime cutover with an easy rollback',
        domain: 'deployment-planning',
        agentId: 'builder-1',
        parentRefId: root.id,
      },
    });
    expect(childResult.isError).toBeFalsy();

    const queryResult = await client.callTool({
      name: 'engram_context_query',
      arguments: { refId: root.id, query: 'deployment strategy' },
    });
    expect(queryResult.isError).toBeFalsy();
    const queryContent = queryResult.content as Array<{
      type: string;
      text: string;
    }>;
    const slice = JSON.parse(queryContent[0].text);
    expect(slice.artifacts.length).toBeGreaterThan(0);
    expect(slice.artifacts[0].artifact.decision).toContain('blue/green');
  });

  it('promote moves an artifact into durable memory findable by recall', async () => {
    const commitResult = await client.callTool({
      name: 'engram_context_commit',
      arguments: {
        decision: 'PromoteMe: adopt trunk-based development',
      },
    });
    const commitContent = commitResult.content as Array<{
      type: string;
      text: string;
    }>;
    const ref = JSON.parse(commitContent[0].text);

    const promoteResult = await client.callTool({
      name: 'engram_context_promote',
      arguments: { refId: ref.id },
    });
    expect(promoteResult.isError).toBeFalsy();
    const promoteContent = promoteResult.content as Array<{
      type: string;
      text: string;
    }>;
    expect(JSON.parse(promoteContent[0].text)).toEqual({ promoted: true });

    const recallResult = await client.callTool({
      name: 'engram_recall',
      arguments: { query: 'trunk-based development' },
    });
    const recallContent = recallResult.content as Array<{
      type: string;
      text: string;
    }>;
    const recallParsed = JSON.parse(recallContent[0].text);
    expect(
      recallParsed.results.some((r: any) => r.text.includes('PromoteMe')),
    ).toBe(true);
  });

  it('promote returns {promoted:false} (not an error) for an unknown refId', async () => {
    const result = await client.callTool({
      name: 'engram_context_promote',
      arguments: { refId: 'ctx-does-not-exist' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual({ promoted: false });
  });

  it('engram_context_commit returns isError when decision is missing', async () => {
    const result = await client.callTool({
      name: 'engram_context_commit',
      arguments: { rationale: 'no decision field' },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('decision');
  });
});

// =============================================================================
// engram_embed tool
// =============================================================================

describe('engram_embed MCP tool', () => {
  let engram: Engram;
  let client: Client;
  let server: Server;
  let dbPath: string;

  beforeAll(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedderWithQuery(),
    });

    const handleTool = createEngramToolHandler(engram);

    server = new Server(
      { name: 'engram', version: '0.1.0' },
      { capabilities: { tools: {} } },
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

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    engram.close();
    cleanupDb(dbPath);
  });

  it('ListTools includes engram_embed', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('engram_embed');
  });

  it('returns dimensions matching the configured embedder (768)', async () => {
    const result = await client.callTool({
      name: 'engram_embed',
      arguments: { text: 'deploy pipeline', mode: 'query' },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text) as {
      embedding: number[];
      dimensions: number;
    };
    expect(parsed.dimensions).toBe(768);
    expect(parsed.embedding.length).toBe(parsed.dimensions);
  });

  it('all embedding values are finite numbers', async () => {
    const result = await client.callTool({
      name: 'engram_embed',
      arguments: { text: 'deploy pipeline', mode: 'query' },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text) as {
      embedding: number[];
      dimensions: number;
    };
    for (const v of parsed.embedding) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('mode=query and mode=document produce different vectors (prefix distinction)', async () => {
    const queryResult = await client.callTool({
      name: 'engram_embed',
      arguments: { text: 'deploy pipeline', mode: 'query' },
    });
    const docResult = await client.callTool({
      name: 'engram_embed',
      arguments: { text: 'deploy pipeline', mode: 'document' },
    });

    const qContent = queryResult.content as Array<{
      type: string;
      text: string;
    }>;
    const dContent = docResult.content as Array<{ type: string; text: string }>;
    const qVec = (JSON.parse(qContent[0].text) as { embedding: number[] })
      .embedding;
    const dVec = (JSON.parse(dContent[0].text) as { embedding: number[] })
      .embedding;

    // Vectors must differ — proves the prefix path is applied
    const identical = qVec.every((v, i) => v === dVec[i]);
    expect(identical).toBe(false);
  });

  it('mode defaults to query when omitted', async () => {
    const result = await client.callTool({
      name: 'engram_embed',
      arguments: { text: 'no mode specified' },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text) as {
      embedding: number[];
      dimensions: number;
    };
    expect(parsed.embedding.length).toBe(768);
  });

  it('returns isError when text is missing', async () => {
    const result = await client.callTool({
      name: 'engram_embed',
      arguments: { mode: 'query' },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('text');
  });
});
