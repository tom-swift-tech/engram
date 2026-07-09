# Handoff — 2026-07-09 (Phase 2 agent-surface completion — PR open)

## State

**Phase 2 of the 2026-07-09 remediation plan is implemented, reviewed, and
verified** on branch `feat/phase2-agent-surface` (based on `main@d11733b`).
PR opening was the last act of the session — check `gh pr list` if the PR
number isn't referenced below.

Commits on the branch, in order:

- `2c27338` — Slice A: `RecallOptions.minScore` (post-weighting inclusive
  filter) + `explainScores` (per-result `strategyScores` breakdown:
  perStrategy rank/rrfScore, rawFusedScore, weighting multipliers), wired
  through `engram_recall` MCP schema + `--min-score`/`--explain-scores`
  CLI + skills. results[0]-is-tier-major caveat added to tool description.
- `7ab99cd` — Slice C: Pi `engram_recall` passthrough widened with
  memoryTypes/after/before/strategies/minScore (typebox schemas, adapter,
  tool registration); preserves the deliberate `decayHalfLifeDays: 0`
  override.
- `6c78405` — Slice B: `engram_session` action enum
  (`resume` default = byte-compatible with pre-enum tool / `update` /
  `snapshot`) + three ContextStore MCP tools
  (`engram_context_commit`/`_query`/`_promote`) + CLI twins
  (`context-commit`/`context-query`/`context-promote`); surface-parity
  pins move 10 → 13. Promote-miss returns `{promoted: false}` (exit 2 on
  CLI), mirroring `engram_forget`'s convention. expireContext deliberately
  NOT exposed (lazy expiry covers it; noted in skills).
- `70c51ed` — flake fix: the two cross-call minScore tests pin
  `decayHalfLifeDays: 0` (recency decay made scores wall-clock-dependent,
  so sequential recalls were never bit-identical — see lessons.md).
- `d1cc7fe` — docs sweep: CLAUDE.md + AGENTS.md (mirror regenerated,
  guard-verified), README tool table (13 tools), PI-INTEGRATION.md,
  todo.md Phase 2 checkboxes done + "Next session" pointer moved to
  Phase 3.

## Verification actually run (this session, at `d1cc7fe`)

- Root: typecheck, build, lint, format:check clean; `npm test` 489/489
  (24 files). Pi: 108/108 (6 files). Mirror guard clean (CI's exact
  filter, run independently of the builder that regenerated it).
- Recall suite additionally run 6× consecutively to prove the flake fix.
- Reviewer pass (committed range `d11733b..70c51ed`): clean approval,
  zero blocking. Two non-blocking nits on record: (1) `engram_session`
  schema no longer marks `message` required (runtime-validated instead —
  deliberate, enables action enum); (2) `engram_context_commit` accepts
  negative `ttlMs` un-clamped (immediate expiry; a clamp would need a
  decision on whether 0 means "no TTL" first — do NOT blind-fix).
- AQL suites not run (need cargo); untouched by this phase.
- CI on `main` is fully green — `d11733b`'s earlier red was GitHub
  runner-acquisition flake, fixed by re-run, no code change.

## Gotchas carried forward

- **Never compare scores across two recall() calls in tests without
  `decayHalfLifeDays: 0`** — decay makes scores time-dependent (lessons.md
  2026-07-09).
- ContextStore query semantics: a ref is queried as a PARENT —
  `context_query(refId)` returns children committed with
  `parentRefId: refId`, never the artifact at refId itself. Documented in
  skills/engram.md; it tripped a builder mid-phase.
- Multi-agent process: put isolation constraints (worktree, base SHA,
  file scope) in the task description at creation time — an ownership
  assignment notification races a separately-sent brief (lessons.md).
- Rebuild `integrations/pi/dist` before trusting a smoke-test failure.
- cargo blocked by Windows Application Control in SOME worktree paths.
- CLAUDE.md ↔ AGENTS.md mirror: edit CLAUDE.md, regenerate, verify with
  the CI filter (see git history `2a54741`/`08bcd6c`).
- PR #22 shows "Closed" not "Merged" — intentional, don't "fix".

## Next steps

1. Merge the Phase 2 PR once CI is green (merge-commit strategy, matching
   Phases 0–1).
2. **Phase 3 — Scaling** (see tasks/todo.md): operator benchmark harness
   FIRST (5k/50k/200k chunks, p50/p95 retain/recall) — it is the
   acceptance gate; then architect spike on vec0-ANN vs candidate
   pre-filter; then Tier-1 INSTR() scan off the retain transaction.
   AQL shared-file compatibility is a hard constraint.
3. Phase 4 (memory quality: near-dup consolidation, entity resolution)
   is architect-first — spec before code.
