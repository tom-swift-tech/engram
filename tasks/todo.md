# Engram — Open Work

> Both harness adapters shipped; the Pi adapter is now through most of Phase 2.
> This file tracks what's deferred. Historical plans live in git history.

## Status as of 2026-06-22

- **AQL Rust binary (Phase 1)** — merged via PR #1. Read-only query surface (RECALL, SCAN, LOOKUP, LOAD, AGGREGATE, ORDER BY, WITH LINKS, FOLLOW LINKS). Subcommands: `query`, `repl`, `mcp`. Crate at `engram-aql/`.
- **Pi.dev extension (Phase 1)** — merged via PR #2. Four slash commands (`/remember`, `/recall`, `/memory`, `/forget`) and four LLM tools (`engram_remember`, `engram_recall`, `engram_memory_stats`, `engram_forget`). Lives at `integrations/pi/`.
- **`engram` CLI transport (2026-06-05)** — third transport over the `Engram` core (`src/cli.ts` + `src/cli-args.ts`, `engram` bin). One kebab-cased subcommand per MCP tool; `--json` on every command emits the raw method return to stdout (stable Pi contract), diagnostics to stderr, primary text arg read from stdin when omitted, exit codes 0/2/1. Pi-facing skill at `skills/cli-memory/SKILL.md`; README has install + 8-command reference. Frozen core/MCP files untouched.
- **Packaging (2026-06-06)** — `prepare` script (commit `0bf16af`) runs `npm run build` on install, so installing this repo by **git ref** now yields a working `dist/` with the `engram` + `engram-mcp` bins and the library. No npm publish yet (see the publish item below).
- **Docs (2026-06-06)** — `AGENTS.md` added as a verbatim mirror of `CLAUDE.md` (cross-tool AGENTS standard). The two must be edited together; see the hygiene item below.
- **Trust-tier enforcement (2026-06-10)** — the CLAUDE.md trust-layer rule ("external content can never override user directives") is now enforced in code, not just documented. Recall ranks lexicographically by (source tier, trust-weighted score) with a tier-0 truncation reserve (`DEFAULT_SOURCE_TIERS`, `RecallOptions.sourceTiers`); extraction/reflect prompts delimit memory content as labeled untrusted data and clamp `disposition` to validated numbers. New suite: `tests/trust-tier.test.ts` (11 tests).
- **Recall ordering follow-ups (2026-06-10, PR #5 follow-up)** — memory-type rank added as the middle lexicographic sort term (tier, memoryTypeRank, score; `DEFAULT_MEMORY_TYPE_RANK`, `RecallOptions.memoryTypeRank`). Positional-read audit of the transports found one latent bug: Pi adapter `findToForget` read tier-major `results[0]` as best-relevance, preferentially nominating user directives for deletion — fixed to over-fetch and re-sort by score. Result-ordering contract documented in README + `RecallResponse.results`.
- **Pi.dev extension — working-memory session bridge (2026-06-16)** — shipped. Adds `/session` slash command, three LLM tools (`engram_session_resume`, `engram_session_update`, `engram_session_snapshot`) wrapping the working-memory primitives, and a `before_agent_start` system-prompt addendum nudging the agent toward Engram. Closes the Phase 2 `engram_session` ↔ Pi session persistence item. Spec: `docs/superpowers/specs/2026-05-13-engram-pi-session-bridge-design.md`; plan: `docs/superpowers/plans/2026-05-13-engram-pi-session-bridge.md`.
- **Node 24 support (2026-06-19)** — merged via PR #8. Bumped `better-sqlite3` `9.4.3` → `12.11.1`, which ships prebuilds for Node 20/22/24 (the old pin had no Node 24 prebuild and failed from-source on Windows). No source changes — the API Engram uses is unchanged across 9→12. CI now runs a `[20, 24]` matrix. `delete_branch_on_merge` enabled on the repo the same day.
- **Pi background consolidation (2026-06-19)** — merged via PR #10. Turn-based extract/reflect scheduling off `turn_end` (every 3 turns drain queue if pending; every 12 turns reflect) + a time-bounded `session_shutdown` flush. Fire-and-forget, overlap-guarded; warns once if Ollama is unreachable. Tunable via `ENGRAM_PI_EXTRACT_EVERY_TURNS` / `ENGRAM_PI_REFLECT_EVERY_TURNS` / `ENGRAM_PI_EXTRACT_BATCH`.
- **CI covers `integrations/pi` (2026-06-19)** — merged via PR #11. The `check` job now installs/typechecks/builds/tests the Pi extension after the root build, on the `[20, 24]` matrix. Previously the Pi suite ran locally-only.
- **Pi auto-retain (2026-06-22)** — merged via PR #12. Captures conversation messages as `experience` chunks off `message_end` (on by default; `ENGRAM_PI_AUTO_RETAIN=0` disables). All conversational roles captured; tool/bash output stored at the lowest trust tier so it can't outrank user directives. Gated (min length, skip `/commands`, truncate over `maxChars`, normalized dedup). Tunable via `ENGRAM_PI_AUTO_RETAIN_MIN_CHARS` / `ENGRAM_PI_AUTO_RETAIN_MAX_CHARS`.
- **ContextStore — task-scoped ephemeral context (2026-07-01)** — new fifth scope alongside the four Hindsight memory types for cheap agent-to-subagent context handoff (`commitContext`/`queryContext`/`expireContext`/`promoteToDurable` in `src/context-store.ts`). Full detail in the Decisions section of CLAUDE.md/AGENTS.md. Root suite went 379 → 390.
- **Pi startup recall (2026-07-02)** — closes the "written automatically, read manually" gap an external review flagged: memory was captured on every turn (auto-retain) but only read when the agent chose to call `engram_recall` itself. Scoped deliberately to **fresh sessions only** (not every turn, per explicit direction) — `session_start` sets a transient flag when `reason === 'new'`, and the very next `before_agent_start` recalls against the user's first prompt and prepends the formatted result to the system prompt, then the flag is consumed so later turns aren't affected. `startupRecall()` in `adapter.ts` (pure, reuses core's `formatForPrompt`); wiring in `index.ts`. On by default; `ENGRAM_PI_STARTUP_RECALL` / `_MAX_CHARS` / `_TOPK` env vars. Pi suite went 74 → 82 tests.
- **Main suite:** 390 tests across 23 files, green on Node 20 and Node 24. The 2 AQL cross-process suites (`aql-equivalence`, `aql-e2e-process`) need `cargo` and pass when it's present. Format + lint clean.
- **Pi extension suite:** 82 tests across 6 files, green and CI-gated on Node 20 and 24 (run locally via `cd integrations/pi && npx vitest run`).

---

## Next session — start here

The Pi adapter's big auto-behaviors (session bridge, consolidation, auto-retain) are all in and CI-gated. Remaining open work, roughly by leverage:

1. **Validate against a live Pi agent** — the lifecycle behaviors (auto-retain on `message_end`, consolidation on `turn_end`, the `engram` CLI shell-out loop) are unit/smoke-tested but haven't run against a real running Pi agent end-to-end. This is the main confidence gap; needs a live Pi runtime.
2. **AQL Phase 2 — write statements** (`engram-aql`): the largest remaining lift; design challenge is coordinating Rust-side writes with the TS retain pipeline (embeddings + extraction queue). See the AQL section below.
3. **Pi packaging** — make `engram-pi` `pi install`-able (npm publish vs git-ref; swap the `file:../..` engram dep for a version range).
4. **Pi memory-inspector UI widget** (`ctx.ui.custom()`) — nice-to-have.

Environment note: the suite runs on **Node 20 or 24** — a plain `npm ci` fetches the right `better-sqlite3` prebuild for either. A `cargo` toolchain is still needed for the 2 AQL cross-process suites.

---

## Done — Task-scoped ContextStore (2026-07-01)

Confirmed design (post-audit, user-approved 2026-07-01):
- New discriminant `chunks.scope IN ('durable','task')` — NOT reusing the word
  "working" (collides with the existing `working_memory` table / AQL `Working`
  type, which is a different, already-shipped concept).
- `memory_type` stays untouched; artifacts store as `memory_type='experience'`.
- TypeScript only, canonical impl alongside `retain.ts`/`recall.ts`. No new AQL
  MemoryType, no engram-aql changes this pass.
- Default `recall()` behavior (scope unset) must stay 100% unchanged — scope
  defaults to `['durable']` so all existing tests keep passing.
- `reflect.ts` AND the `v_unreflected` view both get `scope = 'durable'` added
  (two separate query paths surfaced by the audit).

Steps (all done):
- [x] `schema.sql`: added scope/expires_at/parent_ref/agent_id/artifact_json
      to chunks + indexes (created in engram.ts, not schema.sql — see below);
      `v_unreflected` view requires `scope = 'durable'`
- [x] `engram.ts`: guarded ALTER TABLE migration for the 5 new columns.
      **Found and fixed a real bug during migration testing**: the 3 new
      indexes must NOT be in schema.sql's unconditional index block —
      `CREATE INDEX IF NOT EXISTS` on a column that doesn't exist yet fails
      outright (unlike `CREATE TABLE IF NOT EXISTS`, which silently no-ops),
      so opening a genuine pre-existing `.engram` file threw `no such column:
      scope`. Fixed by creating the 3 indexes unconditionally in engram.ts
      *after* the column-guards, where the column is guaranteed present
      either way (fresh CREATE TABLE or just-ran ALTER).
- [x] `reflect.ts`: added `scope = 'durable'` to the inline unreflected query
- [x] `recall.ts`: added `scope`/`parentRef` to `RecallOptions`/`QueryFilters`,
      threaded through all 4 strategies via `buildScopeFilter`. **Found and
      fixed a second bug**: the lazy-expiry check compared JS
      `Date#toISOString()` (`...T...Z`) against SQLite's `datetime('now')`
      (`YYYY-MM-DD HH:MM:SS`) as raw strings — 'T' (0x54) always sorts after
      ' ' (0x20), so `expires_at > datetime('now')` was true unconditionally
      and nothing ever expired. Fixed by wrapping both sides in `datetime()`,
      matching the existing `buildTemporalFilter` convention.
- [x] `src/context-store.ts`: ContextRef/TaskScope/DecisionArtifact/
      TokenBudget/ContextSlice types + commitContext/queryContext/
      expireContext/promoteToDurable functions
- [x] `engram.ts`: wired commitContext/queryContext/expireContext/
      promoteContext instance methods + re-exported types
- [x] tests: `tests/context-store.test.ts`, 11 tests — commit/query
      round-trip, TTL expiry (lazy, read-time), budget truncation w/
      truncated flag, RRF-parity vs plain recall(), integration example
      (2 siblings under a shared parent, tight-budget child query)
- [x] `README.md`: "Task-Scoped Context (ContextStore)" section with a
      comparison table vs. Working Memory, to head off the name confusion
- [x] `CLAUDE.md`/`AGENTS.md`: file-structure tree + a Decisions bullet,
      mirrored per the repo's own sync rule
- [x] full suite green: 390/390 TS tests (was 379), `cargo test` in
      `engram-aql/` unaffected (105 tests, schema is shared but Rust doesn't
      reference the new columns yet — out of scope for this pass)

## Phase 2 — Pi adapter

- [x] **Reflect/extract scheduling from Pi** — shipped 2026-06-19 (branch `feat/pi-reflect-scheduling`). Implemented as below; 14 new tests (adapter cadence/reachability + binding lifecycle). Docs in `docs/PI-INTEGRATION.md` ("Background consolidation").
  Design: **turn-based cadence + shutdown flush, non-blocking, overlap-guarded.**
  - `turn_end`: increment a turn counter. Every `EXTRACT_EVERY_TURNS` (default 3) turns *and* when the extraction queue has pending items → `processExtractions()` in the background. Every `REFLECT_EVERY_TURNS` (default 12) turns → `reflect()` in the background. Never awaited inside the turn; a single in-flight guard prevents overlap.
  - `session_shutdown`: await any in-flight cycle, then run a final flush (drain extractions + one `reflect()`), bounded by a 30s timeout so a wedged Ollama can't hang exit. Then close.
  - **Ollama unreachable:** detected by classifying connection errors (`ECONNREFUSED`/`fetch failed`/`ENOTFOUND`) thrown by the generator. Behavior: `ctx.ui.notify(...)` **once** per session (warning), silent thereafter. Shutdown flush stays silent (UI gone).
  - Intervals overridable via `ENGRAM_PI_EXTRACT_EVERY_TURNS` / `ENGRAM_PI_REFLECT_EVERY_TURNS` / `ENGRAM_PI_EXTRACT_BATCH`.
  - Pure decision (`planConsolidation`) + effectful runner (`runConsolidation`) in `adapter.ts`; counter/guard/once-warning state + hook registration in `index.ts`. Test hooks `_setSchedulingConfigForTesting` / `_getPendingConsolidationForTesting`.

- [x] **Auto-retain conversation turns** — shipped 2026-06-19 (branch `feat/pi-auto-retain`). 15 new tests (adapter planning/extraction/effectful + binding lifecycle). Docs in `docs/PI-INTEGRATION.md` ("Auto-retain").
  Design: hook **`message_end`**, capture **all conversational roles**, **on by default**.
  - Role → provenance: `user` → `experience`/`user_stated`/0.7; `assistant` → `experience`/`agent_generated`/0.5; `toolResult`/`bashExecution` → `experience`/`tool_result`/0.4. Internal roles (`branchSummary`, `compactionSummary`, `custom`) skipped. The `tool_result` tier means captured tool output can never outrank user directives at recall (trust layer).
  - Gating: extract text from `content` (string or `TextContent[]`); skip empty/whitespace, skip user `/command` invocations, skip below `minChars` (default 8), **truncate to `maxChars` (default 4000)** so giant tool outputs don't bloat the DB. Exact/near dupes handled free by retain's normalized `text_hash` dedup.
  - Enabled by default; disable with `ENGRAM_PI_AUTO_RETAIN=0`. Tunable: `ENGRAM_PI_AUTO_RETAIN_MIN_CHARS`, `ENGRAM_PI_AUTO_RETAIN_MAX_CHARS`.
  - Fire-and-forget retain (fast, in-process — no LLM); lazy-open preserved (only opens when a message passes gating). Pure `planAutoRetain(message, config)` + effectful `autoRetain(engram, …)` in `adapter.ts`; `message_end` registration + env state in `index.ts`. Test hooks `_setAutoRetainConfigForTesting` / `_getPendingAutoRetainForTesting`.

- [ ] **Memory inspector UI widget**
  Use `ctx.ui.custom()` to render a live panel of recent chunks/opinions during a Pi session. Nice-to-have.

- [ ] **Publish `engram-pi` as `pi install`-able**
  Phase 1 ships in-repo; consumers symlink or use `-e`. The `prepare` script (added 2026-06-06) already makes the **git-ref install** path build a working `dist/`, so the dist-build half is solved. Remaining decision: npm publish under `@swift-innovate` vs. git-ref-only, plus a versioning policy. Note `engram-pi` resolves `engram` via `file:../..` today — a published flow needs that swapped to a real version range.

- [ ] **Validate the `engram` CLI skill against a live Pi agent**
  `skills/cli-memory/SKILL.md` + the `engram` bin shipped 2026-06-05 with unit-tested `--json` contracts, but the end-to-end loop (Pi agent shells out, pipes context on stdin, branches on exit code) hasn't been run against a real agent yet. Confirm the documented JSON shapes survive a round-trip and the recall→answer→retain cadence is what the SKILL prescribes. Also worth measuring: the CLI is a candidate to sidestep the ~10s mcporter cold-start noted in the OpenClaw integration — a per-call `engram recall` may or may not beat it (cold Node + embedder init per invocation); benchmark before recommending it as the OpenClaw path.

## Phase 2 — AQL Rust binary

> **Design decided 2026-06-24** — `docs/superpowers/specs/2026-06-24-engram-aql-writes-and-vector-search-design.md`.
> **Implementation plan (2026-06-25)** — `docs/superpowers/plans/2026-06-24-engram-aql-writes-and-vector-search.md` (TDD task breakdown; 2a vector reads first, then 2b writes).
> Decision: Rust stays DB-read-only; it lazily spawns a warm `engram-mcp` (TS) child and speaks MCP/JSON-RPC for the one thing it can't do itself — query embedding (`engram_embed`) and writes (delegate to existing `engram_retain`/`_supersede`/`_forget`). Vector search runs in Rust via a **native `vec_distance_cosine` scalar fn** (no `sqlite-vec` dep, no `vec0` virtual table — TS stores plain LE-f32 BLOBs). Embedding-compatibility (same `nomic-embed-text-v1.5` + query/document prefixes) is the constraint that forces the TS bridge.

- [x] **Phase 2a — Vector similarity search (reads)** — **DONE 2026-06-25** (branch `feat/aql-phase2a-vector`). Shipped: `engram_embed` TS MCP tool (+ `Engram.embedForMode`); native `vec_distance_cosine` scalar fn + LE-f32 codec (`engram-aql/src/vector/`, no `sqlite-vec` dep); synchronous `engram-mcp` bridge (`src/bridge/`, `std::process` — sync because the query path is sync and the `mcp` subcommand's tokio runtime would panic on a nested `block_on`); `ExecCtx` variable threading (`src/exec_ctx.rs`); `LIKE`/`PATTERN` wired in `recall.rs` (string var → bridge embed; numeric-array var → direct probe; single-bind subquery so `THRESHOLD` filters before `LIMIT`); `variables` in the `engram_aql` MCP tool + `--var name=value` in the `query` CLI; LOAD/non-chunks `LIKE` warn (no embeddings). Tests: 9 `vector_search` + 3 MCP/CLI surface + L2 `tests/aql-vector-equivalence.test.ts` (native cosine == sqlite-vec ordering). engram-aql suite green; root suite 378. **NOTE:** `LINK` still rejected; CI does not build/test the Rust crate (cargo runs locally only) — the L2/L3 TS suites that spawn the binary still gate on `cargo`.

- [x] **Phase 2b — Write statements** — **DONE 2026-06-25** (branch `feat/aql-phase2b-writes`). `STORE`→`engram_retain` (payload→retain opts; pass-through provenance so unspecified sourceType/trustScore inherit retain defaults), `UPDATE`→`engram_supersede` (RO-resolve target ids, supersede each), `FORGET`→`engram_forget` (RO-resolve ids, forget each), `REFLECT`→`engram_reflect` (global cycle). All in `statements/write_delegate.rs`; dispatch routes them; `write_reject` now handles only `LINK`. Bridge gained a generic `call_tool` (`src/bridge/call.rs`); `embed_query` reuses it. Writes target chunk-backed memory only (SEMANTIC/EPISODIC). Pipeline now reports a stage's `InvalidQuery` as a graceful stage failure. Tests: write_delegate unit + repurposed write_rejection guards + 4 gated round-trips (`tests/write_delegate.rs`) proving STORE/FORGET/UPDATE persist through the bridge and **cross-process WAL visibility holds with no refresh** (Rust RO autocommit reads see the bridge child's commits immediately). 110 cargo tests green.

- [ ] **AQL remaining (deferred):**
  - **`LINK`** — needs a canonical TS surface for manual relation authoring (relations are extraction-derived today). Still rejected at dispatch.
  - **Transactional `PIPELINE` mixing reads + writes** — a pipeline stage that reads its own prior write within one pipeline (spec Open Q2). Not yet exercised.

## Process / hygiene

- [x] GitHub repo setting **"Automatically delete head branches"** enabled on 2026-06-19 (`delete_branch_on_merge=true`) — future PR merges auto-clean their branches.
- [x] **CI covers `integrations/pi`** (2026-06-19) — the `check` job now installs, typechecks, builds, and tests the Pi extension after the root build, on the `[20, 24]` matrix. Previously only the root package was gated; the Pi suite ran locally-only.
- [ ] **Keep `AGENTS.md` ≡ `CLAUDE.md` in sync.** They're verbatim mirrors (only the "you are here" marker differs). Every architecture/file-structure/decision edit must land in both. `AGENTS.md` is tracked and a CI step (`.github/workflows/ci.yml`) already guards that `diff` between them stays empty apart from that marker — keep both edited together.
- [ ] The "Integration with valor-engine" example in `CLAUDE.md`/`AGENTS.md` still says `Engram.open('./myAgent.engram')` — verify this still matches the consumer pattern in valor-engine when next touching that integration.

## Picked-up reference

- Pi extension reference (slash commands + LLM tools): `docs/PI-INTEGRATION.md`
- OpenClaw integration (external plugin + migration CLI): `docs/OPENCLAW-INTEGRATION.md`
- Adapter map: `integrations/README.md`
- AQL design (Phase 1): `docs/superpowers/specs/2026-04-12-engram-aql-rust-binary-design.md`
- AQL implementation plan (Phase 1): `docs/superpowers/plans/2026-04-12-engram-aql-rust-binary.md`
- AQL design (Phase 2 — writes + vector): `docs/superpowers/specs/2026-06-24-engram-aql-writes-and-vector-search-design.md`
- AQL implementation plan (Phase 2 — writes + vector): `docs/superpowers/plans/2026-06-24-engram-aql-writes-and-vector-search.md`
