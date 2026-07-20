# Issue #39 — Procedural reflection (suggestions)

Previous task (issue #38, PRs #40/#41/#42) is DONE and merged; record in git
history of this file + `tasks/handoff.md`.

Base: main @ 255d602. Feature branch: feat/procedural-reflection (created
after design lands).

## Design (architect, 2026-07-20) — decisions on the issue's open questions

- **Q1 scan cursor**: own high-water mark, `bank_config` key
  `suggest_watermark` (NOT reflect's `reflected_at` — corrections are events
  on already-reflected chunks). One UNION scan (corrections via
  `superseded_by IS NOT NULL OR is_active = FALSE` + `updated_at`; friction =
  `tool_result` chunks; workflow = `experience` non-tool chunks), all legs
  `scope='durable'`, `datetime()` on BOTH sides of every comparison
  (ContextStore TTL-bug lesson). Watermark advances iff the model *engaged*
  (parsed output, incl. parsed-empty); repetition across windows accumulates
  via the #38 rejected-candidate merge-forward pattern — zero re-scanning.
  First-run init: `now - initialLookbackDays` (default 30).
- **Q2 event trace**: none in v1. Supersede/forget already write queryable
  state (`markSuperseded` sets is_active/superseded_by/updated_at);
  chunk-state reconstruction sees pre-feature history an event log never
  would. Write path untouched. Consequence: correction evidence is inactive
  by definition → gates use existence-only verification
  (`requireActive: false`).
- **Q3 priority score**: none in v1. Confidence without a revision loop is
  the grounding-layer smell; ranking = `evidence_count DESC,
  COALESCE(last_reinforced, formed_at) DESC` + human lifecycle.
- Schema: `suggestions` + `suggestion_journal` (13 tables; belief_journal
  NOT reused — SQLite can't widen its action CHECK) + partial index
  `idx_chunks_correction_events`. Plain CREATE TABLE IF NOT EXISTS, zero
  guarded ALTERs.
- Pass = step 0.5 in reflect() (after decay, BEFORE minFactsThreshold early
  return — correction signal exists when unreflected count is 0), own
  try/catch fail-open, ≤1 extra generation call/cycle,
  `ReflectConfig.suggestions?: SuggestionConfig`. Gates default ON
  (minEvidenceCount 3, minDistinctDays 2). Dedup: cosine ≥0.85 over stored
  summary embeddings; no-embedder → lexical fallback (beliefSimilarity),
  warn once, still runs. Dismissed match reopens only when new-evidence
  count alone clears minEvidenceCount, else journaled
  `previously_dismissed`.
- Surface: `engram_suggestions` + `engram_resolve_suggestion` (parity
  14→16), CLI `suggestions`/`resolve-suggestion` (unknown id exit 2),
  `engram_reflect` gains optional `suggest: boolean` / CLI
  `reflect --suggest`. New `src/insight-shared.ts` = pure-move extraction of
  gate/similarity/parse helpers shared by reflect+suggest.

## Plan

- [x] Architect design pass (above)
- [x] Branch feat/procedural-reflection @ 255d602
- [x] Slice 1 (builder): schema.sql (2 tables + indexes), insight-shared.ts
      extraction, suggest.ts (scan/watermark/prompt/parse/gates/dedup/read
      surface), reflect.ts step-0.5 + counters + catch-up aggregation,
      engram.ts wrappers/exports; tests/suggestions.test.ts (1–11, 13).
      Acceptance: full suite green with ZERO edits to existing test files.
- [ ] Slice 2 (builder): mcp-tools.ts (+2 tools, reflect `suggest` input),
      cli-args.ts/cli.ts (+2 subcommands, --suggest flag), surface-parity
      pin 16, cli/mcp-server test additions, suggestions test 12
      (recall/grounding isolation).
- [ ] Slice 3 (builder): CLAUDE.md + AGENTS.md together, skills/engram.md,
      skills/cli-memory/SKILL.md, README if it states the count.
- [ ] Reviewer pass on consolidated diff
- [ ] Verification pipeline: build → tsc --noEmit → eslint → format:check →
      full test suite (root + Pi vs rebuilt dist)
- [ ] PR, CI green, merge

## Constraints carried in

- Omitting the new config must be byte-identical to current reflect behavior.
- Suggestions never enter recall() or groundSubagent().
- No new deps. Additive schema only (CREATE TABLE IF NOT EXISTS + indexes in
  schema.sql — new table needs no guarded ALTER).
- Precision-first defaults (gates ≥3 evidence, distinct days/sources).
- format:check is a separate CI gate — run it pre-push.
- Library + MCP/CLI only; Pi addendum hint is a later adapter-layer slice.
