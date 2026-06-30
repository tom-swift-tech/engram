# Engram — Memory Traces for AI Agents

> *A memory trace physically encoded in neural tissue that strengthens with reinforcement.*

## What This Is

Engram is a lightweight, zero-infrastructure memory system for AI agents that **learns** over time. Each agent gets its own SQLite file — an engram — containing everything it knows, has experienced, believes, and has learned. Raw facts are retained, entities and relationships are extracted, and periodic reflection cycles synthesize higher-order observations and confidence-scored beliefs.

Agents running on Engram don't just remember. They form opinions, refine them with evidence, and get smarter the longer they run.

## Repo

`swift-innovate/engram` — Apache 2.0

## Design Heritage

Engram synthesizes ideas from four prior efforts:

- **Hindsight** (vectorize-io): Four memory networks (world/experience/observation/opinion), retain/recall/reflect operations, bank-level configuration, confidence-scored beliefs. We took the cognitive architecture and dropped the Postgres dependency.
- **memory-ragkg** (our OpenClaw plugin design): SQLite-based knowledge graph with entities/relations tables, trust/provenance layer, hybrid query router. We carried the trust layer forward — neither Hindsight nor Memvid has it.
- **Hearthmind/Mira-Memory**: Lessons learned from mem0 integration pain — Ollama connectivity issues, write latency blocking agents, metadata restrictions. The fast-write/slow-extract pattern exists because of this.
- **Memvid**: Single-file portability inspiration. One file per agent, git-committable, zero infrastructure.

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
│  │ → queue extract  │              │ Graph    (entity walk)   │    │
│  └────────┬────────┘              │ Temporal (date filter)   │    │
│           │                       └────────────┬─────────────┘    │
│           ▼                                    ▼                  │
│  EXTRACT (background)             RRF + Trust Weighting           │
│  ┌─────────────────┐              ┌──────────────────────────┐    │
│  │ Ollama → entities│              │ Ranked results +         │    │
│  │ → relations      │              │ opinions + observations  │    │
│  │ → chunk_entities │              └──────────────────────────┘    │
│  └─────────────────┘                                              │
│                                                                   │
│  REFLECT (scheduled learning)                                     │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │ unreflected facts → Ollama → observations + opinions     │     │
│  │ (batch, not real-time — avoids latency on every write)   │     │
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

## The Engram Pipeline (Biological Metaphor)

The system mirrors how biological memory works:

1. **Encoding** (retain) — Sensory input is rapidly stored as a raw trace. Fast, no deliberation. Entity extraction happens in the background, the way the hippocampus processes memories during idle time.

2. **Consolidation** (extract) — Background process strengthens the trace by linking it to existing knowledge structures. Entities are resolved, relationships mapped, the knowledge graph densifies.

3. **Reconsolidation** (reflect) — Periodic review of accumulated traces produces higher-order understanding. Observations emerge from patterns. Beliefs form and update with confidence. Old observations get refined as new evidence arrives. This is the learning loop.

4. **Retrieval** (recall) — Multi-pathway access to stored traces. Semantic similarity (pattern matching), keyword (direct access), graph traversal (associative recall), temporal (episodic memory). Results are fused via RRF, weighted by trace strength (trust score), then sorted lexicographically by source tier (see Trust Layer) so external content can never outrank user-stated directives. When temporal bounds are detected (auto-parsed or explicit), ALL strategies filter by date — not just the temporal strategy. Queries are sanitized (punctuation stripped) before keyword/graph to prevent FTS5 syntax errors.

## Key Design Decisions

### Fast Write / Slow Extract
The #1 lesson from Hearthmind: never block writes on LLM calls. `retain()` embeds and stores in ~5ms. Entity extraction runs in a background queue via Ollama. The knowledge graph builds up over time without impacting agent responsiveness.

