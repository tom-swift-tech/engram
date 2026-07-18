# Handoff — Engram (updated 2026-07-18, PR triage + housekeeping COMPLETE)

## Base commit / branch state

- **`main @ 7c7e6f1`**, pushed, CI green. Working tree clean.
- Sequence this session: `16f7c51` (prior handoff, start-of-session base) →
  `407e2a2` (merge PR #34) → `ad3b213` (merge PR #33, after an in-flight lint
  fix — see below) → `7c7e6f1` (drop Hermes follow-up).
- No worktrees, no lane branches in flight. `git worktree list` shows only the
  main checkout.
- Stale local branches from the Hermes sprint (`chore/ci-pi-suite`,
  `docs/aql-writes-vector-design`, `docs/refresh-current-state`,
  `feat/pi-auto-retain`, `feat/pi-reflect-scheduling`) were verified merged
  into main and **deleted this session**. `git branch -a` is clean now aside
  from `main` and remote-tracking refs.

## What this session did

1. **Verified repo currency** on `go`/resume: confirmed `main` matched
   `origin/main` (no divergence either direction), fetched + pruned dead
   remote refs, spot-checked CI history — all green.
2. **Dropped the Hermes report follow-up** (`tasks/feedback-hermes-report.md`):
   no channel to reach the external reporter ("Ben") beyond the original
   screenshot share, so chasing it further isn't worth it. Noted inline as
   dropped 2026-07-18; the 7-item capability mapping in that file stands on
   its own regardless.
3. **Triaged and merged the 2 open PRs**, both from `miraswift-agent` (an
   external/fleet consumer's agent, "Mira" — via Claude Opus 4.8):
   - **PR #34** `feat(pi): route background consolidation to an
     OpenAI-compatible endpoint` — adds `ENGRAM_GENERATION_ENDPOINT` (+
     `ENGRAM_GENERATION_API_KEY`) as an alternate Pi consolidation backend
     (llama.cpp/vLLM/Herd) alongside Ollama, mirroring `engram-mcp`'s
     `--generation-endpoint`/`--generation-model` pair. Drive-by fix: the
     Ollama path had been silently dropping `spec.host`, pinning consolidation
     to `localhost:11434` regardless of `ENGRAM_OLLAMA_URL`. CI was green as
     opened — merged as-is.
   - **PR #33** `fix(extract,reflect): budget generation for reasoning
     models; fail loud; fix retry-gate comparison` — three real bugs found
     running consolidation against a reasoning-model backend (qwen3.x/bonsai
     class, which emit `reasoning_content` before any content): (a)
     `maxTokens` (2048/4096) too small for the thinking pass → empty/truncated
     completions, raised to 16384 in both `extractEntities` and `reflect`;
     (b) `extractEntities` swallowed empty/unparseable LLM responses as
     `{entities:[],relations:[]}`, indistinguishable from a genuinely-empty
     chunk — now throws, routing through retry/backoff and surfacing as
     `failed` (recoverable via `requeueFailedExtractions`); (c) the extraction
     retry-gate compared an ISO `next_retry_after` string against SQLite's
     space-separated `CURRENT_TIMESTAMP` as raw strings (`'T'` sorts above
     `' '`), stranding retryable items `pending` forever — fixed via
     `datetime()` on both sides (same trap as the ContextStore TTL comparison
     documented in CLAUDE.md).
     - **CI was red on open**: eslint's `preserve-caught-error` rule (a real
       core ESLint 10 rule, not a repo-local one) flagged the new
       `catch (err) { throw new Error(...) }` in `retain.ts`'s
       `extractEntities` for not attaching `{ cause: err }`. Fixed directly on
       the PR's fork branch (`miraswift-agent/engram`, `maintainerCanModify:
       true`) — one-line addition, verified lint/typecheck/`retain*`+`reflect`
       tests green locally before pushing, then CI went green and both PRs
       were merged.

## Gotcha hit this session (repo-op, not code)

- **Cross-repo PR branches**: `gh pr view --json headRefName` doesn't tell you
  it's a fork. `git push origin <branch>:<branch>` on a fork-sourced PR
  silently creates an unrelated new branch on `origin` instead of updating the
  PR — no error, easy to miss. Always check `isCrossRepository`/
  `headRepositoryOwner` first; if it's a fork, add the fork as a remote
  (`git remote add`) and push there (works if `maintainerCanModify: true`).
  Cleaned up the stray `origin` branch this session before redoing it right.

## NEXT STEPS (nothing in flight; pull if wanted)

1. **Phase 4 decisions** (deferred by design, evidence-backed by the eval
   baselines in `evals/README.md`): staleness detection, review/expiry dates,
   durable-vs-conversation separation. Spec: `tasks/sprint-hermes-observability.md`
   §Phase 4. Still the most substantive open thread.
2. Hermes report follow-up: **closed, won't revisit** unless the reporter
   surfaces again on their own.
3. No other open PRs or stale branches as of this wrap.

## Verification status (this wrap)

- `main` confirmed in sync with `origin/main`, working tree clean.
- PR #33 branch (post-fix): `npm run lint` clean, `npx tsc --noEmit` clean,
  `vitest run tests/retain.test.ts tests/retain-gate.test.ts
  tests/reflect.test.ts` → 118/118 green.
- Both merge commits (`407e2a2`, `ad3b213`) confirmed green via `gh run
  watch`/`gh run view` (lint, format:check, typecheck, coverage, build, Pi
  extension install/typecheck/build/test — all jobs on Node 20 and 24).
- `diff CLAUDE.md AGENTS.md` (marker-line-normalized) = in sync, post-merge.

## Gotchas carried forward (still live, unchanged from prior handoff)

- **Pi suite fails with stale dist** — rebuild ROOT dist (`npm run build`)
  then `integrations/pi` build before trusting Pi failures.
- **Pre-push MUST include `npm run format:check`** (separate CI gate from
  lint; scope `src/**`+`tests/**` only, markdown exempt). Pi package has
  pre-existing prettier drift in 4 files — not covered by root format:check,
  don't "fix" it incidentally.
- **CLAUDE.md ↔ AGENTS.md**: edit both together; diff = marker lines only.
- **Never compare scores across two `recall()` calls without
  `decayHalfLifeDays: 0`.**
- **Guarded `ALTER TABLE` pattern**, **Bash tool is Git Bash**, **dist is ESM
  w/ top-level await (.mjs smoke scripts)**.
- CLI retain defaults to `sourceType: inferred` (0.5) — tests asserting
  `user_stated` must pass `--source-type user_stated` explicitly.
