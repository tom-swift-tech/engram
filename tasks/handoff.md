# Handoff — Engram (updated 2026-07-14, wrap 5 — #31 & #32 MERGED)

## Base commit / branch state

- **Working tree is on `main` @ `059b884`, clean.** This is where a fresh `go`
  lands. Post-merge verification on `059b884`: typecheck ✔ + build ✔.
- **No open PRs, no feature branches in flight.** Both this-session PRs merged:
  - **PR #31 (D5 reflectCatchUp)** squash-merged → `main@c0e90f7`.
  - **PR #32 (node-origin provenance)** squash-merged → `main@059b884`.
  Both branches auto-deleted (local + remote) by the squash-merge.
- Stale local branches still listed (pre-existing, unrelated, harmless):
  `chore/ci-pi-suite`, `docs/aql-writes-vector-design`, `docs/refresh-current-state`,
  `feat/pi-auto-retain`, `feat/pi-reflect-scheduling`. Delete anytime; not ours.

## Where we are — sprint essentially DONE; only Step 6 (a decision) remains

The D1–D6 remediation sprint (#30), D5 catch-up (#31), and node-origin
groundwork (#32) are all merged to `main`. The ONLY remaining sprint item is
**Step 6**, which is a human decision, not code (see NEXT STEPS).

### This session's work: Node-Origin Provenance (#32, merged)

Groundwork so a future sync/merge has provenance natively — nothing to backfill
onto un-tagged memories. **Additive, no distribution** (no merge/union, no
transport, no opinion-model change, ZERO new MCP tools — surface-parity stays 14).

| Piece | Where | Behavior |
|-------|-------|----------|
| Schema | `src/schema.sql` | Nullable `node_origin TEXT` on `chunks`, `opinions`, **and** `observations` (all 3 durable outputs); fresh installs only |
| Migration | `src/engram.ts` `init()` | Guarded `ALTER TABLE ADD COLUMN` ×3 + partial `WHERE node_origin IS NOT NULL` indexes AFTER the guards (same pattern as text_hash/scope; `schema.sql` carries columns but NOT indexes) |
| Identity | `src/engram.ts` `init()` | `node-<hostslug>-<8hex>` minted once in `bank_config` via `INSERT ... ON CONFLICT(key) DO NOTHING` (never regenerated, survives restart); read back, held on `private readonly nodeOrigin` |
| Stamp | `src/retain.ts` (fresh chunk INSERT) + `src/reflect.ts` (`insertOpinion`/`insertObs`) | reflect reads origin from `bank_config` once up front (own connection). **First author wins** — dedup UPDATE + reinforce/challenge/decay/obs-refresh never rewrite it |

- **NULL = pre-distribution / origin unknown.** No backfill — pre-migration rows
  stay NULL (backfilling would falsely claim authorship of pre-tracking memories).
- **Scope decision (user-confirmed this session):** the draft plan
  (`tasks/node-origin-provenance-plan.md`) was internally inconsistent about
  `observations` (Step 2 listed only chunks+opinions; Step 3's `insertObs`
  implied observations). Resolved toward **including observations** so no durable
  memory needs backfilling later.
- **Out of scope (downstream, only justified by an actual merge):** opinion
  mutability stays in-place (append+supersede is the sync sprint's job); no
  merge/union/conflict logic; no transport. Documented in the CLAUDE.md/AGENTS.md
  Decisions entry.

**Verification (all green, on `main@059b884`):** root vitest **562** (+5 from
`tests/node-origin.test.ts`), Pi vitest **115**, typecheck + build + lint +
**format:check** clean, `surface-parity` pinned at **14**, CLAUDE.md ↔ AGENTS.md
re-synced (diff = only the "you are here" marker). openclaw (67) untouched.

## NEXT STEPS

1. **Step 6 (consolidate vs expand)** — decision, not code. The 329 MB
   single-file-git premise; audit ContextStore / engram-aql for earned keep.
   **Needs a human call — surface it before writing anything.** This is the LAST
   sprint item; everything else is merged.

**Explicitly OUT OF SCOPE (user correction, carried forward):** any purge /
maintenance / data-cleanup script for a live consumer store. Live agent stores
are operator-owned data. The library's job is the *code defect* (stop producing
bad data); cleaning already-written data is the operator's, and the library
ships **no** purge tooling. See `tasks/lessons.md` 2026-07-14.

## Gotchas carried forward (still live)

- **Pre-push MUST include `npm run format:check`** — SEPARATE CI gate from `lint`
  (eslint ≠ prettier). Run `npm run format` before committing. Scope is
  `src/**/*.ts` + `tests/**/*.ts` only.
- **Markdown is NOT held to Prettier** — don't reformat `.md`; match hand style.
- **CLAUDE.md ↔ AGENTS.md**: edit both together; `diff CLAUDE.md AGENTS.md`
  should show only the "you are here" marker.
- **Guarded `ALTER TABLE ADD COLUMN` pattern** (now proven for `text_hash`,
  `next_retry_after`, ContextStore scope cols, AND `node_origin`): add the column
  in `engram.ts` under a `pragma('table_info')` guard, create its index
  UNCONDITIONALLY *after* the guards — never put a `CREATE INDEX` on a new column
  in `schema.sql` (it runs wholesale on a pre-existing file where the column
  doesn't exist yet and fails hard). Columns-for-fresh-installs go in `schema.sql`.
- **`node_origin` read paths differ**: the `Engram` instance holds it
  (`this.nodeOrigin`) and threads it into `retain()`; `reflect()` has its own
  connection so it re-reads from `bank_config`. Both stamp NULL on a
  pre-distribution bank — that's correct, not a bug.
- **Never compare scores across two `recall()` calls in tests without
  `decayHalfLifeDays: 0`** — decay makes scores wall-clock-dependent.
- **Bash tool is Git Bash** — no PowerShell `@'...'@` here-strings; use `-F
  <file>` for multi-line commit messages (or a heredoc to a temp file).
- **dist is ESM w/ top-level await** — Node smoke script must be `.mjs`, dynamic
  `import(pathToFileURL(distPath).href)`, not `require()`.
- **Rebuild `integrations/pi/dist`** before trusting a Pi built-dist smoke fail.
- cargo blocked by Windows Application Control in SOME paths (AQL tests only).

## Parallel-worktree recipe (reuse for the next fan-out, if any)

- Lead resolves verified HEAD → SHA, `git worktree add -b <branch> <path> <sha>`
  per lane BEFORE spawning; disjoint positive-scope file list per builder.
- Worktrees lack `node_modules` (git only checks out tracked files) — junction
  each to the main tree's: `New-Item -ItemType Junction -Path <wt>/node_modules
  -Target <main>/node_modules` (PowerShell). Also junction `integrations/pi/
  node_modules` and (for any built-dist test) `dist` for pi lanes.
- Builders MUST NOT run `npm install` / `npm run build` (race shared junctioned
  state). Vitest only reads node_modules — parallel test runs safe.
- Integrate via `git merge --no-ff` — a clean octopus merge proves disjoint
  ownership. (Node-origin was a single sequential lane; no worktrees needed.)