### Trust Layer (Unique to Engram)
Neither Memvid nor Hindsight tracks provenance. Every chunk carries `source_type` (user_stated, inferred, external_doc, tool_result, agent_generated) and `trust_score` (0.0-1.0). The recall pipeline weights results by trust. Security rule: external docs and tool results can NEVER override core agent directives regardless of trust score. This is enforced structurally in recall: final ranking is a lexicographic (source tier, trust-weighted score) sort — tier 0 `user_stated`, tier 1 `inferred`/`agent_generated`, tier 2 `tool_result`/`external_doc` — so no trust score or relevance lets a lower tier outrank a higher one. Within a tier, memory-type rank orders next (`world` > `observation` > `experience` > `opinion` — opinion last deliberately, agreeing with the 0.85 opinion-confidence cap in `formatForPrompt`), then trust-weighted score. A truncation reserve re-fetches tier-0 matches when volume fills a strategy's candidate window. Tunable via `RecallOptions.sourceTiers` / `RecallOptions.memoryTypeRank` (defaults in `DEFAULT_SOURCE_TIERS` / `DEFAULT_MEMORY_TYPE_RANK`). Consumers must NOT read `results[0]` as the highest-relevance match overall — it is the best match in the highest-present tier; re-sort by `score` locally where pure relevance is genuinely needed (as `findToForget` in the Pi adapter does). At the ingest layer, extraction and reflection prompts delimit memory content inside labeled `untrusted_data` blocks and clamp `disposition` config to validated numbers — an injection mitigation, not a guarantee.

### SQLite Over Postgres
Hindsight uses embedded Postgres. Engram uses SQLite because:
- Proven in our OpenClaw memory-ragkg work
- Single file per agent = portable, git-committable, backup-friendly
- sqlite-vec for vector search, FTS5 for keyword search
- Zero Docker containers required
- Runs on the homelab without additional services

SQLite runs in WAL mode (`journal_mode = WAL`, `synchronous = NORMAL`) so
multiple processes can read while one writes — this is what lets the
`engram-aql` Rust binary share a live `.engram` file with the TypeScript
library, and what lets multiple agents hit a `shared.engram` concurrently.
At runtime the main `.engram` file is accompanied by `.engram-wal` and
`.engram-shm` sidecar files. For backups, use `engram.backup(destPath)`
rather than raw `cp` — the backup method runs SQLite's online backup API
and produces a single standalone file with no sidecars.

### Batch Reflect Over Real-Time
Hindsight reflects on every query. Engram reflects on a schedule (default: manual trigger, configurable to hourly/daily). This keeps Ollama usage bounded while still building observations and opinions over time.

### Four Memory Types
Inspired by Hindsight's four networks, mapped to biological memory:
- **World** = semantic memory (facts about the world)
- **Experience** = episodic memory (what the agent itself did)
- **Observation** = consolidated knowledge (patterns across facts)
- **Opinion** = belief with confidence (strengthens or weakens with evidence)

## File Extension

