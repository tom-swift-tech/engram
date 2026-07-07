# Handoff — 2026-07-07 (evening: Mira field-report session)

## State
`main` is at `b6b162b`, pushed to `origin/main`, working tree clean (only this
handoff file). No open issues, no open PRs, no worktrees, no extra remotes.

Verification actually run this session: root suite **411 tests green** (23
files, includes the cargo-gated AQL suites), Pi extension suite **102 green**
(after rebuilding `integrations/pi/dist`), `npm run build` clean, CLAUDE.md ↔
AGENTS.md mirror diff clean (only the two "you are here" marker lines).

## What happened (three commits, all direct to main)

Mira (largest live deployment: 6.5k chunks / 29k entities) sent a field
assessment. Triage: her #1 issue (reflection, 4×0-result runs) is bug #17
already fixed in `4486306` — her deploy base `d5d7dd8` predates it, plus the
#18 ranking and #19 decay fixes. Two of her reports were real library bugs;
both confirmed in code and fixed.

1. `30476f7` — **fix(retain)**: (a) LLM-emitted `entity_type` is now clamped
   to the schema CHECK list ('concept' fallback) and entities missing
   `canonical_name` are skipped — previously one off-list type ("company")
   aborted the whole chunk's extraction and burned all 3 retries; (b)
   `recoverStalledExtractions` now treats `last_attempt IS NULL` as stalled
   in both branches — `NULL < datetime(...)` matched neither branch, which is
   exactly how Mira's `chk-9d1d3b65-f60` sat in 'processing' 3+ hours.
2. `a87b402` — **feat(queue)**: `getQueueStats()` gained a `failed_reasons`
   breakdown (top-10 error messages with counts); new
   `requeueFailedExtractions()` + `Engram` method + 9th MCP tool
   `engram_requeue_failed` + CLI `requeue-failed [--error-like <substr>]`.
   Failed was terminal after 3 attempts; this is the post-outage re-drive.
   Resets attempts/backoff, keeps the old error message until overwritten,
   skips deactivated chunks. CLI↔MCP 1:1 mapping preserved.
3. `b6b162b` — **docs**: refreshed stale test counts in the CLAUDE/AGENTS
   file tree (390→411 root, 82→102 Pi, 21→22 cli.test.ts); cross-linked
   `requeue-failed` in the cli-memory skill intro.

Docs updated for the feature: README (tool table, "nine commands", examples),
`skills/engram.md`, `skills/cli-memory/SKILL.md`, CLAUDE.md + AGENTS.md
(mirrored). `tasks/todo.md` has a dated section recording all of it.

**Mira upgrade note relayed via Tom** (see session transcript): pull `main`,
run one reflect cycle and read stderr + `reflect_log.status` before touching
models; `engram requeue-failed --error-like "fetch failed"` replaces the
manual SQL for her 11 CITADEL-outage items; check `decayHalfLifeDays: 0` for
her long-horizon recall (#19).

## Next steps
Nothing pending. Repo idle. Candidate follow-ups if Tom asks:
- `engram health` CLI subcommand aggregating queue-stats + recent
  `reflect_log` rows (Mira's enhancement #2).
- Entity dedup pass (her "TJ Swift / Tom Swift" — entity resolution is
  currently exact-canonical-name only).
- Await Mira's post-upgrade report; if reflect still zeroes out on her data,
  the new logging will say whether it's parser or model.
- On generic resume: `gh issue list` / `gh pr list`, then whatever Tom brings.

## Gotchas carried forward
- Rebuild `integrations/pi/dist` before trusting any smoke-test failure there
  (stale dist reproduces as a deterministic "flake").
- Windows Application Control policy blocks `cargo build` in some worktree
  paths — AQL failures saying "Application Control policy has blocked this
  file" are environment, not regression.
- Git Bash mangles leading-slash args when shelling out to `pi` — use
  `MSYS_NO_PATHCONV=1` + `cygpath -w` for live-Pi testing.
- PR #22 shows "Closed" not "Merged" on GitHub — intentional cosmetic
  artifact; don't "fix" it. Mira's-fork thread is closed for good (her fork
  has zero unique commits); do not reopen.
- `gh auth` here is `tom-swift-tech` (maintainer).
- CLAUDE.md ↔ AGENTS.md are verbatim mirrors (CI-guarded); every doc edit
  lands in both or CI fails.
