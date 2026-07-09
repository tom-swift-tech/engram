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
- **Live Pi validation + startup-recall gate fix (2026-07-05)** — first end-to-end run of `engram-pi` against a real Pi install (`@earendil-works/pi-coding-agent@0.79.8`), loaded ad hoc via `pi -e`. Confirmed live: `/memory`/`/remember`/`/recall` (no LLM needed, correct provenance/trust), the in-process Transformers.js embedder, `message_end` auto-retain on real turns, and — after a fix — startup recall injecting real stored memory into a fresh `pi -p` run's answer (verified against a local Ollama model via a temporary provider entry, reverted after). **Bug found and fixed:** `reason === 'new'` (the 2026-07-02 gate) turns out to almost never fire — tracing the installed SDK showed `'new'` only fires for an explicit mid-process session switch, while *every* initial process launch (interactive or `pi -p`) reports `reason: 'startup'` regardless of whether it created a fresh session or loaded history via `--continue`/`--resume`/`--session`. A first fix attempt (treat `'startup'` as fresh when `getEntries().length === 0`) was also wrong: Pi always appends bookkeeping entries (`model_change`, `thinking_level_change`) before `session_start` fires, so raw entry count is never zero even for a blank slate. Final fix: `isFreshSessionStart(reason, priorMessageCount)` in `adapter.ts`, counting only `type === 'message'` entries — fresh for `'new'` unconditionally, fresh for `'startup'` only when zero prior messages. Pi suite went 82 → 87 tests (3 unit + 2 integration). CLAUDE.md/AGENTS.md/`docs/PI-INTEGRATION.md` updated to match.
- **Recall ranking + import tagging fixes (2026-07-06, PR #22, external contribution from a real downstream deployment)** — three related fixes found debugging a full historical import (~2,100 chunks) that was functionally invisible to `recall()`: (1) fixes #18 — `memory_type` rank was a second hard lexicographic sort key after source tier; a weakly-related `world`/`observation` chunk always beat a strongly-related `experience` chunk regardless of relevance. Converted to a soft multiplicative weight in `applyWeighting()` (`memoryTypeWeightFromRank`), consistent with how trust/decay/strategy-boost already work — only source tier remains a hard floor. (2) relates to #19 — `integrations/pi`'s general `engram_recall` tool now sets `decayHalfLifeDays: 0` explicitly rather than inheriting the 180-day default, which crushes multi-year-old content's score ~100x before relevance applies; core library default is unchanged, but README/CLAUDE.md/AGENTS.md now call out the tradeoff explicitly per the issue's ask. (3) fixes #20 — `tools/openclaw-import`'s 7 category mappings all hardcoded `sourceType: 'external_doc'` (the lowest trust tier, same as a scraped webpage) for what is first-party historical record; changed to `agent_generated`, matching how the same content is tagged on ongoing/live retain. Also additive: `ENGRAM_PI_DB_PATH` env var lets a persistent-identity Pi agent pin one database regardless of launch cwd (interactive TUI, scheduled jobs, chat bridges). PR was rebased onto the 2026-07-05 commits (conflicted on `src/recall.ts` and `integrations/pi/src/{adapter,index}.ts`, resolved cleanly — the two features touch different regions); its own `tools/openclaw-import/tests/mapping.test.ts` hadn't been updated to match the source change (8 failing tests) — fixed as part of the merge, plus added missing test coverage for `ENGRAM_PI_DB_PATH` (the PR shipped it with none). Pi suite went 87 → 88 (+1 `ENGRAM_PI_DB_PATH` test).
- **Reflect adaptive batch sizing / silent-failure fix (2026-07-06, issue #17)** — fixes the infinite-retry loop where an oversized reflect prompt caused malformed LLM JSON, which `parseReflectOutput()` swallowed into empty arrays with status `'completed'`, so the same oversized batch retried forever. `src/reflect.ts`: (1) `parseReflectOutput()` now `console.error`s the raw response length + first 500 chars on a parse failure; (2) a 0-insight cycle with `unreflected.length >= minFactsThreshold` persists a halved (floored at `minFactsThreshold`) `reflect_batch_hint` in `bank_config`, applied on the *next* cycle only when the caller didn't pass an explicit `batchSize`, and cleared once a cycle produces insights again; (3) `getExistingObservations`/`getExistingOpinions` gained a character-budget cap (`existingContextCharBudget`, default 8000, new `ReflectConfig` field) alongside the pre-existing count cap, always keeping at least one row even if it alone exceeds budget; (4) `reflect_log`/`ReflectResult.status` now distinguishes this case as `'partial'` (a CHECK value that already existed in `schema.sql` but was unused) vs. genuine `'completed'` no-op cycles (too few unreflected facts) — no schema migration needed. Two pre-existing tests asserting `'completed'` for a 0-insight full-batch cycle were updated to expect `'partial'` (the behavior they were exercising is now intentionally different, not weakened). Verified every real caller (Pi consolidation, `engram` CLI, `engram_reflect` MCP tool) calls `reflect()` with no explicit `batchSize`, so the adaptive hint applies universally, not just in tests. 10 new tests in `tests/reflect.test.ts`. Root suite went 390 → 400.
- **Main suite:** 400 tests across 23 files, green on Node 20 and Node 24. The 3 AQL cross-process/vector suites (`aql-equivalence`, `aql-e2e-process`, `aql-vector-equivalence`) need `cargo` and pass when it's present. Format + lint clean.
- **Pi extension suite:** 88 tests across 6 files, green and CI-gated on Node 20 and 24 (run locally via `cd integrations/pi && npx vitest run`).

---

## In progress — Mira field-report fixes (2026-07-07)

Two confirmed library bugs from the largest live deployment (6.5k chunks, 29k
entities); both only manifest at scale.

- [x] **Clamp LLM-emitted `entity_type` before INSERT** (`src/retain.ts` ~562).
      Schema CHECK allows person/project/organization/technology/location/
      concept/event/tool; the model occasionally invents off-list types
      ("company"), which aborts the whole chunk's extraction transaction and
      burns all 3 retries on the same output. Fix: normalize + fall back to
      `'concept'`. Also skip entities missing a usable `canonical_name` (same
      failure class — one malformed entity kills the batch).
- [x] **NULL-safe stalled-extraction sweep** (`src/retain.ts` ~465/478).
      `last_attempt < datetime(...)` is NULL-poisoned — a `processing` row
      with NULL `last_attempt` matches neither recovery branch and is stuck
      forever (Mira's `chk-9d1d3b65-f60`, 3+ hours). Fix: `last_attempt IS
      NULL OR ...` in both UPDATEs.
- [x] Tests for both in `tests/retain.test.ts` (existing describe blocks) —
      root suite 400 → 403, all green.
- [x] Full suite green (`npm test`), commit to `main`, push.
- [x] Upgrade note for Mira drafted (relayed via Tom) — her deploy base
      `d5d7dd8` predates the #17 reflect fix, #18 ranking fix, #19 decay
      fix, and these two (landed as `30476f7`).

Follow-up enhancements (Mira's #8/#9), same session:

- [x] **`failed_reasons` breakdown in queue stats** — `getQueueStats` now
      returns distinct failed-item error messages with counts (top 10, most
      common first), so an outage is self-diagnosing ("11× fetch failed")
      across all three transports for free.
- [x] **Requeue surface for terminally-failed extractions** — failed was a
      dead end after 3 attempts (an outage stranded recoverable items).
      New `requeueFailedExtractions()` core fn + `Engram` method, 9th MCP
      tool `engram_requeue_failed` (optional `errorLike` substring filter),
      CLI `requeue-failed [--error-like]`. Resets attempts/backoff; skips
      deactivated chunks. Docs: README, skills/engram.md,
      skills/cli-memory/SKILL.md, CLAUDE.md+AGENTS.md (mirrored).
      Root suite 403 → 411; Pi suite 102 green; mirror diff clean.

## Planned — 2026-07-09 codebase-review remediation

Source: full-codebase review (2026-07-09) at HEAD `4cd4630`. Verified green
before planning: root 413, Pi 104, openclaw-import 67, build clean, AQL
cross-process suites passing. Findings fall into four buckets: doc drift,
correctness quick-wins, agent-surface gaps, and scaling walls. Phases are
ordered by leverage-per-risk; each phase is independently shippable and ends
with the verification-loop pipeline. Phases 1–2 are parallel-safe (disjoint
files); Phase 3+ items each get their own worktree per the parallel-builder
policy.

### Phase 0 — Docs truth + drift guard (no behavior change) [builder, single slice]

**DONE 2026-07-09** (branch `fix/phase0-surface-parity-docs`). Root suite
413 → 418 (2 embed CLI tests + 3 parity tests, embed added to the --json
contract sweep). Also fixed pre-existing lint/format failures from `4cd4630`
(9 files unformatted + one unused var in `tests/context-store.test.ts`) —
main was red on CI before this branch.

The review found CLAUDE.md's tool-surface claims stale (the `engram_embed`
Phase-2a tool made it 10 MCP tools, not 9, and broke the documented CLI↔MCP
1:1 mapping). Fix the docs AND make this class of drift a test failure.

- [x] **Add `embed` CLI subcommand** (`src/cli.ts` + `src/cli-args.ts`) —
      restores the 1:1 CLI↔MCP invariant (decision: keep the invariant rather
      than mark `engram_embed` internal; it's trivial and the invariant is
      what makes the skill docs trustworthy). `--json` emits the raw
      `embedForMode` return; text from arg or stdin like every other command.
- [x] **Drift-guard test** (new `tests/surface-parity.test.ts`): asserts
      `ENGRAM_TOOLS` ↔ `CLI_COMMANDS` (new canonical list in `cli-args.ts`)
      set-equality, pins the count at 10, and behaviorally invokes every
      command through `runCli` so the list can't drift from the dispatch
      switch either. Doc counts can still drift; the *surface* no longer can.
- [x] **Docs sweep** (CLAUDE.md + AGENTS.md together, mirror rule):
      "9 tools" → 10 everywhere (Decisions bullet, MCP surface bullet,
      `mcp-tools.ts:5` header comment, `skills/engram.md`,
      `skills/cli-memory/SKILL.md`, README tool table); test counts
      411→current root / 102→current Pi; **soften the "~5ms retain" claim**
      (SQLite write is ~5ms; default in-process CPU embedding dominates at
      tens-to-hundreds of ms — say so, and note the mock/Ollama-GPU paths);
      document the FTS sanitizer tradeoff (punctuation stripped ⇒ no phrase
      queries, implicit AND); `docs/PI-INTEGRATION.md` — add the
      non-interactive auto-retain downgrade path (`inferred`/0.3,
      `adapter.ts:660`); `skills/engram-session.md` — drop the phantom
      `status: "in_progress"` field from the example response shape.
- [x] Verification: full pipeline + mirror diff clean — lint, format:check,
      typecheck, build all green; root 418 + Pi 104; mirror regenerated from
      CLAUDE.md and diff-verified with the CI guard's exact filter.

### Phase 1 — Correctness quick-wins [builder ×2, parallel-safe: disjoint files]

**DONE 2026-07-09.** Two builders in isolated worktrees off `2a54741` (the
Phase 0 tip), disjoint file ownership, both reviewed and approved. Slice A
landed as `7c28b4a` on `fix/phase1a-atomic-supersede-opinion-dedup` (also
touched `src/retain.ts` — the atomic seam is a `RetainOptions.supersedes`
field handled inside retain's own transaction, since retain's async embed
means the transaction can't be wrapped externally; self-supersede and
missing-target edge cases tested). Slice B landed as `a0ea502` on
`fix/phase1b-temporal-fts` (graph strategy keeps the plain sanitizer; a new
`sanitizeQueryForFts` feeds only the keyword strategy). Combined integration
merge verified locally: 460/460 tests, typecheck + lint clean, zero merge
conflicts.

Slice A (`src/engram.ts`, `src/reflect.ts`):
- [x] **Atomic `supersede()`** (`engram.ts:702-714`) — wrap the retain +
      `UPDATE … superseded_by` in one better-sqlite3 transaction. Note:
      `retain()` currently owns its own transaction; nested transaction via
      savepoint or restructure so the UPDATE joins retain's transaction.
      Test: crash-window semantics (inject a throw between the two steps,
      assert rollback leaves the old chunk active and no orphan new chunk).
- [x] **Dedup `direction:'new'` opinions** (`reflect.ts:710-726`) — route
      through the existing `findMatchingOpinion`/`beliefSimilarity` before
      insert; a match converts the verdict to a reinforcement instead of a
      duplicate row. Test: same belief re-stated as "new" across two cycles
      yields 1 opinion with raised confidence, not 2 rows.

Slice B (`src/temporal-parser.ts`, `src/recall.ts`):
- [x] **Gate bare-year temporal auto-parse** (`temporal-parser.ts:378-389`) —
      a bare 2000–2100 integer only becomes a year filter with corroborating
      context (month name, "in/since/during/before/after <year>", date-ish
      punctuation). "error code 2048" / "port 2020" must NOT constrain
      recall. Keep explicit `after`/`before` options untouched. Tests for
      both directions (real year phrases still parse; numeric false
      positives don't).
- [x] **FTS phrase support** (`recall.ts:269-274`) — instead of stripping all
      punctuation, preserve double-quoted phrases as FTS5 phrase queries
      (escape internal quotes); strip only genuinely unsafe operators
      outside quotes. Test: quoted phrase matches adjacent tokens, unquoted
      behavior unchanged, no FTS5 syntax error on pathological input
      (fuzz the sanitizer with the existing pathological-query test corpus).
- [x] Verification per slice; both land before Phase 2 starts (Phase 2
      builds on recall.ts). Per-slice full suites 427 (A) / 451 (B) green;
      combined merge 460 green.

### Phase 2 — Agent-surface completion [builder, sequential slices; recall.ts is the shared spine]

- [ ] **`minScore` relevance threshold + score observability**
      (`src/recall.ts`, `src/mcp-tools.ts`, `src/cli-args.ts`):
      `RecallOptions.minScore` filters the fused set post-weighting;
      each result gains an optional `strategyScores` breakdown (per-strategy
      rank/score that fed RRF) behind a `explainScores?: boolean` opt so the
      default payload stays lean. Add one plain sentence to the
      `engram_recall` tool description + skills: "`results[0]` is
      best-in-highest-tier, not best-overall; re-sort by `score` for pure
      relevance." Expose `--min-score` / `--explain-scores` in the CLI.
- [ ] **Session lifecycle over MCP + CLI** (`src/mcp-tools.ts`, `src/cli.ts`):
      extend `engram_session` (or add `engram_session_update` /
      `engram_session_snapshot` — prefer extending the existing tool with an
      `action` enum to keep tool count from creeping; decision for the
      architect if ambiguous) so an MCP-only agent can resume→update→snapshot
      a working session, matching what Pi already has. CLI `session`
      subcommand grows the same actions. Update `skills/engram-session.md`
      to drop the "direct API only" caveat.
- [ ] **ContextStore agent surface** (`src/mcp-tools.ts`, `src/cli.ts`):
      `engram_context_commit` / `engram_context_query` /
      `engram_context_promote` wrapping the existing tested core fns —
      the subagent-handoff feature is fully built but unreachable by any
      LLM today. CLI subcommands to match (keeps the parity test honest —
      it will FAIL when the tools land without CLI twins, by design).
      Skills: new section in `skills/engram.md`.
- [ ] **Widen Pi `engram_recall`** (`integrations/pi/src/{types,index}.ts`) —
      pass through `memoryTypes` / `after` / `before` / `strategies` /
      `minScore`; typebox schemas + adapter plumbing + tests.
- [ ] Docs: README tool table, CLAUDE.md/AGENTS.md Decisions bullet updated
      (tool count changes again here — the Phase 0 parity test keeps us
      honest), `docs/PI-INTEGRATION.md` tool list.
- [ ] Verification: full pipeline; MCP round-trip tests for every new/changed
      tool; CLI `--json` contract tests.

### Phase 3 — Scaling walls [architect spike first, then builder+operator]

Both issues are invisible at the current largest deployment (~6.5k chunks)
and will surface as unexplained slowness at 50k+. Benchmark-gated: no
optimization lands without a before/after number.

- [ ] **Benchmark harness first** [operator] — script (scratch, not shipped)
      that builds synthetic `.engram` files at 5k/50k/200k chunks +
      proportional entities, measures p50/p95 `retain()` and `recall()`.
      This is the acceptance gate for both items below.
- [ ] **Semantic-scan fix** [architect spike → builder] — today
      `vec_distance_cosine` full-scans every active chunk
      (`recall.ts:379-390`). Options to evaluate: (a) sqlite-vec `vec0`
      virtual table (true ANN, but a schema migration + backfill of existing
      BLOBs + the Rust crate reads the same file — check `engram-aql`
      compatibility), (b) FTS/entity candidate pre-filter feeding a bounded
      cosine re-rank (no migration, weaker recall). Spike output: one-page
      decision doc in `docs/superpowers/specs/`, then implement the winner.
      Constraint: existing `.engram` files must keep working (guarded
      migration pattern already established in `engram.ts`).
- [ ] **Tier-1 extraction off the hot path** [builder] — the `INSTR()`
      entity full-scan (`extract-cpu.ts:231-240`) runs inside the retain
      transaction. Fix: move Tier-1 linking out of the write transaction
      (post-commit, still synchronous-cheap) AND bound the scan (candidate
      tokens → indexed exact/prefix lookup on `canonical_name` instead of
      INSTR over all rows). Acceptance: retain p95 flat as entity count
      grows 1k→30k in the benchmark.
- [ ] Verification: benchmark before/after in the PR description; full suite;
      AQL L2/L3 suites specifically (shared-file schema compatibility).

### Phase 4 — Memory quality (design-heavy) [architect first]

- [ ] **Near-duplicate consolidation** [architect design → builder] —
      auto-retain accumulates paraphrases that exact `text_hash` dedup
      misses. Candidate design: at retain time, optional cosine check
      against top-1 semantic neighbor above a similarity threshold →
      reinforce (bump access metadata / merge provenance) instead of insert;
      or a batch `consolidate()` pass alongside reflect. Decide: write-time
      vs batch (write-time adds an embedding-space query to the hot path —
      weigh against Phase 3 gains). One-page design doc first.
- [ ] **Entity resolution** [architect design → builder] — Tier-1 makes
      every capitalized mid-sentence word a `concept` entity, never captures
      multi-word entities, and nothing merges aliases ("TJ Swift" vs
      "Tom Swift", Mira's live report). Scope: (a) multi-word proper-noun
      capture in `extract-cpu.ts`, (b) an alias table or
      `entities.canonical_id` self-reference + merge pass during Tier-2
      extraction, (c) a `resolveEntity()` surface so graph recall follows
      aliases. This is the biggest open design in the memory-quality bucket
      — spec in `docs/superpowers/specs/` before any code.
- [ ] Verification: full pipeline + a regression corpus (the pathological
      inputs from Mira's deployment make good fixtures).

### Cross-cutting rules for all phases

- Every doc edit lands in CLAUDE.md AND AGENTS.md (CI mirror guard).
- Conventional commits on feature branches; one PR per phase (Phase 1 may be
  two PRs, one per slice).
- Parallel builders (Phase 1 A/B) get separate worktrees + lead-resolved
  base SHA per the global claim-lock policy.
- No phase is "done" on a green suite alone — the verification-loop skill
  pipeline runs per slice, and Phase 3 additionally requires benchmark
  numbers.

## Next session — start here

**A full-codebase review (2026-07-09) produced a phased remediation plan — see "Planned — 2026-07-09 codebase-review remediation" above. Phase 0 (docs truth + drift guard) is the cheapest highest-leverage start.**

The Pi adapter's big auto-behaviors (session bridge, consolidation, auto-retain) are all in and CI-gated. Other open work, roughly by leverage:

1. **Live-validate the remaining Pi lifecycle behaviors** — the 2026-07-05 session confirmed slash commands, auto-retain (`message_end`), and startup recall end-to-end against a real Pi install + real model (Ollama). Still not separately live-verified: background consolidation cadence (`turn_end` → `processExtractions()`/`reflect()`, needs Ollama for extraction/reflection, not just embeddings) and the `engram` CLI shell-out loop (`skills/cli-memory/SKILL.md`'s documented recall→answer→retain cadence via a real Pi agent shelling out per-call).
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
