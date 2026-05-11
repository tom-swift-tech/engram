# Engram + Pi.dev Integration Guide

[Pi](https://pi.dev) (the `pi-mono` coding agent by [@earendil-works](https://github.com/earendil-works/pi)) is a TypeScript coding agent CLI with a first-class extension system. This guide covers installing Engram as a Pi extension so you get persistent semantic memory across Pi sessions.

**Status:** Phase 1. Slash commands and LLM tools for `remember / recall / memory / forget` are implemented and tested. Reflection scheduling, auto-retain on `tool_call` / `message_end`, and `engram_session` (working memory) integration are deferred to Phase 2.

## Architecture

```
Pi coding agent
    │
    └── extension: engram-pi  (in-process, jiti-loaded TypeScript)
        ├── slash commands  (/remember /recall /memory /forget)
        ├── LLM tools       (engram_remember, engram_recall, …)
        ├── lifecycle hooks (session_start opens DB, session_shutdown closes)
        │
        └── Engram (in-process import — no subprocess, no MCP)
            ├── retain (~5ms, local Transformers.js embeddings)
            ├── recall (4-strategy: semantic + keyword + graph + temporal)
            ├── forget (soft-delete)
            └── stats  (chunks/entities/opinions/observations + queue)
                │
                └── .engram/pi.db   (SQLite + sqlite-vec, project-local)
```

This is fundamentally different from the OpenClaw model: OpenClaw spawns Engram out-of-process via `mcporter` (~10s cold-start per call). Pi loads Engram **in-process** via Node.js + `jiti`, so memory operations are millisecond-latency.

## Prerequisites

- **Node.js** ≥ 20.0.0
- **Pi** installed: `npm install -g @earendil-works/pi-coding-agent`
- **Engram** built: `cd /path/to/engram && npm install && npm run build`

No Ollama required for retain/recall — embeddings run via Transformers.js in-process. (~150MB model downloads to your HF cache on first use.) Ollama is only needed if you later wire up reflection or LLM-driven extraction.

## Setup

### 1. Build the Pi extension

```bash
cd /path/to/engram/integrations/pi
npm install        # symlinks engram via file:../..
npm run build
```

### 2. Install the extension into Pi

Two options.

**Option A — symlink into Pi's auto-discovered location** (recommended for ongoing development):

```bash
# Linux/Mac
ln -s /path/to/engram/integrations/pi ~/.pi/agent/extensions/engram-pi

# Windows (PowerShell, run as admin)
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.pi\agent\extensions\engram-pi" -Target "C:\path\to\engram\integrations\pi"
```

After symlinking, every new Pi session auto-loads the extension. Use `/reload` to re-pick up changes after rebuilds.

**Option B — `--extension` flag for ad-hoc testing:**

```bash
pi -e /path/to/engram/integrations/pi/dist/index.js
```

### 3. Verify

In a Pi session:

```
> /memory
Engram memory stats:
  db: /path/to/your/cwd/.engram/pi.db
  chunks:       0
  entities:     0
  opinions:     0
  observations: 0
  extraction queue: 0 pending, 0 processing, 0 failed
```

If you see this, the extension is registered and the DB was created on demand at `<cwd>/.engram/pi.db`.

## Usage

### Slash commands

| Command | Behavior |
|---------|----------|
| `/remember <text>` | Store a fact. `memoryType: world`, `sourceType: user_stated`, trust 0.85 |
| `/recall <query>` | Top-5 retrieval. Temporal phrases auto-detected |
| `/memory` | Counts of all memory tables + extraction queue depth |
| `/forget <chk-xxx>` | Soft-delete by ID (no confirmation — direct) |
| `/forget <query>` | Recall top-1, confirm in TUI, soft-delete on yes |

### LLM tools

The LLM sees four tools every turn:

| Tool | Purpose | Required params |
|------|---------|-----------------|
| `engram_remember` | Store a fact (marked `agent_generated`, default trust 0.6) | `text` |
| `engram_recall` | Search memory | `query` |
| `engram_memory_stats` | Report counts | (none) |
| `engram_forget` | Soft-delete by chunk ID | `chunkId` (must match `^chk-`) |

The schema rejects free-form forget queries from the LLM — the model must first `engram_recall` to find a real chunk ID before it can forget.

## Database location and Git

The DB lives at `<pi-cwd>/.engram/pi.db`. Add to `.gitignore`:

```gitignore
.engram/
```

Each project Pi runs in gets its own DB. To share memory across projects, use the same `cwd` (or wait for Phase 2 where the path becomes configurable).

## Comparison: OpenClaw vs Pi adapters

| | OpenClaw | Pi |
|---|----------|-----|
| Consumption | External `memory-engram` plugin in OpenClaw workspace | In-repo extension at `integrations/pi/` |
| Process model | `mcporter` subprocess per call (~10s cold-start) | Node.js `jiti`, in-process (~ms) |
| Engram code path | `engram-mcp` stdio server | `import { Engram } from 'engram'` |
| Where the adapter lives | OpenClaw workspace (not this repo) | This repo, alongside Engram |
| Migration tool ships? | Yes — `tools/openclaw-import/` | No (Pi has no prior memory format to migrate) |

Both adapters target the same `.engram` SQLite file format; you could in principle point a Pi extension at an OpenClaw-created `.engram` file and read its memory.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Pi doesn't list the commands | Extension not auto-discovered | Check `~/.pi/agent/extensions/engram-pi` symlink, or use `pi -e <path>` |
| `Cannot find module 'engram'` on load | Dist not built | `cd /path/to/engram && npm run build` then `cd integrations/pi && npm install` |
| First `/recall` takes ~30s | Transformers.js model first-load | One-time download. Subsequent calls are <100ms |
| `SQLITE_BUSY` | Concurrent writes from another process touching the same `.engram` | One Pi session per DB; use a different cwd for parallel sessions |

## What's next (deferred from Phase 1)

Tracked in `tasks/todo.md` under "Out of Scope":

- Triggering `engram.processExtractions()` and `engram.reflect()` on `turn_end` or `session_shutdown`
- Mapping Pi's session persistence to Engram's `working_memory` table via `engram_session`
- Optional auto-retain of conversation turns as `experience`-type chunks (with gating to avoid noise)
- Custom UI components via Pi's `ctx.ui.custom()` (e.g., a memory inspector widget)
- Publishing as `pi install`-able package
