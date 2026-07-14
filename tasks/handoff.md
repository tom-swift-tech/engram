# Handoff — Engram (updated 2026-07-14)

## Base commit

`main@5cf29bf` (verified HEAD). Resolve this SHA at spawn time for any lane.
Recent lineage: `5cf29bf` lessons ← `66b5e7e` PR #29 merge (grounding) ←
`62795f5` PR #28 (introspect + reflect) ← `aa149af` PR #27 (model-resolver).

## Where we are

**Subagent Grounding Layer (Product A): DONE & MERGED.** PR #29 →
`main@66b5e7e` (merge commit; branch `feat/grounding-layer` deleted local +
remote). Spec: `docs/GROUNDING-LAYER-SPEC.md`. Plan: `tasks/grounding-layer-plan.md`.
Three pieces, all **library-only (zero new MCP tools — surface stays 14)**:

1. **`ReadonlyEngram`** (`src/readonly-engram.ts`) + **`Engram.readonlyView()`**
   — capability-restricted view exposing only `recall`/`queryContext`/
   `introspect`, over a **second `{readonly:true}` connection**. Both spec-§5
   layers: no write method on the surface **and** a driver-level `SQLITE_READONLY`
   backstop. Safe because the read path never writes (verified). Precondition:
   parent `Engram` opened (and migrated) the file first — a readonly conn can't
   migrate.
2. **`groundSubagent()` / `taskContext()`** (`src/grounding.ts`) — belief-free
   read path. `recall()` `memoryTypes` **intersected** with
   `['world','experience','observation']` (`opinion` dropped even if asked;
   empty intersection → all three, never zero), `includeOpinions:false`, durable
   scope only. `taskContext()` is an explicit pass-through to `queryContext()` —
   task context is orchestrator-selected, never auto-inherited (§8).
3. **`SubagentReport` + `metabolizeReport()`** — orchestrator-side single-writer
   metabolism: `artifact`→`commitContext`, `candidateExperiences`→`retain` as
   `agent_generated` (tier 1), challengeable by the next reflect cycle.

Deferred (spec §6): belief injection for the orchestrator's own reasoning
(blocked on the disconfirmation retrieval-gap fix, §2), MCP exposure of
`groundSubagent`, subagent working state.

**Prior merged work (context):** PR #28 (`fix(reflect)` empty-response →
`failed`; `feat(introspect)` 14th tool). PR #27 (model-resolver + preflight).

## New baselines (were 529 root / 14 tools before grounding)

- **Root vitest: 538 green** (+9 from grounding: `tests/grounding.test.ts` +
  `tests/readonly-engram.test.ts`). Surface-parity + mcp-server still pinned at
  **14 tools** (grounding added none).
- Pi 108 / openclaw 67 unchanged (untouched).
- CLAUDE.md ↔ AGENTS.md mirror re-synced (grounding decision + 2 files + 538).
  README carries the "Grounding a Subagent" section. Spec's stale "13 tools" →
  14. `skills/*` unchanged (no new tool/CLI command).
- **`recall.ts` internals UNTOUCHED by grounding** — it only imports
  `formatForPrompt`. So the D6 lane's line numbers below are still valid.

## Remediation sprint — STILL OPEN (plan in `tasks/todo.md`, off clean `main`)

None of the six D-defects are done. Lanes (disjoint files, one worktree each,
base = `main@5cf29bf` — resolve the SHA at spawn time):

| Lane | Owns | Defect |
|------|------|--------|
| **D1** | `src/extract-cpu.ts`, `tests/extract-cpu.test.ts` | word-boundary + stopword + min-len ≥4 in `strategyGraphMatching` (`:221-265`); replace `INSTR` substring matching. |
| **D6** | `src/recall.ts`, `tests/recall.test.ts`, `tests/trust-tier.test.ts` | thread cosine out of `semanticSearch` (`:446-512`), within-tier cosine-primary score + `minScore` gate; **leave `(tier,score)` comparator untouched** (security floor). Params: `cosine × 0.94–0.99 trust-bias · minScore 0.42`. NOTE: `minScore`/`explainScores` options already exist in `RecallOptions`; the within-tier cosine-primary scoring is the remaining work. |
| **D2+D4** | `src/reflect.ts`, `tests/reflect.test.ts` | D2: `findMatchingObservation` mirroring `findMatchingOpinion`, route new obs into the `observation_refreshes` seam, lexical (no schema change). D4: durability rubric in the reflect prompt; attribution guard in `resolveEntityIds`. **NOTE: `reflect.ts`/`reflect.test.ts` changed in PR #28 (empty-response guard ~line 640, 3 new tests) — re-read before editing; plan line numbers may have drifted.** |
| **D3-gate** | `integrations/pi/src/adapter.ts`, `integrations/pi/tests/auto-retain.test.ts` | cron/job detector in `planAutoRetain`/`ROLE_MAP`: refuse or downgrade job prompts so they never store as `user_stated`/0.7. |

**Purge script (deliverable only; live stores OUT OF SCOPE):** store-agnostic
maintenance script — any `.engram` path, mandatory `engram.backup()` first,
`--dry-run` default. Hard-delete (not `forget()`) FK-safe child-first
`relations → chunk_entities → entities`, then `VACUUM`. Cron-chunk filter:
`memory_type='experience' AND source='pi:conversation' AND source_type='user_stated'
AND trust_score=0.7`, narrowed by FTS/`text` on cron phrases. Validate on a
throwaway in-test `.engram`, never a live store.

**D5 (reflection catch-up)** + **Step 6 (consolidate vs expand)** come after the
code lanes.

## Gotchas carried forward (still live)

- **Pre-push pipeline MUST include `npm run format:check`** — it's a SEPARATE CI
  gate from `lint` (eslint ≠ prettier). Omitting it cost a CI round-trip on
  PR #29 (unformatted new test files). Run `npm run format` before committing.
  Scope is `src/**/*.ts` + `tests/**/*.ts` only.
- **Markdown is NOT held to Prettier** (untouched `.md` fails `--check`, and
  format:check doesn't scan `.md`); don't reformat markdown — match hand style.
- **Never compare scores across two recall() calls in tests without
  `decayHalfLifeDays: 0`** — decay makes scores time-dependent (relevant to D6).
- **CLAUDE.md ↔ AGENTS.md**: edit both together; verify with the CI mirror filter
  (`diff CLAUDE.md AGENTS.md` should show only the "you are here" marker).
- **Bash tool is Git Bash, not PowerShell** — no `@'...'@` here-strings; use a
  `-F <file>` commit-message file for multi-line commits.
- **dist is ESM with top-level await** — a Node smoke script must be `.mjs` and
  use dynamic `import(pathToFileURL(distPath).href)`, not `require()`. (Watch
  `process.argv`: `argv[2]` is the first script arg, `argv[1]` is the script.)
- Rebuild `integrations/pi/dist` before trusting a Pi smoke-test failure.
- cargo blocked by Windows Application Control in SOME worktree paths (AQL only).