Agent memory files use the `.engram` extension (they're SQLite files):
```
~/.valor/memory/myAgent.engram
~/.valor/memory/sit-agent.engram
~/.valor/memory/shared.engram
```

## Dependencies

| Dependency | Purpose | Required? |
|-----------|---------|-----------|
| better-sqlite3 | SQLite driver for Node.js | Yes |
| sqlite-vec | Vector similarity search extension | Yes (for semantic recall) |
| @huggingface/transformers | In-process embeddings (retain + recall) | Yes (default embedding path) |
| Ollama | Local LLM for extraction + reflection | Yes (for extract + reflect) |
| llama3.1:8b | Fast model for extraction + reflection | Recommended |
| nomic-embed-text (Ollama) | Ollama embedding model | Only when `useOllamaEmbeddings: true` |

**Herd alternative:** swift-innovate/herd exposes the same Ollama HTTP API on port `40114`. Use `ollamaUrl: 'http://localhost:40114'` to point Engram at Herd instead.

## File Structure

```
engram/
├── CLAUDE.md           ← you are here (source of truth)
├── AGENTS.md           ← verbatim mirror of CLAUDE.md for AGENTS-standard tools (keep in sync)
├── README.md           ← public-facing docs
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── schema.sql               ← full database schema (10 tables, FTS5, triggers)
│   ├── engram.ts                ← unified Engram class + public API exports
│   ├── retain.ts                ← fast write + dedup + batch import + extraction queue
│   ├── recall.ts                ← four-way retrieval + RRF + trust/decay weighting + formatForPrompt
│   ├── reflect.ts               ← scheduled learning engine + prompt templates
│   ├── extract-cpu.ts           ← zero-LLM inline entity extraction (Tier 1)
│   ├── temporal-parser.ts       ← natural language date parsing for temporal recall
│   ├── generation.ts            ← pluggable generation providers (Ollama, OpenAI-compat, Anthropic)
│   ├── local-embedder.ts        ← in-process embeddings via @huggingface/transformers
│   ├── working-memory-types.ts  ← types for working memory session management
│   ├── mcp-tools.ts             ← MCP tool definitions (8 tools: retain/recall/reflect/extract/forget/supersede/session/queue_stats)
│   ├── mcp-server.ts            ← standalone MCP stdio server (engram-mcp bin)
│   ├── cli.ts                   ← `engram` CLI: one subcommand per MCP tool, --json contract for Pi (engram bin)
│   └── cli-args.ts              ← CLI argv parser + Engram.open option-builder + shared validation/clamp helpers
├── tests/                        ← TS suites incl. aql-* cross-process (379 tests via npm test; +74 from integrations/pi, +67 from tools/openclaw-import)
│   ├── helpers.ts
│   ├── retain.test.ts
│   ├── retain-gate.test.ts
│   ├── recall.test.ts
│   ├── trust-tier.test.ts        ← source-tier ranking floor + prompt-injection mitigations
│   ├── reflect.test.ts
│   ├── extract-cpu.test.ts
│   ├── temporal-parser.test.ts
│   ├── generation.test.ts
│   ├── engram.test.ts
│   ├── working-memory.test.ts
│   ├── local-embedder.test.ts
│   ├── agent-integration.test.ts
│   ├── mcp-server.test.ts
│   ├── cli.test.ts               ← engram CLI: per-subcommand happy path, --json contract, stdin, exit codes (21 tests)
│   ├── aql-schema.test.ts         ← AQL schema/parse checks
│   ├── aql-equivalence.test.ts    ← L2: AQL results match TS recall/scan/load semantics
│   └── aql-e2e-process.test.ts    ← L3: cross-process WAL handoff (spawns the Rust binary; needs cargo)
├── docs/
│   ├── OPENCLAW-INTEGRATION.md   ← OpenClaw memory plugin setup guide
│   └── PI-INTEGRATION.md         ← Pi.dev (pi-mono) extension setup guide
├── integrations/
│   ├── README.md                 ← adapter map (OpenClaw external; Pi in-repo)
│   └── pi/                       ← Pi extension package (engram-pi)
│       ├── package.json          ← pi.extensions field; engram via file:../..
│       ├── src/
│       │   ├── index.ts          ← Pi binding: registers commands + LLM tools, lifecycle
│       │   ├── adapter.ts        ← pure logic: takes Engram, returns plain objects
│       │   └── types.ts          ← typebox schemas for the seven LLM tools (core + session)
│       └── tests/                ← 74 tests (adapter, scheduling, auto-retain, session-bridge, smoke + built-dist)
├── skills/
│   ├── engram.md                  ← portable agent skill (covers all 8 MCP tools)
│   ├── engram-session.md          ← working memory session skill
│   └── cli-memory/SKILL.md        ← Pi-facing `engram` CLI contract (per-command --json shapes, exit codes, when to recall/retain/supersede/session)
├── tools/
│   └── openclaw-import/           ← CLI to import OpenClaw memory files into .engram
│       ├── README.md
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts           ← CLI entry point (commander)
│           ├── import.ts          ← orchestrator: classify → parse → map → retainBatch
│           ├── classify.ts        ← path-based file classification + skip patterns
│           ├── dates.ts           ← date extraction from filenames and content
│           ├── parser.ts          ← H2-split markdown chunker with size limits
│           ├── mapping.ts         ← category → memory type + trust score mapping
│           ├── types.ts           ← shared interfaces
│           └── tests/             ← 67 unit tests (classify/parser/mapping/dates)
├── engram-aql/                   ← companion Rust crate (merged, PR #1): AQL read surface over the shared .engram
│   ├── Cargo.toml
│   ├── src/                       ← executor, memory_map, schema, result, error; mcp/, statements/, subcommand/, sql/
│   └── tests/                     ← L1 Rust integration tests (recall/scan/lookup/load/aggregate/graph/pipeline/mcp_roundtrip)
└── examples/
    └── basic-usage.ts
```

## Usage

### Initialize an engram
```typescript
import { Engram } from 'engram';

const myAgent = await Engram.create('./myAgent.engram', {
  reflectMission: 'Focus on architecture preferences, project patterns, and infrastructure decisions.',
  retainMission: 'Prioritize technical decisions, code patterns, and project context. Ignore greetings.',
  ollamaUrl: 'http://localhost:11434',
});
```

### Store a memory
```typescript
await myAgent.retain('Tom prefers Terraform with the bpg provider for Proxmox IaC', {
  memoryType: 'world',
  source: 'conversation:valor-engine-planning',
  sourceType: 'user_stated',
  trustScore: 0.9,
  context: 'infrastructure',
});
```

### Recall memories
```typescript
const response = await myAgent.recall('What IaC tools does Tom use?', { topK: 5 });
// response.results   → ranked chunks from four retrieval strategies
// response.opinions  → relevant beliefs with confidence scores
// response.observations → synthesized knowledge
```

### Run reflection
```bash
# CLI
npx tsx src/reflect.ts ./myAgent.engram

# Or programmatically
const result = await myAgent.reflect();
// result: { observationsCreated: 3, opinionsFormed: 1, opinionsReinforced: 2, ... }
```

### Process entity extraction queue
```typescript
await myAgent.processExtractions();
// Runs Ollama against queued chunks, builds out entity graph
```

## Harness Integrations

Engram is harness-agnostic. Adapters live in `integrations/`. See `integrations/README.md` for the index.

### OpenClaw (production)

External `memory-engram` plugin in the OpenClaw workspace, consumed via `mcporter` subprocess. Production-verified by the Tracer agent (2026-03-24, 16/17 stress tests passed). See `docs/OPENCLAW-INTEGRATION.md`.

- Plugin bridges `memory_search` / `memory_get` → `engram_recall` via mcporter
- Markdown sync ingests `workspace/memory/*.md` into Engram automatically
- Migration CLI: `tools/openclaw-import/` (one-shot bulk-load of OpenClaw markdown into `.engram`)
- Known: ~10s latency from mcporter cold-start (fix: daemon mode or direct import)

### Pi.dev (`pi-mono`)

In-repo extension at `integrations/pi/`, loaded by Pi via Node.js + `jiti` (in-process, millisecond-latency). Project-local DB at `.engram/pi.db`. See `docs/PI-INTEGRATION.md`.

Surface: five slash commands (`/remember`, `/recall`, `/memory`, `/forget`, `/session`) and seven LLM tools (`engram_remember`, `engram_recall`, `engram_memory_stats`, `engram_forget`, `engram_session_resume`, `engram_session_update`, `engram_session_snapshot`).

- Adapter is pure (`integrations/pi/src/adapter.ts`); Pi binding (`index.ts`) registers commands/tools and owns lifecycle + transient state
- Lifecycle hooks: `session_start` (lazy DB open), `before_agent_start` (system-prompt addendum nudging memory use), `turn_end` (background extract/reflect scheduling), `message_end` (auto-retain), `session_shutdown` (flush + close)
- **Working-memory session bridge:** `engram_session_*` tools wrap infer/update/snapshot of working sessions across turns; a transient `currentSessionId` backs the `/session` command
- **Background consolidation:** every few turns drains the extraction queue / runs reflection, fire-and-forget so a turn never blocks on Ollama; warns once per session if Ollama is unreachable. Tunable via `ENGRAM_PI_EXTRACT_EVERY_TURNS` / `ENGRAM_PI_REFLECT_EVERY_TURNS` / `ENGRAM_PI_EXTRACT_BATCH`
- **Auto-retain:** captures conversation messages as `experience` chunks off `message_end` (on by default; `ENGRAM_PI_AUTO_RETAIN=0` disables). Tool/bash output is stored at the lowest trust tier (`tool_result`) so it can never outrank a user directive at recall
- 74 tests (pure adapter + binding lifecycle + built-dist smoke), gated in CI on Node 20 and 24
- Deferred: memory-inspector UI widget (`ctx.ui.custom()`); `pi install`-able packaging

## Integration with valor-engine

Engram is a standalone library. valor-engine consumes it as a dependency:

```typescript
// valor-engine/engine/memory/index.ts
import { Engram } from 'engram';

// One engram per operative
const myAgentMemory = await Engram.open('./myAgent.engram');
const sitMemory = await Engram.open('./sit-agent.engram');

// Auto-retain conversation turns
gateway.on('message', async (msg) => {
  await myAgentMemory.retain(msg.text, {
    memoryType: 'experience',
    source: `conversation:${msg.conversationId}`,
    sourceType: 'user_stated',
    trustScore: 0.9,
  });
});

// Inject context before LLM calls
const context = await myAgentMemory.recall(userMessage, { topK: 10 });
const systemPrompt = buildPromptWithMemory(basePrompt, context);
```

## engram-aql (Rust) — merged

A companion crate, `engram-aql/`, ships in this repo (merged via PR #1). It is a separate Rust process that shares the `.engram` SQLite file with TypeScript Engram via WAL: TS owns writes (retain, embedding, extraction, reflection); the Rust binary owns the AQL declarative read surface (`RECALL`, `SCAN`, `LOOKUP`, `LOAD`, `AGGREGATE`, `ORDER BY`, `WITH LINKS`, `FOLLOW LINKS`, `PIPELINE`). Write statements `STORE`/`UPDATE`/`FORGET`/`REFLECT` are delegated to the canonical TS retain pipeline over the bridge (Phase 2b) — Rust never writes the file itself; only `LINK` is still rejected (no canonical TS manual-relation surface). Phase 2a adds query-side vector similarity: `RECALL ... LIKE $var` / `PATTERN $var THRESHOLD t` rank chunks by cosine distance via a native `vec_distance_cosine` scalar fn registered on the Rust connection (no `sqlite-vec` dependency in Rust — it decodes the same LE-f32 BLOBs TS writes). The probe is resolved from a bound variable: a query string is embedded through a lazily-spawned, warm `engram-mcp` child (the new `engram_embed` MCP tool, so the embedding is model-compatible with stored vectors), or a precomputed embedding array is used directly (no child spawn). Variables are passed via the `engram_aql` MCP tool's `variables` object or the `query` CLI's repeatable `--var name=value`.

**Where to look:**
- Crate: `engram-aql/` — `src/{executor,memory_map,schema,result,error,lib,main}.rs` plus `src/{mcp,statements,subcommand,sql}/`
- Subcommands: `engram-aql query <db> '<aql>'` (one-shot JSON), `engram-aql repl <db>` (interactive), `engram-aql mcp <db>` (stdio MCP server exposing `engram_aql` tool)
- Tests: L1 Rust integration tests in `engram-aql/tests/` (recall/scan/lookup/load/aggregate/graph/pipeline/mcp_roundtrip); L2 semantic-equivalence + L3 cross-process suites in TS (`tests/aql-*.test.ts`) validate the cross-process WAL handoff against TS-created `.engram` files. The L3 suite spawns the Rust binary, so the AQL tests need `cargo` present (they're skipped/failing without it).
- Spec: `docs/superpowers/specs/2026-04-12-engram-aql-rust-binary-design.md`
- Plan: `docs/superpowers/plans/2026-04-12-engram-aql-rust-binary.md`

**Phase 2a (vector search) — done.** `LIKE`/`PATTERN` semantic search wired in RECALL (`statements/recall.rs`); native `vec_distance_cosine` + LE-f32 codec (`src/vector/`); warm `engram-mcp` bridge for query embedding (`src/bridge/`, synchronous `std::process`); `ExecCtx` variable threading (`src/exec_ctx.rs`); `variables` surface in the MCP tool + `--var` in the `query` CLI. `LIKE`/`PATTERN` only apply to chunks-backed memory (SEMANTIC/EPISODIC); on PROCEDURAL/WORKING/TOOLS they warn (no embeddings). L2 equivalence (`tests/aql-vector-equivalence.test.ts`) proves the native cosine matches sqlite-vec ordering. Design: `docs/superpowers/specs/2026-06-24-engram-aql-writes-and-vector-search-design.md`; plan: `docs/superpowers/plans/2026-06-24-engram-aql-writes-and-vector-search.md`.

**Phase 2b (write delegation) — done.** Writes are translated to TS tool calls over the same bridge (`statements/write_delegate.rs`), so Rust stays DB-read-only: `STORE`→`engram_retain` (payload fields → retain options; **pass-through provenance** — unspecified `sourceType`/`trustScore` inherit retain's defaults), `UPDATE`→`engram_supersede` (target ids resolved via a RO read, superseded each), `FORGET`→`engram_forget` (RO-resolve ids, forget each), `REFLECT`→`engram_reflect` (global cycle; source/THEN filters not yet honored). Writes target chunk-backed memory only (SEMANTIC/EPISODIC). The bridge gained a generic `call_tool` (`src/bridge/call.rs`); `embed_query` reuses it. Cross-process WAL visibility holds with no refresh — Rust RO autocommit reads see the bridge child's commits immediately (`tests/write_delegate.rs`, gated on `engram-mcp`). `LINK` remains rejected.

**Remaining (deferred, see `tasks/todo.md`):** a canonical TS surface for manual `LINK` (relations are extraction-derived today); transactional `PIPELINE` mixing reads + writes (a stage that reads its own prior write within one pipeline).

## Git

```bash
git init && git branch -M main
```

## Decisions

- [x] **License**: Apache 2.0. Set in `package.json`. Maximizes adoption for a utility library. Revisit to BSL 1.1 only if commercial protection becomes a requirement.

- [x] **sqlite-vec loading**: Prebuilt binaries via npm (`sqlite-vec` package). No compile-from-source step. The `Engram` class loads it with a `try/catch` — graceful fallback to 3-strategy recall if absent.

- [x] **Shared engram**: Naming convention. Multiple agents call `Engram.open('./shared.engram')`. `Engram.open()` sets `journal_mode = WAL`, `synchronous = NORMAL`, and `busy_timeout = 5000` so concurrent readers never block each other or the writer, and a held write lock resolves within the timeout window. Concurrent `retain()` calls serialize at the writer (SQLite allows one writer at a time), but reads proceed fully in parallel. No separate API needed. The same pragma set enables cross-process sharing with the `engram-aql` Rust binary.

- [x] **MCP tool surface**: 8 tools exposed in `mcp-tools.ts` — `engram_retain`, `engram_recall`, `engram_reflect`, `engram_process_extractions`, `engram_forget`, `engram_supersede`, `engram_session`, `engram_queue_stats`. Agents pick what they need; `forget`/`supersede` enable correction loops, `session` carries working-memory context across turns, `queue_stats` reports extraction-queue health for ops/diagnostics.

- [x] **CLI transport** (`engram` bin, `src/cli.ts`): a third transport over the same `Engram` core, structurally a sibling of `mcp-server.ts` — parse argv → `Engram.open()` → dispatch to the SAME methods → print. One kebab-cased subcommand per MCP tool (`retain`/`recall`/`reflect`/`process-extractions`/`forget`/`supersede`/`session`/`queue-stats`) so `skills/cli-memory/SKILL.md` maps 1:1 to the tool surface. Built for use as a Pi coding-agent skill: `--json` on every command emits the raw method return to stdout and nothing else (the stable Pi integration contract); diagnostics go to stderr; the primary text arg is read from stdin when omitted (pipe context in); exit codes are 0 success / 2 not-found (`forget`/`supersede` missing chunk) / 1 error. DB path resolves from `--db <path>` then `ENGRAM_DB`. No retain/recall/reflect logic is duplicated — `src/cli-args.ts` holds the argv parser, the `Engram.open` option-builder (same flags as `engram-mcp`), and the validation/clamp helpers (a canonical copy mirroring the private ones in the frozen `mcp-tools.ts`).

- [x] **Packaging / install**: `package.json` declares two bins — `engram-mcp` (MCP stdio server) and `engram` (CLI) — alongside the library `main`. A `prepare` script runs `npm run build` automatically on install, so installing this repo by **git ref** (e.g. `npm i github:tom-swift-tech/engram`, or `pi install` from a git source) produces a working `dist/` with all three entry points. No npm publish yet — consumers use a git ref or a local checkout; `files: ["dist"]` keeps any future tarball lean.

- [x] **Agent instructions live in two mirrored files**: `CLAUDE.md` is the source of truth; `AGENTS.md` is a verbatim mirror for tools that read the cross-vendor `AGENTS.md` standard. They differ only in the "you are here" marker. **Edit both together** — any change to architecture, file structure, or decisions must land in both files or they drift.

- [x] **Reflect schedule**: Library default is manual (call `engram.reflect()` or the CLI). `ReflectScheduler` class ships for timer-based use. Recommendation for valor-engine: `ReflectScheduler` with a 6-hour default, configurable per operative.

- [x] **Embedding model**: `nomic-ai/nomic-embed-text-v1.5` (768d) runs in-process via `@huggingface/transformers` (v3+, the maintained successor to the deprecated `@xenova/transformers`) as default — no Ollama required for retain/recall, and no Hugging Face token (the `nomic-ai` upstream repo is public). Override via `embedModel` option. `Xenova/all-MiniLM-L6-v2` (384d) is a valid alternative for lower disk/memory use. The legacy `Xenova/nomic-embed-text-v1.5` mirror is now gated (401 without a token) so it's no longer the default, but ships identical 768-dim weights — existing `.engram` files stay valid. Opt into Ollama embeddings via `useOllamaEmbeddings: true` (e.g., for GPU acceleration). Existing `.engram` files with Ollama-generated vectors are fully compatible — same model weights, same 768-dim space.

- [ ] **`.engram` MIME type**: Deferred. Extension is established; OS MIME registration is future work if IDE/tooling support becomes valuable.
