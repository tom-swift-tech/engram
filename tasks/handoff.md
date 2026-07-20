# Handoff — Engram (updated 2026-07-20, issue #38 full implementation COMPLETE)

## Base commit / branch state

- **`main @ fb5b0dd`**, pushed, CI green. Working tree clean.
- Sequence this session: `aab0322` (start-of-session base) → `7f4b571`
  (merge PR #40) → `29488ff` (merge PR #41) → `fb5b0dd` (merge PR #42).
- No worktrees, no lane branches in flight. Each PR branch deleted on merge
  (`gh pr merge --delete-branch`).

## What this session did

1. **Repo triage**: zero open PRs; one new issue **#38** (`miraswift-agent`:
   reflect forms opinions from single observations, never seeks
   counter-evidence, no per-belief audit trail — 4 proposed opt-in items).
   Posted a code-verified review on #38 (corrections: challenge machinery is
   passive-not-dead; idle decay already exists).
2. **Filed issue #39** ("Procedural reflection: synthesize skill/improvement
   suggestions from accumulated experience") from the user's idea, explicitly
   sequenced after #38's gates+journal. NOT started.
3. **User chose "Full implementation" of #38** → implemented all four items
   as three sequenced PRs, each CI-green and locally verified before merge:
   - **PR #40** (items 1+4): `ReflectConfig.opinionGates`
     (minEvidenceCount/minDistinctDays/minDistinctSources, formation-only,
     verified evidence, rejected-evidence merge-forward across cycles) +
     `belief_journal` table (11th; append-only, formed/reinforced/challenged/
     weakened/rejected + rationale) + `getBeliefJournal()`/`Engram.beliefJournal()`.
     Engagement-semantics fix: rejection-only cycles are NOT issue-#17 silent
     failures. 13 tests (`tests/belief-journal.test.ts`).
   - **PR #41** (item 2): `ReflectConfig.counterEvidence`
     (onReinforce/topK/maxContradictionRatio) — per-candidate recall
     (world/experience, `decayHalfLifeDays: 0`, cited evidence excluded) +
     ONE batched judge LLM call per cycle; ratio `c/(s+c)` gates formation;
     survivors born with contradicting_chunks+last_challenged; onReinforce
     records without touching the delta; fail-open; hallucinated judge ids
     intersected away. Embedder threaded via `ReflectConfig.embedder`
     (standalone reflect warns + skips). 10 tests
     (`tests/counter-evidence.test.ts`).
   - **PR #42** (item 3): `opinions.would_change_this` falsifier (stated at
     formation, backfilled by first reinforcement that states one, never
     overwritten), surfaced in reflect prompt `(would change if: ...)` and
     counter-evidence judge (`Stated falsifier:`); **weakened decay** — the
     step-0 decay gained an unanswered-contradictions eligibility arm (same
     0.02 rate / 0.1 floor / 7-day throttle, no 30-day idle wait), journaled
     `weakened`; `ReflectResult.opinionsWeakened`; introspect `OpinionView`
     gains `wouldChangeThis`. 10 tests (`tests/falsifier.test.ts`).
4. **Issue #38 closed** (auto via PR #42 + summary comment posted for the
   reporter). All work library-only — **zero new MCP tools, surface-parity
   stays pinned at 14**.

## Verification status (this wrap)

Every PR: `tsc --noEmit` clean, eslint clean, `format:check` clean, full
root suite green (579 → 592 → 602 → 612 across the sequence), Pi suite
129/129 against rebuilt root+Pi dist, CI green before merge. CLAUDE.md +
AGENTS.md updated together per PR; mirror diff = the two marker lines only.

## NEXT STEPS (nothing in flight; pull if wanted)

1. **Issue #39** (procedural reflection / skill suggestions) — filed, design
   sketch in the issue body, deliberately sequenced after #38 (now landed, so
   it is unblocked). The natural next feature slice.
2. **Phase 4 decisions** (staleness detection, review/expiry dates,
   durable-vs-conversation separation) — unchanged from prior handoff,
   evidence base in `evals/README.md`.
3. No open PRs, no open issues besides #39, no stale branches as of this wrap.

## Gotchas carried forward

- **Pi suite fails with stale dist** — rebuild ROOT dist (`npm run build`)
  then `integrations/pi` build before trusting Pi failures.
- **Pre-push MUST include `npm run format:check`** (separate CI gate from
  lint; scope `src/**`+`tests/**` only, markdown exempt).
- **CLAUDE.md ↔ AGENTS.md**: edit both together; regenerate AGENTS.md via
  the sed marker swap **from the repo root** — running it from a subdir
  creates a stray empty AGENTS.md via the shell redirect even when sed fails
  (happened this session in `integrations/pi`; cleaned up in PR #42).
- **Sequenced-fetch test mock**: `mockOllamaFetch` returns one body for all
  calls; multi-LLM-call flows (reflect + counter-evidence judge) use the
  `mockFetchSequence` helper pattern in `tests/counter-evidence.test.ts` /
  `tests/falsifier.test.ts` (prompt capture included).
- **Never compare scores across two `recall()` calls without
  `decayHalfLifeDays: 0`.**
- **Guarded `ALTER TABLE` pattern**, **Bash tool is Git Bash**, **dist is
  ESM w/ top-level await (.mjs smoke scripts)**.
- CLI retain defaults to `sourceType: inferred` (0.5) — tests asserting
  `user_stated` must pass `--source-type user_stated` explicitly.
- **Cross-repo PR branches**: check `isCrossRepository` before pushing fixes
  to a PR branch (all PRs this session were same-repo/self-authored).
