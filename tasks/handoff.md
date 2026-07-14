# Handoff — Engram (updated 2026-07-14, wrap 4 — #30 MERGED, D5 in PR #31)

## Base commit / branch state

- **Working tree is on branch `feat/d5-reflect-catchup` @ `6f520c4`** (D5 lane,
  clean, pushed). Base `main@7ae29dd`. This is where a fresh `go` lands.
- **PR #31 (D5) is OPEN & CI-GREEN** — merge is the user's call, NOT merged yet.
  After merge: `git branch -d feat/d5-reflect-catchup`, switch main tree to `main`,
  `git pull`. (No worktrees this lane — built directly on the branch off main.)
- PR #30 squash-merged 2026-07-14 → `main@7ae29dd`; remote `remediation/sprint-d1-d6`
  deleted by the merge. All four lane worktrees (`engram-wt-{d1,d2d4,d3gate,d6}`)
  removed and their junctions torn down (main-tree `node_modules`/`dist` verified
  intact); the four local `fix/*` lane branches force-deleted (content preserved
  in `7ae29dd`). Post-merge local verification on `7ae29dd`: typecheck ✔ + build ✔.

## Where we are — remediation sprint DONE & MERGED (D5 in review)

**PR #30** (`fix: remediation sprint — D1/D6/D2/D4/D3-gate`) is **merged to main**
(squash, `7ae29dd`). Both CI matrices passed pre-merge (Node 20 ✅, Node 24 ✅):
https://github.com/tom-swift-tech/engram/pull/30

Four disjoint lanes, built in parallel isolated worktrees off `2bb22be`,
octopus-merged clean (0 conflicts), each written failing-test-first:

| Lane | File | Fix |
|------|------|-----|
| **D1** | `src/extract-cpu.ts` | `\b..\b` word-boundary confirm on the escaped whole phrase + length ≥4 + reuse `STOP_WORDS`/`COMMON_WORDS`; keeps `INSTR` as a cheap pre-filter only. |
| **D6** | `src/recall.ts` | Threads cosine into fused score; semantic hits score cosine-primary with a gentle `0.94–0.99` trust tiebreak; `minScore` = cosine gate. Non-semantic recall unchanged. `(tier,score)` floor byte-identical (proven by a tier-2-cosine-1.0-vs-tier-0-cosine-0.0 test). |
| **D2+D4** | `src/reflect.ts` | `findMatchingObservation` (lexical, domain+topic, 0.85 thresh) → `observation_refreshes` seam (no schema change); durability rubric in reflect prompt; substring attribution guard in `resolveEntityIds`. |
| **D3-gate** | `integrations/pi/src/adapter.ts` | `isScheduledJobPrompt` forces cron/job prompts to `tool_result`/0.4 regardless of `mode`. Content heuristic only; issue #21 = durable fix. |

**Verification (integration branch, all green):** root vitest **551** (was 538:
+3 D1, +3 D6, +7 D2/D4), Pi vitest **115** (+6 D3-gate; built-dist smoke passes),
build + typecheck + lint + **format:check** clean, `surface-parity` pinned at
**14** MCP tools, CLAUDE.md ↔ AGENTS.md re-synced (D6 within-tier note; mirror
diff = only the "you are here" marker). openclaw (67) untouched.

## NEXT STEPS (in order)

1. ~~**Merge PR #30**~~ — DONE (squash-merged to `main@7ae29dd`, 2026-07-14).
2. ~~**After merge: clean up.**~~ DONE — worktrees removed (junction-safe via
   `cmd /c rmdir` on the 6 reparse points, then dir delete; main-tree
   `node_modules`/`dist` verified intact), 4 lane branches force-deleted, main
   tree on `main@7ae29dd`, `git worktree prune` run. Only `main` remains listed.
3. ~~**D5 (reflection catch-up)**~~ — DONE, in **PR #31** (open, CI green on
   Node 20 + 24): `feat(reflect): reflectCatchUp() backlog-drain runner`.
   Branch `feat/d5-reflect-catchup` @ `63e6d5b` off `main@7ae29dd`. `reflectCatchUp()`
   = bounded multi-batch loop around the untouched `reflect()`; stops on
   drained/capped/stalled/failed; `Engram.reflectCatchUp()` +
   `new ReflectScheduler(cfg,{catchUp:true})`; library-only (surface-parity 14).
   Root 557 / Pi 115 green. **Merge #31 is the user's call** (not merged yet).
   After merge: `git branch -d feat/d5-reflect-catchup`, switch main tree to main,
   pull. (No worktrees this lane — built directly on a branch off main.)
4. **Step 6 (consolidate vs expand)** — decision, not code: the 329 MB
   single-file-git premise; audit ContextStore / engram-aql for earned keep.
   Needs a human call — surface it before writing anything. LAST sprint item.

**Explicitly OUT OF SCOPE (user correction, this session):** any purge /
maintenance / data-cleanup script for a live consumer store. Live agent stores
are operator-owned data. The library's job is the *code defect* (stop producing
bad data — D1/D3-gate did that); cleaning already-written data is the operator's,
and the library ships **no** purge tooling. See `tasks/lessons.md` 2026-07-14.

## Parallel-worktree recipe that worked (reuse for the next fan-out)

- Lead resolves verified HEAD → SHA, `git worktree add -b <branch> <path> <sha>`
  per lane BEFORE spawning; disjoint positive-scope file list per builder.
- Worktrees lack `node_modules` (git only checks out tracked files) — junction
  each to the main tree's: `New-Item -ItemType Junction -Path <wt>/node_modules
  -Target <main>/node_modules` (PowerShell). Also junction `integrations/pi/
  node_modules` and (for any built-dist test) `dist` for pi lanes.
- Builders MUST NOT run `npm install` or `npm run build` (mutate/ race shared
  junctioned state). Vitest only reads node_modules — parallel test runs safe.
- Integrate via `git merge --no-ff <b1> <b2> ...` — a clean octopus merge is
  itself proof the file ownership was disjoint.

## Gotchas carried forward (still live)

- **Pre-push MUST include `npm run format:check`** — SEPARATE CI gate from `lint`
  (eslint ≠ prettier). Run `npm run format` before committing. Scope is
  `src/**/*.ts` + `tests/**/*.ts` only. (Clean on #30 because we ran it.)
- **Markdown is NOT held to Prettier** — don't reformat `.md`; match hand style.
- **Never compare scores across two `recall()` calls in tests without
  `decayHalfLifeDays: 0`** — decay makes scores wall-clock-dependent (D6 tests
  follow this).
- **CLAUDE.md ↔ AGENTS.md**: edit both together; `diff CLAUDE.md AGENTS.md`
  should show only the "you are here" marker.
- **Bash tool is Git Bash** — no PowerShell `@'...'@` here-strings; use `-F
  <file>` for multi-line commit messages (or `-m` with `\n`).
- **dist is ESM w/ top-level await** — Node smoke script must be `.mjs`, dynamic
  `import(pathToFileURL(distPath).href)`, not `require()`.
- **Rebuild `integrations/pi/dist`** before trusting a Pi built-dist smoke fail
  (the smoke test imports `integrations/pi/dist/index.js`; fresh worktrees lack
  it — this is why built-dist tests are validated at integration, not in-lane).
- cargo blocked by Windows Application Control in SOME worktree paths (AQL only;
  no lane this sprint touched AQL).
