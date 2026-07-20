# Issue #38 — full implementation (3 sequenced PRs)

Previous task (Hermes observability sprint) is DONE and merged (#33–#37);
record in git history of this file + `tasks/handoff.md`.

Decision (2026-07-20): user approved full implementation of #38 by us, as
sequenced PRs. Review posted on the issue with two corrections: challenge
machinery is passive-not-dead (fires only on same-batch contradiction,
`reflect.ts` challenge branch), and idle decay already exists (−0.02/cycle
after 30 days idle, floor 0.1) — item 3 must integrate with it, not duplicate.

## PR 1 — formation gates + belief journal (issue items 1+4) — DONE (PR opened)

Branch: `feat/reflect-opinion-gates-belief-journal` off main @ aab0322.

- [x] `schema.sql`: new `belief_journal` table (+ domain column beyond the
      issue's sketch) + indexes. New table ⇒ plain `CREATE TABLE IF NOT
      EXISTS` works for fresh AND pre-existing files; no guarded ALTER needed.
- [x] `reflect.ts`:
  - [x] `OpinionGates` interface + `ReflectConfig.opinionGates`
  - [x] `rationale` (optional) added to the opinion_updates LLM contract +
        prompt instruction; clamped ~1000 chars
  - [x] Gate evaluation for `direction: 'new'` only (verified evidence ids →
        count / distinct days via `date(COALESCE(event_time, created_at))` /
        distinct sources, NULL source = one bucket)
  - [x] Rejected-candidate evidence merge: latest matching `rejected` journal
        row (same domain, beliefSimilarity ≥ 0.85) contributes its evidence to
        the union before gates re-evaluate — a slow-accumulating belief isn't
        starved by per-batch evaluation
  - [x] Journal writes in the apply transaction: formed / reinforced (incl.
        new-dedup-to-reinforce) / challenged / rejected
        (`insufficient_evidence` + `no_matching_opinion`); `weakened` reserved
        in the CHECK for PRs 2/3, not written yet
  - [x] `ReflectResult.opinionsRejected`; a cycle whose only output is
        gate-rejections is NOT a silent failure (no shrink hint) and its facts
        ARE marked reflected
  - [x] `getBeliefJournal()` read fn + types (library-only)
- [x] `engram.ts`: `opinionGates` in both reflect/reflectCatchUp Picks,
      `beliefJournal()` method, type re-exports
- [x] `reflectCatchUp`: aggregate `opinionsRejected`
- [x] Tests `tests/belief-journal.test.ts`: no-gates journaling parity,
      gate rejection (count/days/sources), rejected→merge→formed across
      cycles, all-rejected cycle marks facts reflected + no shrink hint,
      unmatched reinforce journaled, read API filters, old-file migration
- [x] Docs: CLAUDE.md + AGENTS.md together (table count 10→11, decision
      bullet, tests list)
- [x] Verify: build → tsc → lint → format:check → full test suite
- [x] Commit, push, PR (surface-parity stays 14 — zero new MCP tools)

## PR 1 status: MERGED as #40 (main @ 7f4b571).

## PR 2 — counter-evidence pass (item 2) — DONE (branch feat/reflect-counter-evidence)

Design settled during implementation (differs from the sketch above in two
ways worth remembering): retrieval queries the candidate belief itself (not a
derived negation — negation derivation would be a second LLM call per
candidate; instead ONE batched judge call per cycle classifies contradictions
across all candidates), and `weakened` is still not written — recording
contradictions and adjudicating them are separate concerns; adjudication is
PR 3's falsifier/decay job.

- [x] `ReflectConfig.counterEvidence` (`onReinforce`/`topK`/`maxContradictionRatio`)
      + `ReflectConfig.embedder`; `Engram` threads its embedder through both
      reflect wrappers
- [x] Retrieval via `recall()`: world/experience only, decayHalfLifeDays 0,
      cited evidence excluded, topK+cited headroom
- [x] ONE batched judge LLM call per cycle; ids intersected against shown
      pool; untrusted_data delimiting; fail-open on judge error
- [x] Formation ratio gate `c/(s+c)` > maxContradictionRatio → journaled
      `rejected`/`counter_evidence`; ratio 1 = record-only
- [x] Surviving formations born with contradicting_chunks + last_challenged;
      onReinforce merges contradictions without touching the delta
- [x] `ReflectResult.counterEvidenceChecked` (+ CatchUp aggregation);
      next-cycle prompt shows "contradicted by N chunk(s)"
- [x] Tests `tests/counter-evidence.test.ts` (10): off-by-default, record
      sub-threshold, block over-threshold, record-only mode, onReinforce,
      hallucinated ids, fail-open, cited-exclusion (prompt capture),
      next-cycle prompt line, missing-embedder skip
- [x] Docs: CLAUDE.md + AGENTS.md together (new decision bullet, reflect.ts
      line, tests list, stale test-count fix 574→602)
- [x] Verify: tsc, prettier, eslint, root 602/602, Pi 129/129 on rebuilt dist
- [x] Commit, push, PR #41, CI green, merged (main @ 29488ff)

## PR 3 — falsifier field (item 3) — DONE (branch feat/reflect-falsifier-field)

- [x] `opinions.would_change_this` (schema.sql for fresh files + guarded
      ALTER in engram.ts for existing; NULL = never stated)
- [x] Reflect prompt requests the falsifier for direction:'new'; stored at
      formation (clamped 1000 chars); backfilled by the first reinforcement
      that states one, never overwritten (first-stated-wins)
- [x] Surfaced to later cycles: opBlock renders "(would change if: ...)" with
      a challenge-verdict instruction; counter-evidence judge prompt shows
      "Stated falsifier:" for reinforce candidates with matching-evidence-IS-
      contradiction instruction
- [x] Weakened decay: step-0 decay extended with a second eligibility arm —
      unanswered contradictions (contradicting_chunks non-empty AND
      last_reinforced < last_challenged) decay without the 30-day idle wait,
      same rate/floor/throttle; journaled 'weakened' (reserved since PR 1)
      keyed to the run's logId; idle arm unchanged and unjournaled
- [x] `ReflectResult.opinionsWeakened` + CatchUp aggregation
- [x] introspect OpinionView gains wouldChangeThis (additive projection)
- [x] Tests `tests/falsifier.test.ts` (10)
- [x] Docs: CLAUDE.md + AGENTS.md (decision bullet, tests list, 602→612)
- [x] Verify: tsc, prettier, eslint, root 612/612, Pi 129/129 on rebuilt dist
- [x] Commit, push, PR #42, CI green, merged (main @ fb5b0dd)

## DONE — issue #38 closed (auto via PR #42 + summary comment).

All four items landed across #40/#41/#42. Zero new MCP tools; surface-parity
stays 14. Next candidate slice: issue #39 (procedural reflection), now
unblocked.
