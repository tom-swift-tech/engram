# Handoff — Engram (updated 2026-07-16, Hermes observability sprint COMPLETE)

## Base commit / branch state

- **`main`, all sprint work merged locally.** Final verified state: the merge
  of `feat/hermes-t5-pi-parity` (after docs commit this wrap). Sequence on
  main this session: `565595c` (sprint docs) → `d9e6470` (T1, ff) → `48fe547`
  (T2 merge) → `93a601b` (lead integration) → `792ff51` (T3/T4 merge) →
  `cab460f` (T5 merge) → this wrap's docs commit.
- **PUSHED** — `main @ 4126bb5` pushed to origin (059b884..4126bb5,
  2026-07-16). Watch CI: the pushed range includes the whole sprint; local
  gates were all green (574/121/67 + format:check), so a CI failure would be
  environmental, not code.
- Lane worktrees/branches torn down post-merge (verify with `git worktree
  list` / `git branch` — if any `engram-wt-*` or `feat/hermes-*` remain,
  teardown was interrupted; safe to remove, all merged).
- Stale pre-existing branches unrelated to us still listed (chore/ci-pi-suite
  etc.) — harmless, delete anytime.

## What this session did — the whole Hermes sprint, spec → merged

**Origin:** external field report (`tasks/feedback-hermes-report.md`) — a live
Pi-integration consumer's agent ("Hermes") evaluated Engram; 3 of its 7 asks
were shipped-but-invisible capability, 1 was the eval-harness keystone.
**Spec:** `tasks/sprint-hermes-observability.md` v2 (core-first — v1 wrongly
scoped to the Pi adapter; user correction recorded in `tasks/lessons.md`
2026-07-16: scope by layer, not by reporting harness).

Four builder lanes in isolated worktrees, each reviewed PASS before merge:

| Lane | What landed |
|------|-------------|
| T1 (`d9e6470`) | `formatForPrompt` `showProvenance`/`showWhy` flags (default false, byte-identical otherwise); `createdAt` added to `RecallResult`; private `formatWhyLine` |
| T2 (`5320dde`) | `decayHalfLifeDays` on MCP `engram_recall` + CLI `--decay-half-life-days` (omitted → 180 unchanged, undefined-not-0 verified); tool description now states trust-tier guarantee + decay semantics; CLAUDE/AGENTS + skills docs |
| Lead (`93a601b`) | Exported `formatWhyLine`; CLI human recall line shows sourceType+created date, why-line under `--explain-scores`. **Finding: MCP needed NO format threading — it returns full RecallResponse JSON (already lossless)** |
| T3/T4 (`88beee8`) | `evals/` harness: embedding-only, `npm run eval`, P@5/R@5/MRR, four families, baselines committed; deterministic (byte-identical results.json across trees) |
| T5 (`e8f489d`) | Pi `engram_recall` gains `explainScores`+`decayHalfLifeDays` (default stays 0 — issue #19 pinned); formatter converged onto core rendering via shared `formatWhyLine`; `strategyScores` in `details` when requested |

## Eval baselines — the Phase-4 evidence (in `evals/README.md`)

- **Contradiction: 1/4 pairs FAIL** — a stale active fact outranks its
  replacement on phrasing similarity (concrete, measured evidence for
  Hermes ask #1 / staleness detection).
- **Contamination: tier floor perfect** — 0 tool_result noise in top-5
  across 6 queries despite engineered vocabulary overlap.
- **Staleness sweep** quantifies the decay tradeoff (90d chunk: rank 3 at
  half-life 180 vs rank 8 at 30).
- Low P@5 (~0.2) is a structural artifact (1–2 relevant per query, k=5),
  NOT weak retrieval — R@5 0.9–1.0, MRR ~1.0. README explains this.

## NEXT STEPS (nothing in flight; pull if wanted)

1. **Push/PR the sprint** — local main is unpushed.
2. **Phase 4 decisions** (deferred by design, now evidence-backed): staleness
   detection (the contradiction finding justifies a design pass), review/expiry
   dates, durable-vs-conversation separation. Spec §Phase 4.
3. Ask the reporter for the full Hermes report text (we only saw the tail) —
   open follow-up in `tasks/feedback-hermes-report.md`.
4. Housekeeping: delete stale pre-existing branches.

## Verification status (this wrap — all run on merged main)

- Root vitest **574** green (562 baseline + 5 T1 + 5 T2 + 2 lead) · Pi **121**
  green (115 + 6) · openclaw **67** green · surface-parity pinned **14**.
- typecheck / lint / format:check clean · `diff CLAUDE.md AGENTS.md` = marker
  lines only · `npm run eval` runs clean from main, results.json reproduced
  byte-identically.

## Gotchas carried forward (still live)

- **Pi suite fails with stale dist** — rebuild ROOT dist (`npm run build`)
  then `integrations/pi` build before trusting Pi failures. Bit us again this
  session (6 phantom failures, all vanished after rebuild).
- **Pre-push MUST include `npm run format:check`** (separate CI gate from
  lint; scope `src/**`+`tests/**` only, markdown exempt). Note: Pi package
  has pre-existing prettier drift in 4 files — NOT covered by root
  format:check, do not "fix" it incidentally (556-line reflow).
- **CLAUDE.md ↔ AGENTS.md**: edit both together; diff = marker lines only.
- **Never compare scores across two `recall()` calls without
  `decayHalfLifeDays: 0`** — and evals/ pins this everywhere except its
  staleness sweep.
- **Guarded `ALTER TABLE` pattern**, **Bash tool is Git Bash**, **dist is ESM
  w/ top-level await (.mjs smoke scripts)** — unchanged from previous handoff.
- CLI retain defaults to `sourceType: inferred` (0.5) — tests asserting
  `user_stated` must pass `--source-type user_stated` explicitly.
