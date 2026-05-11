# Pi.dev Adapter — Phase 1 Plan

> Supersedes the prior "Engram Build Plan" content (the original library is shipped). Previous content kept in git history.

## Goal

Add Pi.dev (pi-mono coding agent) as a **second harness adapter** alongside the existing OpenClaw integration. Engram core stays harness-agnostic. OpenClaw integration is preserved as-is (it's external + the import CLI). Pi gets an in-repo extension package so users can `pi install` it directly.

## Architecture Note

```
Engram repo
├── src/                          ← core library (unchanged, harness-agnostic)
├── tools/openclaw-import/        ← unchanged: OpenClaw → .engram migration CLI
├── integrations/                 ← NEW top-level boundary
│   ├── README.md                 ← maps adapters to their consumption models
│   └── pi/                       ← NEW: Pi extension as a Pi-installable package
│       ├── package.json          ← name, deps, pi.extensions field
│       ├── README.md             ← install + usage
│       ├── src/
│       │   ├── index.ts          ← extension entry: registers commands + tools
│       │   ├── adapter.ts        ← thin wrapper: Pi command/tool args → Engram calls
│       │   └── types.ts          ← Pi-side parameter schemas (typebox)
│       └── tests/
│           └── adapter.test.ts   ← unit tests with mocked ExtensionAPI
└── docs/
    ├── OPENCLAW-INTEGRATION.md   ← unchanged
    └── PI-INTEGRATION.md         ← NEW: install + slash commands + LLM tools
```

**Why this layout:**
- Doesn't move OpenClaw code (zero risk to working integration)
- New `integrations/` directory creates the conceptual boundary the user wants without manufacturing fake symmetry
- Pi extension is itself a Pi package (has its own `package.json` per Pi's distribution model) — users install it via Pi's own tooling, not ours
- Pi extension imports `engram` from the workspace root, so it shares the same types and core code — no duplication

**Trade-off accepted:** OpenClaw "integration" lives in `tools/openclaw-import/` (migration tool) and `docs/OPENCLAW-INTEGRATION.md` (consumer-side instructions). It does NOT move to `integrations/openclaw/` because that would be a 0-benefit restructure of working code. The new `integrations/README.md` is the single page where readers learn "where does each harness's code live."

---

## Tasks

### Phase 0: Verify assumptions

- [x] **Confirm `@earendil-works/pi-coding-agent` is the current npm package name** — verified v0.74.0 on npm registry; older `@mariozechner/pi-coding-agent` (0.73.1) is by same author Mario Zechner but the @earendil-works scope is current. Binary name is `pi`. Project config dir is `.pi`.
- [x] **Confirm extension runtime is Node.js (not QuickJS)** — verified via docs: "Extensions are loaded via jiti, so TypeScript works without compilation." jiti is a Node.js TS loader. Native deps (better-sqlite3, sqlite-vec, transformers.js) work in-process. The QuickJS mention from search results refers to the separate Rust-based `pi_agent_rust` port, not pi-mono.

### Phase 1: Scaffold

- [ ] Create `integrations/` directory + `integrations/README.md` mapping adapters to consumption models (OpenClaw external via mcporter; Pi in-process via this extension)
- [ ] Create `integrations/pi/` with `package.json`, `README.md`, `tsconfig.json`, `src/`, `tests/`
- [ ] `package.json` declares: dep on `engram` (workspace `file:../..`), dep on `@earendil-works/pi-coding-agent` and `typebox` (peer/dev), `pi.extensions` field pointing at compiled output

### Phase 2: Adapter implementation

- [ ] **`src/adapter.ts`** — pure logic, takes an `Engram` instance, exports four functions:
  - `remember(text, opts)` → `engram.retain(...)`
  - `recall(query, opts)` → `engram.recall(...)` returning Pi-friendly shape
  - `memoryStats()` → `{ chunks, entities, opinions, observations, queueDepth }` from raw SQL
  - `forget(idOrQuery)` → if `chk-xxx` ID: `engram.forget(id)`; if query: recall top-1 then forget. Asks for confirmation via `ctx.ui.confirm()` at the call site, not inside adapter.
- [ ] **`src/types.ts`** — typebox schemas for the four LLM tools' params
- [ ] **`src/index.ts`** — extension entry:
  - Async factory: opens Engram from `.engram/pi.db` (project-local convention) on `session_start`, closes on `session_end` if such an event exists (verify in Phase 0)
  - Registers slash commands: `/remember`, `/recall`, `/memory`, `/forget`
  - Registers LLM tools: `engram_remember`, `engram_recall`, `engram_memory_stats`, `engram_forget`
  - Each command/tool calls into `adapter.ts`

### Phase 3: Tests

- [ ] `tests/adapter.test.ts` — vitest unit suite. Mocks Pi's `ExtensionAPI` minimally; uses a real in-memory `Engram` instance. Verifies: remember stores a chunk, recall finds it, stats counts it, forget soft-deletes it.
- [ ] `tests/smoke-extension.test.ts` — loads `index.ts` against a fake `ExtensionAPI` that captures registrations; asserts the four commands and four tools are registered with expected names + schemas.

### Phase 4: Build & smoke

- [ ] Add npm script: `npm run build:pi` from repo root that compiles `integrations/pi`
- [ ] Add `integrations/pi` to repo-root vitest config (or its own config — TBD, smallest change wins)
- [ ] Manual smoke: `pi -e ./integrations/pi/dist/index.js` against a temp `.engram/pi.db`, drive `/remember`, `/recall`, `/memory` interactively. Document any rough edges.

### Phase 5: Docs

- [ ] `integrations/pi/README.md` — install (two paths: `pi install <git-url>` for end users, project-local symlink for dev), slash command reference, LLM tool reference
- [ ] `docs/PI-INTEGRATION.md` — high-level integration guide mirroring `OPENCLAW-INTEGRATION.md`'s structure
- [ ] Root `README.md` — short "Integrations" section: "Engram supports two harness adapters: OpenClaw (external plugin via MCP) and Pi.dev (in-repo extension)." Links to both docs.
- [ ] Root `CLAUDE.md` — single line under existing OpenClaw mention: pointer to `integrations/pi/`

### Phase 6: Verify nothing regressed

- [ ] `npm test` — full TS suite still 308/308
- [ ] `cd tools/openclaw-import && npm test` — openclaw-import suite still passes
- [ ] OpenClaw integration doc unchanged (sanity diff)

### Phase 7: Commit & PR

- [ ] One focused commit per phase (scaffold, adapter, tests, docs)
- [ ] Push to a new branch `feat/pi-adapter` (per the established "feature work goes on its own branch" convention from AQL)
- [ ] Open PR with the architecture note + test results

---

## Out of Scope (tracked for follow-up)

- [ ] **Reflect/extract scheduling from Pi** — Pi has a long-running session, so `engram.processExtractions()` and `engram.reflect()` could be triggered from `turn_end` or `session_end` hooks. Punt to Phase 2 — needs design choice on cadence + Ollama availability detection.
- [ ] **Working memory `engram_session` integration** — Pi already has session persistence via `pi.appendEntry()`. Mapping that to Engram's working-memory table needs thought (avoid double-persistence).
- [ ] **Auto-retain conversation turns** — `tool_call` and `message_end` events could auto-stash messages as `experience`-type chunks. Powerful but easy to fill the DB with noise. Needs gating (e.g., min length, dedup).
- [ ] **Custom UI components** — Pi's `ctx.ui.custom()` allows a "memory inspector" widget. Nice-to-have.
- [ ] **`pi install` from a public registry** — Phase 1 ships the extension in-repo; publishing to npm or a git-installable form is a separate decision (versioning, ownership).

---

## Open Questions for User

Before implementing, two decisions need confirmation:

1. **Repo location of Pi DB:** spec says `.engram/pi.db`. Should this be the default, configurable, or always relative to the project root that Pi was launched in? My read: default to `.engram/pi.db` in the project root, allow override via extension settings.
2. **Embedding mode default:** local Transformers.js (no Ollama needed, ~150MB model download on first run) or require explicit Ollama setup? Suggest: local default for friction-free install.
