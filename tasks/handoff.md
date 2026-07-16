# Handoff — Engram (updated 2026-07-16, wrap 6 — Step 6 CLOSED)

## Base commit / branch state

- **Working tree is on `main`, clean after this wrap's docs commit.** A fresh
  `go` lands here. Last verified state before this commit: `main @ 7b86114`
  (wrap-5 docs commit). This wrap adds ONE docs-only commit on top.
- **No open PRs, no feature branches in flight.** The whole D1–D6 remediation
  sprint (#30), D5 catch-up (#31), and node-origin groundwork (#32) are all
  merged. **The remediation sprint is now fully DONE — Step 6 is closed (see
  below).**
- Stale local branches still listed (pre-existing, unrelated, harmless):
  `chore/ci-pi-suite`, `docs/aql-writes-vector-design`, `docs/refresh-current-state`,
  `feat/pi-auto-retain`, `feat/pi-reflect-scheduling`. Delete anytime; not ours.

## Where we are — sprint DONE, Step 6 decided

Step 6 ("consolidate before expanding") was the last open item — a decision, not
code. It is now made and recorded. **There is no open work item.** Next session
starts fresh on whatever you bring.

### This session's work: Step 6 audit + engram-aql freeze decision (docs only)

Read-only audit → a Director decision → source-of-truth updated. No code touched,
nothing to build/test.

| Artifact | What it is |
|----------|-----------|
| `tasks/step6-audit.md` | Read-only findings (I wrote it). Evidence for all three Step-6 sub-questions. |
| `tasks/decision-freeze-engram-aql.md` | The Director's decision (freeze engram-aql at Phase 2). |
| `CLAUDE.md` + `AGENTS.md` | engram-aql section reframed from "Remaining (deferred)" → **`Status — FROZEN at Phase 2`** with thaw trigger. Mirrored (diff = only the "you are here" marker). |

**The three Step-6 outcomes:**

1. **Git premise — already solved, no action.** `*.engram`/`*.db`/`*.sqlite` are
   gitignored, **0** DB files tracked, `.git` is ~13 MB. The "329 MB + 897 MB
   snapshots" figures were a *live consumer store* (operator data), never this
   repo. The 3.8 GB working tree is entirely `engram-aql/target/` Rust debug
   artifacts — gitignored (nested `engram-aql/.gitignore`), 0 tracked,
   `cargo clean` reclaims anytime.
2. **ContextStore — KEEP.** Low cost (1 file, 1 `scope` column, no deps) and
   load-bearing for the grounding layer (`taskContext` → `queryContext`). Note:
   **zero in-repo consumers** beyond its own tests + MCP/CLI passthrough (Pi and
   OpenClaw call it 0 times) — kept on cost/grounding grounds, not usage.
3. **engram-aql — FROZEN at Phase 2.** No Phase 3. Zero in-repo consumers, high
   carrying cost (whole Rust crate re-deriving TS read semantics, cargo-gated
   CI), justification was one inbound OSS question (weakest demand signal). Every
   agent consumer is already served by MCP; AQL only earns keep for a Rust
   process wanting in-process sub-MCP reads, which nobody is. **Freeze not cut**
   (reversibility) **not keep-and-invest** (stop the bet compounding).
   - **Thaw trigger (falsifiable):** a Rust consumer produces a concrete
     artifact — a PR/issue against the crate from the external user, OR a named
     internal fleet consumer (Substrate, Cradel/Mira-core, Herd) wanting
     in-process Rust reads. **One more inbound question does NOT count.**
   - **Build-tax escape hatch:** if keep-green starts costing real maintenance on
     toolchain bumps, the decision converts toward **cut**.
   - Frozen leftover (was "deferred"): canonical TS `LINK` surface; transactional
     `PIPELINE` mixing reads+writes. Not resumed unless thawed.

## NEXT STEPS

**None open.** The remediation sprint is complete. Possible future threads, only
if you choose to pull one:

- **Watch engram-aql's build tax** against the freeze — if a Rust toolchain bump
  breaks CI on a zero-consumer crate, that's the signal to revisit toward cut.
- Delete the 5 stale local branches (housekeeping, not ours).
- Anything net-new you bring.

**Explicitly OUT OF SCOPE (user correction, carried forward):** any purge /
maintenance / data-cleanup script for a live consumer store. Live agent stores
are operator-owned data. The library's job is the *code defect*; cleaning
already-written data is the operator's, and the library ships **no** purge
tooling. See `tasks/lessons.md` 2026-07-14.

## Verification status (this wrap)

- **Docs-only change** — no code touched, so no typecheck/build/test run was
  needed or done. Not a regression risk.
- Markdown is **not** held to Prettier (`format:check` scope is `src/**` +
  `tests/**` only) — the `.md` edits match hand style, no format gate applies.
- `diff CLAUDE.md AGENTS.md` verified = only the "you are here" marker (mirror
  invariant holds).
- Last full green baseline (unchanged since, on `main`): root vitest **562**,
  Pi vitest **115**, openclaw **67**, surface-parity pinned at **14**.

## Gotchas carried forward (still live)

- **Pre-push MUST include `npm run format:check`** — SEPARATE CI gate from `lint`
  (eslint ≠ prettier). Run `npm run format` before committing CODE. Scope is
  `src/**/*.ts` + `tests/**/*.ts` only — **markdown is exempt**, don't reformat
  `.md`.
- **CLAUDE.md ↔ AGENTS.md**: edit both together; `diff CLAUDE.md AGENTS.md`
  should show only the "you are here" marker.
- **Guarded `ALTER TABLE ADD COLUMN` pattern** (proven for `text_hash`,
  `next_retry_after`, ContextStore scope cols, `node_origin`): add the column in
  `engram.ts` under a `pragma('table_info')` guard, create its index
  UNCONDITIONALLY *after* the guards — never put `CREATE INDEX` on a new column
  in `schema.sql` (runs wholesale on a pre-existing file where the column doesn't
  exist yet and fails hard). Columns-for-fresh-installs go in `schema.sql`.
- **Never compare scores across two `recall()` calls in tests without
  `decayHalfLifeDays: 0`** — decay makes scores wall-clock-dependent.
- **Bash tool is Git Bash** — no PowerShell `@'...'@` here-strings; use `-F
  <file>` for multi-line commit messages (or a heredoc to a temp file).
- **dist is ESM w/ top-level await** — Node smoke script must be `.mjs`, dynamic
  `import(pathToFileURL(distPath).href)`, not `require()`.
- **Rebuild `integrations/pi/dist`** before trusting a Pi built-dist smoke fail.
- cargo blocked by Windows Application Control in SOME paths (AQL tests only) —
  now doubly moot while engram-aql is frozen.
