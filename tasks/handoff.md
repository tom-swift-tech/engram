# Handoff — Engram (updated 2026-07-20, issue #39 v1 SHIPPED)

## Base commit / branch state

- **`main @ cdd7305`** (merge of PR #43), pushed, CI green on Node 20 + 24.
  Working tree clean after this wrap commit. Branch
  `feat/procedural-reflection` deleted on merge.
- Session sequence: 255d602 (handoff base) → daae959 (slice 1: core) →
  feec03f (slice 2: MCP/CLI) → 11fc686 (slice 3: docs) → cdd7305 (merge).

## What this session did

Implemented **issue #39 (procedural reflection)** end-to-end as PR #43;
issue auto-closed. Architect design pass resolved the issue's three open
questions, then three sequential builder slices + reviewer + operator
verification:

1. **Design decisions** (recorded in the new CLAUDE.md decision bullet):
   own scan watermark (`bank_config` key `suggest_watermark`, engaged-only
   advance, #38 merge-forward instead of re-scanning); NO event-trace table
   (supersede/forget chunk state is already the queryable correction log →
   gates verify evidence by existence, `requireActive: false`); NO
   confidence score in v1 (lifecycle + evidence_count/recency ranking).
2. **Core** (`src/suggest.ts` 906 lines, `src/insight-shared.ts` pure-move
   extraction, reflect step 0.5 fail-open before the minFactsThreshold
   early return, `suggestions`+`suggestion_journal` tables = 13 total,
   zero guarded ALTERs). Gates default ON (3 evidence / 2 distinct days) —
   opposite of opinionGates' default, deliberate precision-over-recall.
3. **Surface**: `engram_suggestions` / `engram_resolve_suggestion` + CLI
   twins, parity re-pinned **14 → 16**; `engram_reflect` gained optional
   `suggest: boolean`; CLI `reflect --suggest`. resolve-suggestion
   not-found = supersede convention (stderr-only, exit 2, even with
   --json).
4. **Docs**: CLAUDE.md/AGENTS.md (mirror verified — only the two marker
   lines differ), skills/engram.md, skills/cli-memory/SKILL.md, README
   (also fixed a pre-existing stale "thirteen commands").

## Verification status (this wrap)

Reviewer confirmed all 10 design invariants with zero findings. Operator
ran the full pipeline: build / tsc --noEmit / eslint / format:check clean;
root suite **630/630** (612 pre-existing untouched — proof the
insight-shared extraction is pure and omission is byte-identical); Pi
**129/129** against rebuilt root+Pi dist. CI green both Node versions
before merge.

## NEXT STEPS (nothing in flight; pull if wanted)

1. **Pi adapter follow-up for #39** (deliberately deferred, adapter-layer):
   one-line pending-suggestions hint in `before_agent_start`
   (`N pending improvement suggestions`), per the issue's push-minimal
   contract. Small slice.
2. **Live-store validation of the suggest pass** (precision tuning):
   run `reflect --suggest` against a real long-running store and eyeball
   suggestion quality before recommending defaults change. The feature's
   stated kill-risk is a low-precision nag. (Live stores are
   operator-owned — validation means the operator runs it and shares
   output, not us targeting their store; see tasks/lessons.md 2026-07-13.)
3. **Phase 4 decisions** (staleness detection, review/expiry dates,
   durable-vs-conversation separation) — unchanged, evidence base in
   `evals/README.md`.
4. No open PRs, no open issues, no stale branches as of this wrap.

## Gotchas carried forward

- **Pi suite fails with stale dist** — rebuild ROOT dist (`npm run build`)
  then `integrations/pi` build before trusting Pi failures.
- **Pre-push MUST include `npm run format:check`** (separate CI gate;
  scope `src/**`+`tests/**`, markdown exempt).
- **CLAUDE.md ↔ AGENTS.md**: edit both together; verify with a plain
  `diff` — exactly lines 138-139 (the two marker lines) may differ.
- **Suggest-pass specifics** (new this session): watermark comparisons use
  `datetime()` on BOTH sides (ContextStore TTL-bug class); watermark only
  advances on engaged runs; suggestion gates default ON unlike
  opinionGates; dismissal memory is durable — dedup consults ALL statuses
  and a dismissed match needs materially-new evidence (≥ minEvidenceCount
  NEW chunks) to reopen.
- **Never compare scores across two `recall()` calls without
  `decayHalfLifeDays: 0`.**
- **Guarded `ALTER TABLE` pattern** for new columns on existing tables;
  new TABLES are plain CREATE TABLE IF NOT EXISTS (indexes in schema.sql
  only when the table is new too).
- **Bash tool is Git Bash**; dist is ESM w/ top-level await (.mjs smoke
  scripts); CLI retain defaults `sourceType: inferred` (0.5).
- **Sequenced-fetch test mocks**: multi-LLM-call flows use the
  mockFetchSequence pattern (counter-evidence/falsifier/suggestions tests).
