<div align="center">

# 🧠 Engram

### Memory traces for AI agents that strengthen with reinforcement.

*A lightweight, zero-infrastructure memory system where agents don't just remember — they form opinions, refine them with evidence, and get smarter the longer they run.*

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D%2020-green.svg)](https://nodejs.org/)
[![Tests: 308](https://img.shields.io/badge/Tests-308%20passing-brightgreen.svg)](#development)
[![SQLite](https://img.shields.io/badge/Storage-SQLite-003B57.svg)](https://sqlite.org)

</div>

---

Each agent gets its own SQLite file — an **engram** — containing everything it knows, has experienced, believes, and has learned. Raw facts are retained in ~5ms with no LLM call. Entities and relationships are extracted in the background. Periodic reflection cycles synthesize higher-order observations and confidence-scored beliefs.

One file. Zero infrastructure. Full cognitive architecture.

```
npm install engram
```

## Why Engram?

Most agent memory systems are either too simple (append-only logs) or too heavy (Postgres + Redis + vector DB). Engram sits in the sweet spot:

- **~5ms writes** — embedding + SQLite, no LLM in the hot path
- **Four-way retrieval** — semantic vectors, BM25 keyword, knowledge graph traversal, and temporal filtering fused via Reciprocal Rank Fusion
- **Trust layer** — every memory carries provenance and a confidence score that weights recall
- **Learns over time** — scheduled reflection synthesizes observations and forms beliefs that strengthen or weaken with evidence
- **Single file per agent** — portable, git-committable, inspectable with any SQLite tool
- **Working memory** — auto-switching session contexts for multi-topic conversations
- **Zero cloud dependency** — embeddings run locally via Transformers.js; extraction and reflection use any local LLM via Ollama or pluggable providers

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                           ENGRAM                                  │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  RETAIN (fast write)              RECALL (four-way retrieval)     │
│  ┌─────────────────┐              ┌──────────────────────────┐    │
│  │ text → embed     │              │ Semantic (sqlite-vec)    │    │
│  │ → SQLite chunk   │              │ Keyword  (FTS5 BM25)    │    │
│  │ → Tier 1 extract │              │ Graph    (entity walk)   │    │
│  │ → queue Tier 2   │              │ Temporal (date filter)   │    │
│  └────────┬────────┘              └────────────┬─────────────┘    │
│           │                                    ▼                  │
│           ▼                       RRF + Trust + Temporal Decay    │
│  EXTRACT (two-tier)               ┌──────────────────────────┐    │
│  ┌─────────────────┐              │ Ranked results +         │    │
│  │ Tier 1: CPU      │              │ opinions + observations  │    │
│  │  (inline, instant)│              └──────────────────────────┘    │
│  │ Tier 2: LLM      │                                             │
│  │  (background)     │                                             │
│  └─────────────────┘                                              │
│                                                                   │
│  REFLECT (scheduled learning)                                     │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │ unreflected facts → LLM → observations + opinions        │     │
│  │ (batch, not real-time — avoids latency on every write)   │     │
│  └──────────────────────────────────────────────────────────┘     │
│                                                                   │
│  WORKING MEMORY (short-term sessions)                             │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │ auto-switching topic sessions → snapshot to episodic      │     │
│  │ embedding similarity matching → session cap enforcement   │     │
│  └──────────────────────────────────────────────────────────┘     │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │               <agentId>.engram (SQLite)                   │     │
│  │  chunks | entities | relations | chunk_entities           │     │
│  │  opinions | observations | reflect_log | extraction_queue │     │
│  │  bank_config | chunks_fts (FTS5) | working_memory         │     │
│  └──────────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────┘
```

## The Biological Metaphor

Engram's pipeline mirrors how biological memory actually works:

1. **Encoding** (`retain`) — Sensory input is rapidly stored as a raw trace. Fast, no deliberation. Tier 1 CPU extraction links entities inline; Tier 2 LLM extraction queues for background processing — the way the hippocampus processes memories during idle time.

2. **Consolidation** (`extract`) — Background processing strengthens the trace by linking it to existing knowledge structures. Entities are resolved, relationships mapped, the knowledge graph densifies. Two tiers: CPU pattern matching runs inline (~2ms); LLM extraction runs asynchronously via Ollama.

3. **Reconsolidation** (`reflect`) — Periodic review of accumulated traces produces higher-order understanding. Observations emerge from patterns. Beliefs form and update with confidence. Old observations get refined as new evidence arrives.

4. **Retrieval** (`recall`) — Multi-pathway access to stored traces. Semantic similarity (pattern matching), keyword (direct access), graph traversal (associative recall), temporal (episodic memory). Results are fused via RRF, weighted by trust score with temporal decay, and ranked by source tier so external content never outranks user-stated directives.

## Prerequisites

**Engram has zero mandatory external dependencies.** Out of the box, `npm install engram` gives you:

- **Embeddings** via Transformers.js — runs in-process, no server needed. The model (`Xenova/nomic-embed-text-v1.5`, ~30MB) downloads automatically on first use.
- **Tier 1 entity extraction** via CPU pattern matching — runs inline with every `retain()` call, building the knowledge graph immediately.
- **Four-way recall** — semantic, keyword, graph, and temporal retrieval all work with zero external services.

That means `retain()`, `recall()`, and basic knowledge graph building work with nothing but Node.js and SQLite.

**Optional: LLM for deeper extraction and reflection.** Tier 2 entity extraction (`processExtractions()`) and reflection (`reflect()`) call a generation model to find complex relationships and synthesize observations/opinions. These are purely additive — if you never run them, the core pipeline still works. Ollama is the default provider:

```bash
ollama pull llama3.1:8b
```

If you run models via [Herd](https://github.com/swift-innovate/herd) (Rust-based LLM gateway), use port `40114`:

```typescript
const agent = await Engram.create('./agent.engram', {
  ollamaUrl: 'http://localhost:40114',
});
```

Engram also supports **pluggable generation providers** — OpenAI-compatible APIs, Anthropic, or any custom backend. See [Generation Providers](#generation-providers).

## Quick Start

```typescript
import { Engram } from 'engram';

// Create an engram file for your agent
const agent = await Engram.create('./myAgent.engram', {
  ollamaUrl: 'http://localhost:11434',
  reflectMission: 'Focus on architecture preferences and infrastructure decisions.',
  retainMission: 'Prioritize technical decisions and project context. Ignore greetings.',
});

// Store a fact (~5ms, no LLM call)
await agent.retain('Tom prefers Terraform with the bpg provider for Proxmox IaC', {
  memoryType: 'world',
  sourceType: 'user_stated',
  trustScore: 0.9,
});

// Recall with four-way retrieval + trust weighting
const response = await agent.recall('What IaC tools does Tom use?', { topK: 5 });
console.log(response.results);      // ranked chunks
console.log(response.opinions);     // beliefs with confidence
console.log(response.observations); // synthesized knowledge

// Build knowledge graph (runs Ollama in background)
await agent.processExtractions(10);

// Synthesize observations and form opinions
await agent.reflect();

agent.close();
```

## Core API

### Creating and Opening

```typescript
// Create a new engram file
const agent = await Engram.create('./agent.engram', {
  ollamaUrl?: string,              // default: 'http://localhost:11434'
  reflectMission?: string,         // guides reflection synthesis
  retainMission?: string,          // guides retention prioritization
  embedModel?: string,             // default: 'Xenova/nomic-embed-text-v1.5'
  reflectModel?: string,           // default: 'llama3.1:8b'
  useOllamaEmbeddings?: boolean,   // use Ollama instead of local (default: false)
  disposition?: {                  // behavioral tuning for reflection
    skepticism?: number,           // 0–1
    literalism?: number,           // 0–1
    empathy?: number,              // 0–1
  },
});

// Open an existing engram file
const agent = await Engram.open('./agent.engram');
```

### `retain(text, options?)`

Store a memory. Embeds and writes to SQLite in ~5ms. Tier 1 CPU extraction links entities inline. Tier 2 LLM extraction is queued for background processing. No LLM call blocks this path.

```typescript
await agent.retain('Tom prefers Terraform with the bpg provider for Proxmox IaC', {
  memoryType?: 'world' | 'experience' | 'observation' | 'opinion',  // default: 'world'
  source?: string,         // e.g. 'conversation:session-123'
  sourceType?: string,     // 'user_stated' | 'inferred' | 'external_doc' | 'tool_result' | 'agent_generated'
  trustScore?: number,     // 0.0–1.0 (default: 0.5)
  context?: string,        // freeform tag (e.g. 'infrastructure', 'project:valor')
  dedupMode?: string,      // 'exact' | 'normalized' | 'none' (default: 'normalized')
});
```

**Memory types** map to biological memory:

| Type | Biological analog | Written by |
|------|------------------|------------|
| `world` | Semantic memory — facts about the world | Agent or user |
| `experience` | Episodic memory — what the agent did | Agent |
| `observation` | Consolidated knowledge — patterns across facts | `reflect()` |
| `opinion` | Belief with confidence — strengthens/weakens with evidence | `reflect()` |

**Deduplication:** By default (`normalized`), identical text after case-folding and whitespace normalization is not stored twice — the existing chunk's trust score is reinforced instead.

### `retainBatch(items, onProgress?)`

Bulk store. More efficient than calling `retain()` in a loop.

```typescript
const results = await agent.retainBatch([
  { text: 'Tom prefers Terraform', options: { memoryType: 'world', trustScore: 0.9 } },
  { text: 'Vault stores PKI certs', options: { memoryType: 'world' } },
], (current, total) => console.log(`${current}/${total}`));
```

### `recall(query, options?)`

Retrieve memories using four parallel strategies fused via Reciprocal Rank Fusion, weighted by trust score with temporal decay, then ranked lexicographically by source tier (user-stated content structurally outranks external content — see Design Decisions).

Temporal expressions are auto-parsed from the query — `"last week"`, `"yesterday"`, `"March 15th"`, `"past 30 days"`, `"Q1 2026"` all activate the temporal strategy without explicit parameters.

**Query best practices:** Use keywords and proper nouns, not full questions. BM25 keyword search weights every word equally — question words like "who/what/how" dilute the signal and match irrelevant content. For people: `"Tom Swift role background"` not `"Who is Tom?"`. For topics: `"Herd router deployment"` not `"What is the Herd router?"`. Temporal expressions work naturally: `"projects in 2023"`.

```typescript
const response = await agent.recall('What IaC tools does Tom use?', {
  topK?: number,                    // max results (default: 10)
  memoryTypes?: string[],           // filter by type
  minTrust?: number,                // minimum trust score
  after?: string,                   // ISO date — overrides auto-parsed dates
  before?: string,                  // ISO date — overrides auto-parsed dates
  strategies?: string[],            // subset of ['semantic','keyword','graph','temporal']
  includeOpinions?: boolean,        // default: true
  includeObservations?: boolean,    // default: true
  sourceFilter?: string,            // hard filter by source substring
  contextFilter?: string,           // hard filter by context substring
  sourceBoost?: { pattern: string; multiplier: number },
  contextBoost?: { pattern: string; multiplier: number },
  decayHalfLifeDays?: number,       // trust decay half-life (default: 180, 0 to disable)
  sourceTiers?: Record<string, number>, // source_type → tier overrides (see DEFAULT_SOURCE_TIERS)
  memoryTypeRank?: Record<string, number>, // memory_type → within-tier rank overrides (see DEFAULT_MEMORY_TYPE_RANK)
  snippetChars?: number,            // max chars per result
  rrfK?: number,                    // RRF constant (default: 60)
});

// response.results       → ranked chunks with scores, strategies, and metadata
// response.opinions      → relevant beliefs with confidence scores
// response.observations  → synthesized knowledge
// response.totalCandidates
// response.strategiesUsed
```

**Result ordering.** `recall` returns results in **tier-major order, not pure relevance order**: sorted first by source tier (0 `user_stated`, 1 `inferred`/`agent_generated`, 2 `tool_result`/`external_doc`), then by memory-type rank within each tier (`world` > `observation` > `experience` > `opinion`), then by trust-weighted relevance within those. This enforces the trust-layer guarantee — external content cannot outrank user directives regardless of relevance or trust score. Integrators: `results[0]` is the best match in the highest-present tier, **not** necessarily the highest-relevance match overall; do not assume score-descending order across the full list (re-sort by `score` locally where you genuinely need relevance order). Tier mapping is configurable via `RecallOptions.sourceTiers`; memory-type ranking via `RecallOptions.memoryTypeRank` (defaults exported as `DEFAULT_SOURCE_TIERS` / `DEFAULT_MEMORY_TYPE_RANK`).

### `processExtractions(batchSize?)`

Run the Tier 2 LLM entity extraction queue. Builds out the knowledge graph.

```typescript
const { processed, failed } = await agent.processExtractions(10);
```

### `reflect()`

Synthesize observations and form/update opinions from accumulated facts.

```typescript
const result = await agent.reflect();
// { observationsCreated, opinionsFormed, opinionsReinforced, chunksProcessed }
```

### `forget(chunkId)` / `supersede(oldChunkId, newText)` / `forgetBySource(pattern)`

Manage memory lifecycle:

```typescript
await agent.forget('chunk-uuid');                          // soft-delete
await agent.supersede(oldId, 'corrected fact', options);   // replace with link
const count = await agent.forgetBySource('session-123');   // bulk soft-delete
```

### `close()`

Close the database connection when the agent session ends.

## Working Memory

Short-term session state for agents handling multiple concurrent topics. Sessions auto-match incoming messages via embedding similarity — the agent doesn't need to track which session it's in.

```typescript
async function handleMessage(userInput: string) {
  // 1. Infer or resume session + load related long-term context
  const { session, relatedContext } = await agent.inferWorkingSession(userInput);

  // 2. Build prompt with session state + memory
  const systemPrompt = `${basePrompt}

## Current Task
Goal: ${session.goal}
${session.progress ? `Progress: ${session.progress}` : ''}

## Memory Context
${relatedContext}`;

  // 3. Call LLM
  const response = await callLLM(userInput, systemPrompt);

  // 4. Update session progress
  await agent.updateWorkingSession(session.id, {
    progress: extractProgress(response),
  });

  return response;
}

// Background maintenance
setInterval(() => agent.expireStaleWorkingSessions(48), 60 * 60 * 1000);
```

**Session API:**

| Method | Description |
|--------|-------------|
| `inferWorkingSession(message, options?)` | Match/create session, load related context |
| `updateWorkingSession(sessionId, updates)` | Merge state updates, re-embed for matching |
| `getWorkingSession(sessionId)` | Get session state or `null` if expired |
| `listWorkingSessions()` | All active sessions, newest first |
| `snapshotWorkingSession(sessionId)` | Save to episodic memory, then expire |
| `clearWorkingSession(sessionId)` | Expire without snapshot |
| `expireStaleWorkingSessions(maxAgeHours?)` | Batch-expire old sessions (default: 48h) |

## Utility Functions

Exported directly from `engram` — no instance required.

### `shouldRetain(text)`

Heuristic gate scoring text on retention value (0.0–1.0). Filters phatic expressions, trivial acknowledgements, and bare questions.

```typescript
import { shouldRetain } from 'engram';

const { score, reason } = shouldRetain('Tom decided to use Pulumi for all new IaC');
// score: ~0.8, reason: 'decision language, technical terms'

if (score >= 0.5) await agent.retain(text, { ... });
```

### `formatForPrompt(response, options?)`

Format a `RecallResponse` into a string for system prompt injection with token budgeting.

```typescript
import { formatForPrompt } from 'engram';

const memory = await agent.recall(userMessage, { topK: 10 });
const block = formatForPrompt(memory, { maxChars: 2000, showTrust: false });
const systemPrompt = `${basePrompt}\n\n${block}`;
```

## Generation Providers

Entity extraction and reflection use a pluggable `GenerationProvider` interface. Three implementations ship out of the box:

```typescript
// Ollama (default — no config needed)
await Engram.create('./agent.engram', { ollamaUrl: 'http://localhost:11434' });

// OpenAI-compatible (OpenRouter, Herd Pro, vLLM, LiteLLM, etc.)
await Engram.create('./agent.engram', {
  generationEndpoint: {
    baseUrl: 'https://openrouter.ai/api',
    model: 'anthropic/claude-haiku-4.5',
    apiKey: process.env.OPENROUTER_API_KEY,
  },
});

// Anthropic direct
await Engram.create('./agent.engram', {
  anthropicGeneration: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-haiku-4-5-20251001',
  },
});

// Custom — inject any GenerationProvider implementation
await Engram.create('./agent.engram', { generator: myCustomProvider });
```

## MCP Integration

Expose Engram operations as MCP tools for agent frameworks that support the Model Context Protocol.

### Programmatic

```typescript
import { ENGRAM_TOOLS, createEngramToolHandler } from 'engram/mcp-tools';

const handle = createEngramToolHandler(agent);
server.registerTools(ENGRAM_TOOLS);
server.onToolCall((name, input) => handle(name, input));
```

### Stdio Server

Ships a standalone MCP server for Claude Code, Claude Desktop, Cursor, and any MCP-compatible client:

```bash
npx engram-mcp ./agent.engram
npx engram-mcp ./agent.engram --use-ollama-embeddings --ollama-url http://localhost:11434
npx engram-mcp ./agent.engram --generation-endpoint http://localhost:8080 --generation-model gpt-4
npx engram-mcp ./agent.engram --anthropic-api-key sk-ant-... --anthropic-model claude-haiku-4-5-20251001
```

**Claude Code / Claude Desktop config:**

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/path/to/engram/dist/mcp-server.js", "./agent.engram"],
      "transport": "stdio"
    }
  }
}
```

### Tools Exposed

| Tool | Description |
|------|-------------|
| `engram_retain` | Store a memory with source and trust metadata |
| `engram_recall` | Four-way retrieval with auto-parsed temporal expressions |
| `engram_reflect` | Trigger reflection cycle |
| `engram_process_extractions` | Process entity extraction queue |
| `engram_forget` | Soft-delete a memory chunk |
| `engram_supersede` | Replace an outdated fact with corrected text |
| `engram_session` | Infer or resume a working memory session |
| `engram_queue_stats` | Extraction queue depth and processing metrics |

## CLI

A third transport over the same Engram core — one subcommand per MCP tool,
kebab-cased. Ideal as a coding-agent skill (e.g. Pi): the agent shells out, pipes
context in on stdin, and parses `--json` on stdout. Ships as the `engram` bin.

```bash
npm install -g engram      # or: npx engram <command>
```

Point it at a database with `--db <path>` on each call, or set `ENGRAM_DB` once
(`--db` takes precedence; if neither is set the command exits 1):

```bash
export ENGRAM_DB=./agent.engram
```

Every command accepts `--json`, which emits the raw method return as JSON to
**stdout and nothing else** (diagnostics go to stderr). Without it you get
human-readable output. The same generation/embedding flags as `engram-mcp` are
accepted: `--ollama-url`, `--use-ollama-embeddings`, `--reflect-model`,
`--generation-endpoint`/`--generation-model`/`--generation-api-key`,
`--anthropic-api-key`/`--anthropic-model`.

**Exit codes:** `0` success · `2` not-found (`forget`/`supersede` on a missing
chunk) · `1` error (bad/missing argument, no DB path, operation failure).

The eight commands:

```bash
# Store a fact
engram retain "Tom prefers Pulumi over Terraform" \
  --memory-type world --source-type user_stated --trust-score 0.9 --json

# Search (keywords/proper nouns beat questions; temporal phrases auto-parse)
engram recall "Terraform IaC provider" --top-k 5 --json
engram recall "decisions last week" --strategies semantic,temporal --json

# Infer/resume a working-memory session (once per incoming message)
engram session "Help me plan the deployment" --json

# Correct an outdated fact (old chunk soft-deleted + linked to the new one)
engram supersede chk-abc123 "Tom switched to Kubernetes" --json

# Soft-delete a chunk
engram forget chk-abc123 --json

# Background maintenance (need an LLM)
engram reflect --json
engram process-extractions --batch-size 10 --json

# Queue health
engram queue-stats --json
```

The primary text argument for `retain`, `recall`, `session`, and the `newText`
of `supersede` is read from **stdin** when the positional is omitted, so an agent
can pipe context straight in:

```bash
echo "long pasted context to remember" | engram retain --db ./agent.engram --json
cat error.log | engram recall --json
```

The `--json` shape of each command is its method's return value verbatim — see
`skills/cli-memory/SKILL.md` for the per-command schemas and an agent-facing
decision guide (when to recall vs. retain vs. supersede vs. session).

## engram-aql — Native Rust Query Binary (Optional)

For declarative AQL (Agent Query Language) queries over your `.engram` file,
this repo also contains a companion Rust binary at `engram-aql/`.

It runs alongside TypeScript Engram as a second process, sharing the same
`.engram` SQLite file in WAL mode. Phase 1 is read-only — writes still go
through `engram.retain()` on the TS side — but reads support the full AQL
spec including RECALL, SCAN, LOOKUP, LOAD, AGGREGATE, ORDER BY, WITH LINKS,
FOLLOW LINKS, and PIPELINE.

Three subcommands:

- `engram-aql query <path> "<aql>"` — one-shot CLI query, JSON output
- `engram-aql repl <path>` — interactive REPL with pretty tables
- `engram-aql mcp <path>` — stdio MCP server exposing an `engram_aql` tool

Build and install:

```bash
cd engram-aql
cargo install --path .
```

See `engram-aql/README.md` for details and
`docs/superpowers/specs/2026-04-12-engram-aql-rust-binary-design.md`
for the architecture.

## Two-Tier Entity Extraction

Engram builds a knowledge graph without blocking writes:

**Tier 1 (CPU, inline with `retain()`):** Pure pattern matching — graph lookup against existing entities, proper noun detection, technical term detection, and relation template matching (`"X uses Y"`, `"X prefers Y"`, etc.). Runs in ~2ms, zero LLM, zero model loads. Every `retain()` enriches the graph immediately.

**Tier 2 (LLM, background via `processExtractions()`):** Ollama-based extraction catches complex relationships and reclassifies provisional entities. Purely additive — if Ollama never runs, the graph still works from Tier 1.

The knowledge graph compounds automatically: each entity discovered by Tier 2 makes Tier 1 smarter — future mentions get linked instantly.

## Harness Integrations

Engram is a memory substrate; agent harnesses consume it via different integration models. See **[integrations/README.md](integrations/README.md)** for the index.

### OpenClaw

Replaces OpenClaw's built-in flat-file FTS with semantic four-strategy retrieval via the `memory-engram` plugin and mcporter (out-of-process). Production-verified with the Tracer agent. See **[docs/OPENCLAW-INTEGRATION.md](docs/OPENCLAW-INTEGRATION.md)**.

A migration CLI ships in `tools/openclaw-import/` for importing existing OpenClaw `memory/` directories into `.engram` files (deterministic classification, no LLM during import):

```bash
cd tools/openclaw-import && npm install
npx tsx src/index.ts -i /path/to/memory -o ./agent.engram --dry-run  # preview
npx tsx src/index.ts -i /path/to/memory -o ./agent.engram            # import
```

See **[tools/openclaw-import/README.md](tools/openclaw-import/README.md)** for the category mapping and CLI options.

### Pi.dev (`pi-mono`)

In-process Pi extension exposing slash commands (`/remember`, `/recall`, `/memory`, `/forget`) and LLM tools (`engram_remember`, `engram_recall`, `engram_memory_stats`, `engram_forget`). Loaded directly via Node.js + `jiti` — millisecond-latency operations against a project-local `.engram/pi.db`.

```bash
cd integrations/pi && npm install && npm run build
ln -s "$PWD" ~/.pi/agent/extensions/engram-pi   # or: pi -e ./dist/index.js
```

See **[docs/PI-INTEGRATION.md](docs/PI-INTEGRATION.md)** for full setup, lifecycle behavior, and the OpenClaw-vs-Pi adapter comparison.

## Agent Skills

Portable skill files for agents using Engram via mcporter:

- **[skills/engram.md](skills/engram.md)** — Complete tool reference with all 8 MCP tools, usage patterns, and common mistakes
- **[skills/engram-session.md](skills/engram-session.md)** — Working memory session lifecycle and tuning guide
- **[skills/cli-memory/SKILL.md](skills/cli-memory/SKILL.md)** — `engram` CLI contract for coding agents (e.g. Pi): per-command `--json` schemas, exit codes, and when to recall vs. retain vs. supersede vs. session

## Integration Patterns

### Direct Integration

```typescript
import { Engram, shouldRetain, formatForPrompt } from 'engram';

const memory = await Engram.open('./agent.engram');

async function agentLoop(userInput: string) {
  const context = await memory.recall(userInput, { topK: 10 });
  const block = formatForPrompt(context, { maxChars: 2000 });

  const response = await callLLM(userInput, block);

  if (shouldRetain(userInput).score >= 0.3) {
    await memory.retain(userInput, { memoryType: 'experience', sourceType: 'user_stated', trustScore: 0.85 });
  }
  if (shouldRetain(response).score >= 0.3) {
    await memory.retain(response, { memoryType: 'experience', sourceType: 'agent_generated', trustScore: 0.6 });
  }

  return response;
}

// Background ticks
setInterval(() => memory.processExtractions(10), 5 * 60 * 1000);
setInterval(() => memory.reflect(), 6 * 60 * 60 * 1000);
```

### Adapter Layer (Recommended)

Pass `shouldRetain` and `formatForPrompt` as function references from the agent level — don't rely on dynamic `import('engram')` in framework code (Node module resolution across `file:` dependencies can fail silently):

```typescript
// Agent code:
import { Engram, shouldRetain, formatForPrompt } from 'engram';
const instance = await Engram.open('./agent.engram');
framework.init({ engram: { instance, shouldRetain, formatForPrompt } });

// Framework code:
async function recallContext(query, engram, formatFn) {
  const response = await engram.recall(query, { topK: 10 });
  return formatFn(response, { maxChars: 2000 });
}
```

### Scheduled Reflection

```typescript
import { ReflectScheduler } from 'engram';

const scheduler = new ReflectScheduler({
  dbPath: './agent.engram',
  ollamaUrl: 'http://localhost:11434',
});
scheduler.start(6 * 60 * 60 * 1000); // every 6 hours
```

### CLI Reflection

```bash
npx tsx src/reflect.ts ./agent.engram
OLLAMA_URL=http://my-server:11434 REFLECT_MODEL=llama3.2:3b npx tsx src/reflect.ts ./agent.engram
```

## Verifying Your Setup

A common failure mode is `Engram.open()` completing successfully while the embedding pipeline silently fails. The database opens fine — but embeddings load lazily on the first `retain()` call.

```typescript
// Health check — verify end-to-end before trusting the pipeline
const engram = await Engram.open('./agent.engram');
try {
  const result = await engram.retain('__health_check__', {
    memoryType: 'world', source: 'health_check', trustScore: 0.0, skipExtraction: true,
  });
  await engram.forget(result.chunkId);
  console.log('✓ Engram healthy');
} catch (err) {
  console.error('✗ Embedding model unreachable:', err.message);
}
```

## Design Decisions

**Fast write / slow extract.** `retain()` never blocks on an LLM call. This exists because of lessons learned from mem0 integration — Ollama connectivity issues and write latency were killing agent responsiveness.

**Trust layer.** Every chunk carries `source_type` and `trust_score`. Recall weights results by trust, then ranks lexicographically by source tier — tier 0 `user_stated`, tier 1 `inferred`/`agent_generated`, tier 2 `tool_result`/`external_doc` — so external documents and tool results structurally cannot outrank user-stated directives, no matter their trust score or relevance (tunable via `sourceTiers`). Extraction and reflection prompts delimit memory content as labeled untrusted data — a prompt-injection mitigation, not a guarantee.

**SQLite over Postgres.** One file per agent — portable, git-committable, backup-friendly. sqlite-vec handles vector search; FTS5 handles keyword search. No Docker containers, no infrastructure dependencies.

**Batch reflect over real-time.** Reflection runs on a schedule, not on every query. This keeps LLM usage predictable while still building understanding over time.

**Two-tier extraction.** Tier 1 (CPU, inline) ensures the knowledge graph is never empty. Tier 2 (LLM, background) refines it. If Ollama goes down, the graph still works.

**Normalized dedup by default.** Storing the same fact twice wastes space and confuses ranking. Dedup reinforces trust instead.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Engram active" but zero chunks | Embedding model failed to load | Verify `@xenova/transformers` installed and `~/.cache/xenova/` writable |
| Health check passes, retain still empty | `shouldRetain`/`formatForPrompt` dynamically imported in framework | Pass function references from agent level, not via `import('engram')` |
| Reflection runs but produces nothing | Zero chunks in database | Fix retain first |
| Extraction queue stays at 0 | `skipExtraction: true` or non-world/experience types | Only `world` and `experience` queue for extraction |
| Entities empty despite chunks | Extraction tick not running | Call `processExtractions()` periodically |
| Recall returns empty | `sqlite-vec` not loaded | Install the `sqlite-vec` npm package |
| Trust scores not differentiating | All chunks same trust | Vary: user_stated=0.85, agent_generated=0.6, inferred=0.5, tool_result=0.4 |

## Dependencies

| Dependency | Purpose | Required? |
|-----------|---------|-----------|
| better-sqlite3 | SQLite driver | Yes |
| sqlite-vec | Vector similarity search | Yes |
| @xenova/transformers | In-process embeddings | Yes (default) |
| @modelcontextprotocol/sdk | MCP server support | Yes |
| Ollama + llama3.1:8b | Tier 2 extraction + reflection | **No** — core pipeline works without it |
| nomic-embed-text (Ollama) | Ollama embeddings | Only with `useOllamaEmbeddings: true` |

### Using `@huggingface/transformers` instead of `@xenova/transformers`

Engram defaults to `@xenova/transformers` (v2) because it works without authentication. The official `@huggingface/transformers` (v3+) supports newer models but requires a [Hugging Face token](https://huggingface.co/settings/tokens):

```bash
npm uninstall @xenova/transformers && npm install @huggingface/transformers
export HF_TOKEN=hf_...
```

Update the import in `src/local-embedder.ts` and use official model IDs (no `Xenova/` prefix). Existing `.engram` files don't need re-embedding — the vectors are compatible.

## File Format

Agent memory files use the `.engram` extension. Standard SQLite databases — inspect with any SQLite tool.

```
~/.valor/memory/myAgent.engram
~/.valor/memory/gage.engram
~/.valor/memory/shared.engram
```

## Development

```bash
npm install
npm run build        # TypeScript → dist/
npm test             # 308 tests across 16 suites
npm run typecheck    # type check without emit
npm run example      # run examples/basic-usage.ts
```

## License

Apache 2.0
