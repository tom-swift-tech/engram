# Handoff — Engram (updated 2026-07-20, PR triage COMPLETE)

## Base commit / branch state

- **`main @ aab0322`**, pushed, CI green. Working tree clean.
- Sequence this session: `23d03ad` (prior handoff, start-of-session base) →
  `f047f6a` (merge PR #35) → `b1a0244` (merge PR #36) → `aab0322` (merge PR
  #37).
- No worktrees, no lane branches in flight. Three scratch worktrees
  (`../engram-pr35`, `../engram-pr36`, `../engram-pr37`) were created for
  local verification and removed after each merge — `git worktree list`
  shows only the main checkout.
- No stale local/remote branches — each PR branch was deleted on merge
  (`gh pr merge --delete-branch`).

## What this session did

Triaged and merged **3 open PRs**, all from `tom-swift-tech` (same-repo
branches, not forks — simpler than last session's fork-remote dance):

- **PR #35** `fix(generation): bound OllamaGeneration fetch with an
  AbortSignal timeout` — `fetch()` in `OllamaGeneration.generate()` had no
  abort signal, so an unresponsive Ollama host could hang the process
  indefinitely (a caller's `Promise.race` shutdown-flush timeout only let the
  *caller* move on, never actually cancelled the fetch). Adds
  `AbortSignal.timeout(this.timeoutMs)`, default 120s, new `timeoutMs`
  constructor option; `TimeoutError` rethrown as a clear message with
  `cause`. 1 file (`src/generation.ts`), +33/-6.
- **PR #36** `feat(reflect): filter fact selection by source_type` — optional
  `sourceTypes` on `ReflectConfig`, threaded into `getUnreflectedFacts` /
  `Engram.reflect()` / `Engram.reflectCatchUp()`. Motivated by a live
  measurement: 55% of one deployment's unreflected backlog was `tool_result`
  noise vs. 1.6% `user_stated`, and chronological (`created_at ASC`) draining
  spent whole reflect cycles on the noise. Omitted → unchanged behavior;
  empty array → treated as "no filter" (never "match nothing"). Also fixed
  `countUnreflected` to filter consistently (otherwise a filtered catch-up
  pass would report `stalled` instead of `drained` once its slice was
  actually empty). 3 files, +193/-11, 5 new tests (579 total).
- **PR #37** `fix(pi): capture transient assistant narration at the
  tool_result tier` — Pi's auto-retain stored every assistant message as
  durable `agent_generated`, including one-line mid-task asides ("Let me
  check:"). Censused on a live store: 82.6% of unreflected `agent_generated`
  chunks were this narration, feeding false "beliefs" into reflection. New
  `isTransientNarration()` + `narrationMaxChars` (default 400,
  `ENGRAM_PI_AUTO_RETAIN_NARRATION_MAX_CHARS`) downgrades matches to
  `tool_result`/0.4 (never drops — stays recallable, just excluded from
  reflection via #36's filter). Tuned precision-first: start-anchored cue
  regex (not "contains"), rejected a trailing-colon heuristic (false
  positives on list-leading summaries), `NO_REPLY` only counts under 120
  chars (it's a routing marker, not a content signal). 0/2798 false
  positives on long synthesis, 0/25 on a hand-labelled probe set. 3 files
  (`integrations/pi/src/{adapter,index}.ts` + tests), +403/-50, 7 new tests
  (Pi package 129 total).

All three were same-repo (no fork-remote handling needed), CI green as
opened, no fixes required before merge — unlike last session's PR #33.

## Verification status (this wrap)

Beyond trusting each PR's own CI run, every PR was pulled into its own
throwaway worktree and verified locally before merge:

- **PR #35**: `npx tsc --noEmit` clean; `vitest run tests/generation.test.ts`
  → 18/18 green.
- **PR #36**: `npx tsc --noEmit` clean; `vitest run tests/reflect.test.ts` →
  54/54 green (includes the new drained-vs-stalled regression test).
- **PR #37**: root `npm run build` + `integrations/pi` `npm run build` (both
  needed — stale-dist gotcha), `npx tsc --noEmit` clean in `integrations/pi`,
  full Pi vitest suite → 129/129 green, then full root suite (excluding
  integrations) → 579/579 green (confirms #36+#37 didn't regress each
  other).
- `main` confirmed fast-forwarded to `aab0322` locally, matches
  `origin/main`.

## NEXT STEPS (nothing in flight; pull if wanted)

1. **Phase 4 decisions** (deferred by design, evidence-backed by the eval
   baselines in `evals/README.md`): staleness detection, review/expiry
   dates, durable-vs-conversation separation. Spec:
   `tasks/sprint-hermes-observability.md` §Phase 4. Still the most
   substantive open thread — unchanged from prior handoff, not touched this
   session.
2. Hermes report follow-up: closed last session, won't revisit unless the
   reporter surfaces again on their own.
3. No open PRs, no stale branches as of this wrap.

## Gotchas carried forward (unchanged from prior handoffs)

- **Pi suite fails with stale dist** — rebuild ROOT dist (`npm run build`)
  then `integrations/pi` build before trusting Pi failures. Hit and
  confirmed again this session (PR #37 initially failed
  `integration-smoke.test.ts` on stale Pi dist alone).
- **Pre-push MUST include `npm run format:check`** (separate CI gate from
  lint; scope `src/**`+`tests/**` only, markdown exempt). Pi package has
  pre-existing prettier drift in 4 files — not covered by root
  format:check, don't "fix" it incidentally.
- **CLAUDE.md ↔ AGENTS.md**: edit both together; diff = marker lines only.
  Not touched this session (no PR modified either file).
- **Never compare scores across two `recall()` calls without
  `decayHalfLifeDays: 0`.**
- **Guarded `ALTER TABLE` pattern**, **Bash tool is Git Bash**, **dist is
  ESM w/ top-level await (.mjs smoke scripts)**.
- CLI retain defaults to `sourceType: inferred` (0.5) — tests asserting
  `user_stated` must pass `--source-type user_stated` explicitly.
- **Cross-repo PR branches** (from prior session, still relevant if an
  external fork PR shows up again): `gh pr view --json headRefName` doesn't
  tell you it's a fork; check `isCrossRepository`/`headRepositoryOwner`
  before pushing fixes to a PR branch. Not needed this session (all 3 PRs
  were same-repo).
