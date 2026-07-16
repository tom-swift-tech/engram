# Task: Hermes sprint — recall observability & surface parity (v2, core-first)

Previous task (six-defect remediation sprint) is DONE and merged (#30–#32);
record in git history of this file + `tasks/handoff.md`.

**Origin:** external field report — `tasks/feedback-hermes-report.md`.
**Spec:** `tasks/sprint-hermes-observability.md` v2 (source of detail).
**Framing rule (user correction, lessons 2026-07-16):** harness-agnostic —
capability + rendering in core, exposed via MCP/CLI; adapters patched last.

## Phase 1 — Core observability

### Lane A: canonical formatter (`src/recall.ts`)
- [x] T1: `formatForPrompt` gains `showProvenance` (memoryType/sourceType/
      trust/created-date per result) + `showWhy` (compact strategyScores
      line). Both default false — existing output byte-identical. Tests.
      (d9e6470, reviewed PASS, merged. +5 tests. Also added `createdAt` to
      RecallResult, populated from already-selected created_at.)

### Lane B: harness-agnostic transports (`src/cli*`, `src/mcp-tools.ts`)
- [x] T2: `decayHalfLifeDays` param on MCP `engram_recall` +
      `--decay-half-life-days` CLI flag (clamp ≥0); omitted → 180 unchanged.
      Description strings advertise tier guarantee + decay semantics.
      Surface-parity stays 14. CLAUDE.md + AGENTS.md + skills docs.
      (5320dde, reviewed PASS incl. the undefined-not-0 omitted path, merged.
      +5 tests.)
- [x] Lead integration (93a601b): exported `formatWhyLine` (shared, no drift);
      CLI human recall line now shows sourceType + created date, why line
      renders under --explain-scores without --json. +2 tests → root 574.
      **Finding:** MCP needed NO format threading — it returns full
      RecallResponse JSON, which already carries createdAt/sourceType/
      strategyScores; a formatted rendering would have LOST fidelity.

## Phase 2 — Eval harness

### Lane C: `evals/**` (greenfield)
- [x] T3: embedding-only eval scaffold — deterministic fixtures,
      P@k / R@k / MRR runner, `npm run eval`, report-only.
- [x] T4: four scenario families — relevance, contradiction, contamination,
      staleness — baselines committed to `evals/README.md`.
      (88beee8, reviewed PASS on all 8 checks, merged @ 792ff51. Re-run on
      merged main reproduced results.json byte-identically.)
      **Findings for Phase 4:** (a) contradiction: 1/4 pairs FAIL — stale
      active fact outranks its replacement on phrasing similarity (concrete
      ask-1 evidence); (b) contamination: tier floor perfect, 0 noise in
      top-5 across 6 queries; (c) staleness sweep quantifies the decay
      tradeoff (90d-old chunk: rank 3 @ 180d half-life vs rank 8 @ 30d).

## Phase 3 — Adapter parity (LAST, after A+B merge)

### Lane D: Pi binding (`integrations/pi/**`)
- [x] T5: pass through `explainScores` + `decayHalfLifeDays` (default stays 0,
      pin issue #19); formatter converged onto core rendering (provenance
      bracket + exported `formatWhyLine`; local loop kept because
      formatForPrompt doesn't print chunk ids and engram_forget needs them);
      `strategyScores` in tool `details` only when requested. Pi 115 → 121.
      (e8f489d, reviewed PASS, merged @ cab460f.)
- [x] Note follow-up: OpenClaw plugin gets T2 for free via MCP; no repo change.

## Phase 4 — DEFERRED (revisit with eval baselines only)
- Staleness detection (ask 1) · review/expiry dates (ask 5) ·
  durable-vs-conversation auto-separation remainder (ask 4).

## Sprint acceptance — ALL MET 2026-07-16
- [x] Defaults byte-identical everywhere (no provenance/why unless asked;
      decay 180 core / 0 Pi — both regression-pinned by tests).
- [x] Pi duplicate formatter converged onto core rendering (shared
      formatWhyLine; drift structurally impossible).
- [x] Full green on merged main: root vitest **574**, Pi **121**, openclaw
      **67**, surface-parity 14; typecheck/lint/format:check clean; mirror
      diff = marker only. (Pi suite needs root dist rebuilt first — known
      stale-dist gotcha, reconfirmed this sprint.)

## Out of scope (hard)
No new MCP tools · no engram-aql changes (frozen) · no live-store purge
tooling · no LLM-side evals in v1 · no OpenClaw-repo changes.
