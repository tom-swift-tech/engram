# engram-pi

A [Pi.dev](https://pi.dev) (`pi-mono` coding agent) extension that exposes [Engram](../..) memory as slash commands and LLM-callable tools.

> **Status:** Phase 1. Read/write/forget/stats are wired. Reflection cadence and auto-retain hooks are intentionally deferred — see the parent repo's `tasks/todo.md` for the follow-up list.

## What you get

### Slash commands

| Command | Effect |
|---------|--------|
| `/remember <text>` | Store a fact in Engram (high trust, source `pi:slash-command`) |
| `/recall <query>` | Four-strategy retrieval (semantic + keyword + graph + temporal). Auto-parses phrases like "last week" |
| `/memory` | Show counts: chunks, entities, opinions, observations, extraction queue depth |
| `/forget <chunk-id>` | Soft-delete a memory by ID (`chk-xxx`) |
| `/forget <query>` | Find the top match, confirm in the UI, then soft-delete (no-op in non-interactive mode) |

### LLM tools

Available to the model in every turn (Pi auto-registers them as tools the LLM can invoke):

| Tool | Purpose |
|------|---------|
| `engram_remember` | Store text. Marked `agent_generated`, default trust 0.6 |
| `engram_recall` | Retrieve memories. Returns ranked results + opinions |
| `engram_memory_stats` | Counts of chunks/entities/opinions/observations/queue |
| `engram_forget` | Soft-delete by chunk ID. Requires `chunkId` matching `^chk-` — the model cannot forget by query, only by ID it has previously seen |

## Database location

The extension opens (or creates) `.engram/pi.db` relative to Pi's working directory. The folder is auto-created on first use. Add to your `.gitignore`:

```gitignore
.engram/
```

## Install

### Local development (this repo)

```bash
# From the engram repo root
npm run build               # builds engram core into dist/
cd integrations/pi
npm install                 # installs pi types + typebox; symlinks engram via file:../..
npm run build               # produces integrations/pi/dist/index.js
```

Then point Pi at the built file:

```bash
pi -e /path/to/engram/integrations/pi/dist/index.js
```

Or symlink it into Pi's auto-discovered location:

```bash
ln -s /path/to/engram/integrations/pi ~/.pi/agent/extensions/engram-pi
```

### Production (once published)

Phase 1 ships in-repo only. Future: publish as a Pi package installable via `pi install <git-url>` or `pi install npm:engram-pi`.

## Tests

```bash
cd integrations/pi
npx vitest run
```

Two suites:
- `tests/adapter.test.ts` — pure adapter logic against a real in-memory Engram (no Pi mocking, no Ollama).
- `tests/smoke-extension.test.ts` — verifies the default-exported factory registers the four documented commands and four tools with the right names, parameter schemas, and lifecycle subscriptions.

Both run without Ollama; embeddings use a deterministic 8-dim mock. The first time you run against a real Pi session, the local Transformers.js model downloads (~150MB) and persists to your HF cache.

## Embeddings

Defaults to local Transformers.js (no external deps). To switch to Ollama, you'd need to construct the `Engram` instance with `useOllamaEmbeddings: true` and an `ollamaUrl`. Phase 1 doesn't yet expose this knob through the extension; track in the parent repo's `tasks/todo.md`.

## Architecture

```
Pi session
  └─ engram-pi extension (this package)
       ├─ src/index.ts     ← Pi binding: registers commands, tools, lifecycle
       ├─ src/adapter.ts   ← pure logic: takes Engram, runs operations
       └─ src/types.ts     ← typebox schemas for LLM tool parameters
            │
            └─ engram (parent package, in-process)
                 └─ .engram/pi.db (SQLite + sqlite-vec)
```

The adapter is intentionally Pi-agnostic — it accepts an `Engram` instance and returns plain objects. That keeps Pi's API surface confined to `index.ts` and lets the adapter be unit-tested without any Pi mocking.

## License

Apache-2.0, same as Engram.
