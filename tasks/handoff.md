# Handoff — Engram (updated 2026-07-20, PR #44 + PR #46 merged)

## Base commit / branch state

- **`main @ 5cafd42`**, pushed, CI green on Node 20 + 24. Working tree
  clean. No open PRs, no open issues.
- Session sequence (this session, continuing from the #39-shipped handoff
  at `88c7bb2`): merged **PR #44** (`f07bc58`, external — see below) →
  authored + merged **PR #46** (`5cafd42`, this session's own work).
- Local branches: `main` (clean, up to date) + one pre-existing untouched
  stray `fix/extraction-budget-retry-gate` (local-only, not on origin, not
  investigated — carried forward from before this session, ignore unless
  asked).

## What this session did

1. **Reviewed and merged PR #44** (authored by an external agent,
   `miraswift-agent`, not this session): the Pi adapter pending-suggestions
   hint deferred from issue #39 — `before_agent_start` appends a one-line
   counter (`N pending improvement suggestions (run \`engram suggestions\`
   to view).`) when suggestions sit in `proposed`. Independently reverified
   all claims (root 630/630, Pi 139/139, typecheck/build/lint/format clean)
   before merging; found nothing to fix. Squash-merged, branch deleted.
2. **That same PR's author filed issue #45** (real finding hit while
   building #44): `integration-smoke.test.ts` doesn't isolate
   `ENGRAM_PI_DB_PATH` from the ambient shell env, so running the Pi suite
   from a shell with it exported (e.g. a systemd unit, the documented way
   to point the extension at a persistent store) can open a real store
   instead of the test's temp dir. It failed closed only by luck last time
   (embedding-dimension mismatch: 768d real store vs. 8d test embedder).
3. **Fixed issue #45 as PR #46** (this session, full ownership — designed,
   implemented, tested, opened PR, waited on CI, merged):
   `beforeEach`/`afterEach` in `integration-smoke.test.ts` now
   snapshot-clear-restore every `ENGRAM_PI_*` env var via two new helpers
   (`clearEngramPiEnv`/`restoreEngramPiEnv`, prefix-scoped so unrelated env
   vars are untouched). Added a regression test proving no
   `ENGRAM_PI_DB_PATH` survives from one test into the next, plus
   order-independent unit tests for the helpers themselves. **Reproduced
   the actual bug** before and after (`ENGRAM_PI_DB_PATH=/tmp/... npx
   vitest run tests/integration-smoke.test.ts`, confirmed the file was
   never created) rather than trusting the fix by inspection alone.
   - **Self-caught mistake worth remembering**: first pass ran
     `prettier --write` on the whole test file, which reformatted
     unrelated pre-existing code (interface defs, function signatures) and
     ballooned the diff to 428 lines. Caught it via `git diff --stat`
     looking too large, reverted to `main`'s copy, and hand-reapplied only
     the intended ~100-line change — matching PR #44's own precedent for
     this exact file (formatting in `integrations/pi` is outside the root
     `format:check` CI gate, so don't let stray reformatting sneak in).

## Verification status (this wrap)

Both merges independently pipeline-verified before merging, not just
trusted from PR descriptions:
- **PR #44**: root 630/630, Pi 139/139, tsc/build/lint/format:check clean,
  CI green Node 20+24 — reran the whole pipeline myself in a scratch
  worktree before merging.
- **PR #46**: root 630/630, Pi 142/142 (+3 over #44's baseline),
  tsc/build/lint/format:check clean, CI green Node 20+24, plus the live
  bug-reproduction check above.

## NEXT STEPS (nothing in flight)

1. **Live-store validation of the suggest pass** (issue #39 follow-up,
   precision tuning) — still open, unchanged from prior handoff: run
   `reflect --suggest` against a real long-running store and eyeball
   suggestion quality before recommending defaults change. Operator-owned
   (they run it against their store, not us — tasks/lessons.md
   2026-07-13).
2. **Phase 4 decisions** (staleness detection, review/expiry dates,
   durable-vs-conversation separation) — unchanged, evidence base in
   `evals/README.md`.
3. No open PRs, no open issues as of this wrap. The stray local
   `fix/extraction-budget-retry-gate` branch has never been investigated
   across two sessions now — worth a quick `git log` look next time to
   decide keep/delete, or just leave it (harmless, local-only).

## Gotchas carried forward

- **Pi suite fails with stale dist** — rebuild ROOT dist (`npm run build`)
  then `integrations/pi` build before trusting Pi failures.
- **Pre-push MUST include `npm run format:check`** (separate CI gate;
  scope `src/**`+`tests/**` at root only — markdown exempt, and
  `integrations/pi` is entirely outside this gate, which is exactly why
  stray reformatting there is easy to accidentally introduce and easy to
  leave uncaught — check diff size, not just CI green).
- **CLAUDE.md ↔ AGENTS.md**: edit both together; verify with a plain
  `diff` — exactly the two marker lines may differ (currently lines
  138-139, but reflow as content grows — use the grep-based check from
  CI's own workflow step, not a hardcoded line number).
- **`integrations/pi` test env hygiene (new this session, issue #45)**:
  any Pi test that reads/writes `ENGRAM_PI_*` env vars must go through
  `clearEngramPiEnv`/`restoreEngramPiEnv` in `integration-smoke.test.ts`
  (or replicate the pattern) — do not `delete process.env.X` ad hoc in a
  test's `finally`, that's exactly the fragile pattern issue #45 flagged.
- **Suggest-pass specifics** (issue #39): watermark comparisons use
  `datetime()` on BOTH sides (ContextStore TTL-bug class); watermark only
  advances on engaged runs; suggestion gates default ON unlike
  opinionGates; dismissal memory is durable — dedup consults ALL statuses
  and a dismissed match needs materially-new evidence (≥ minEvidenceCount
  NEW chunks) to reopen.
- **Never compare scores across two `recall()` calls without
  `decayHalfLifeDays: 0`.**
- **Guarded `ALTER TABLE` pattern** for new columns on existing tables;
  new TABLES are plain CREATE TABLE IF NOT EXISTS (indexes in schema.sql
  only when the table is new too).
- **Bash tool is Git Bash**; dist is ESM w/ top-level await (.mjs smoke
  scripts); CLI retain defaults `sourceType: inferred` (0.5). Note: `cd`
  does not persist across separate Bash tool calls in this environment —
  chain `cd X && command` in one invocation, or expect cwd to reset.
- **Sequenced-fetch test mocks**: multi-LLM-call flows use the
  mockFetchSequence pattern (counter-evidence/falsifier/suggestions tests).
- **Other agents work on this repo too**: PR #44/#45 came from a
  differently-identified agent (`miraswift-agent`), not this session.
  `gh pr list`/`gh issue list` at the start of a session is worth doing
  even right after a clean handoff — state can move between sessions.
