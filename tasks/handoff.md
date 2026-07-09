# Handoff — 2026-07-09 (codebase review → remediation; Phases 0–1 MERGED)

## State

**All three stacked PRs merged into `main`.** Local tree on `main` at
`0882743` (= origin/main), clean except this handoff file. Local + remote
feature branches deleted, remote refs pruned. No worktrees.

Merge commits (merge-commit strategy, not squash — preserved slice history):

- `8dc44c0` — PR #23, Phase 0: `engram embed` CLI subcommand (restores
  CLI↔MCP 1:1), `tests/surface-parity.test.ts` drift guard (ENGRAM_TOOLS ↔
  `CLI_COMMANDS` set-equality + count pinned at 10 + behavioral dispatch
  check), docs truth sweep, and the CI repair for `4cd4630`'s lint/format
  failures.
- `8cbbcf0` — PR #24, Phase 1A: atomic `supersede()` via
  `RetainOptions.supersedes` inside retain's transaction + reflect
  `direction:'new'` opinion dedup via shared `reinforceExisting()`.
- `0882743` — PR #25, Phase 1B: bare-year temporal gating ("port 2020" no
  longer date-filters recall) + FTS5 quoted-phrase support
  (`sanitizeQueryForFts`, keyword strategy only) + doc-pass commit.

## Verification actually run post-merge (this session)

On merged `main` at `0882743`:

- Root suite: **460/460 green** (`npm test`, 24 files).
- Pi suite: **104/104 green** (`npm test` in `integrations/pi`, 6 files).
- The lint/format red that `main` carried at `4cd4630` is fixed by #23 —
  main should now be green on CI (repo CI runs the same commands that
  passed locally per-branch; not re-checked on GitHub Actions this session).

Not re-run post-merge: openclaw-import suite (67, untouched by the stack),
AQL suites (need `cargo`), `npm run lint`/`format:check` (passed on each
branch tip; #25's tip == main's tree content).

## The plan being executed

`tasks/todo.md` → "Planned — 2026-07-09 codebase-review remediation".
Phases 0–1 done and merged. Remaining, in order:

- **Phase 2 — Agent-surface completion** (next, base on `0882743`):
  `minScore` + `explainScores` on recall + `results[0]`-is-tier-major
  caveat in tool descriptions; session update/snapshot over MCP+CLI
  (prefer extending `engram_session` with an `action` enum); ContextStore
  MCP/CLI tools (`engram_context_commit/_query/_promote`); widen Pi
  `engram_recall` passthrough. Note: the surface-parity test will force a
  CLI twin + a new pinned count for every MCP tool added — by design.
  recall.ts is the shared spine — single builder or sequential slices,
  don't parallelize blindly.
- **Phase 3 — Scaling** (benchmark-gated): operator benchmark harness
  first (5k/50k/200k chunks), then architect spike on vec0-ANN vs
  candidate pre-filter for the O(N) semantic scan, then Tier-1 `INSTR()`
  entity scan off the retain transaction. AQL shared-file compatibility is
  a constraint.
- **Phase 4 — Memory quality** (architect-first, spec before code):
  near-duplicate consolidation; entity resolution (multi-word capture +
  alias merge — Mira's "TJ Swift"/"Tom Swift").

## Gotchas carried forward

- Rebuild `integrations/pi/dist` before trusting any smoke-test failure
  there (stale dist reproduces as a deterministic "flake").
- AQL suites need `cargo`; Windows Application Control policy blocks cargo
  in SOME worktree paths — "Application Control policy has blocked this
  file" is environment, not regression.
- CLAUDE.md ↔ AGENTS.md are verbatim mirrors (CI-guarded). Trick: edit
  CLAUDE.md, regenerate AGENTS.md with the two tree-marker lines swapped
  (node one-liner; see git history of `2a54741`/`08bcd6c`).
- `gh auth` here is `tom-swift-tech` (maintainer).
- PR #22 shows "Closed" not "Merged" — intentional cosmetic artifact; don't
  "fix" it.
- Parallel-builder protocol (worktree + positive scope + resolved base SHA)
  worked cleanly for Phase 1 — reuse the same brief template for Phase 3/4.

## Next steps

1. Phase 2 off `main@0882743` (see plan above; `tasks/todo.md` has the
   full task list with acceptance criteria).
2. Optionally confirm GitHub Actions is green on the three merge commits
   before starting.
