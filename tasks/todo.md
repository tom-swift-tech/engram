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

## PR 2 — counter-evidence pass (item 2) — after PR 1 merges

Active challenge: before forming/reinforcing, recall against a negated
candidate; populate `contradicting_chunks`/`last_challenged`; optional
support/contradiction ratio gate; journal `challenged`/`weakened` with the
counter-evidence. LLM+recall cost per candidate — needs its own design pass
(negation derivation, budget caps). Rides PR 1's journal.

## PR 3 — falsifier field (item 3) — after PR 2

`would_change_this TEXT` on opinions (guarded ALTER); reflection states the
falsifier at formation; later cycles check new evidence against stated
falsifiers → principled decay, integrated WITH the existing 30-day idle decay
(not a second parallel mechanism).
