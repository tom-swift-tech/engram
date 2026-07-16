# Task: Hermes sprint — recall observability & surface parity (v2, core-first)

Previous task (six-defect remediation sprint) is DONE and merged (#30–#32);
record in git history of this file + `tasks/handoff.md`.

**Origin:** external field report — `tasks/feedback-hermes-report.md`.
**Spec:** `tasks/sprint-hermes-observability.md` v2 (source of detail).
**Framing rule (user correction, lessons 2026-07-16):** harness-agnostic —
capability + rendering in core, exposed via MCP/CLI; adapters patched last.

## Phase 1 — Core observability

### Lane A: canonical formatter (`src/recall.ts`)
- [ ] T1: `formatForPrompt` gains `showProvenance` (memoryType/sourceType/
      trust/created-date per result) + `showWhy` (compact strategyScores
      line). Both default false — existing output byte-identical. Tests.

### Lane B: harness-agnostic transports (`src/cli*`, `src/mcp-tools.ts`)
- [ ] T2: `decayHalfLifeDays` param on MCP `engram_recall` +
      `--decay-half-life-days` CLI flag (clamp ≥0); omitted → 180 unchanged.
      Description strings advertise tier guarantee + decay semantics.
      Thread T1's format flags through the MCP result rendering.
      Surface-parity stays 14. CLAUDE.md + AGENTS.md + skills docs.

## Phase 2 — Eval harness

### Lane C: `evals/**` (greenfield)
- [ ] T3: embedding-only eval scaffold — deterministic fixtures,
      P@k / R@k / MRR runner, `npm run eval`, report-only.
- [ ] T4: four scenario families — relevance, contradiction, contamination,
      staleness — baselines committed to `evals/README.md`.

## Phase 3 — Adapter parity (LAST, after A+B merge)

### Lane D: Pi binding (`integrations/pi/**`)
- [ ] T5: pass through `explainScores` + `decayHalfLifeDays` (default stays 0,
      pin issue #19); DELETE hand-rolled `formatRecallResults`, converge onto
      core `formatForPrompt`; `strategyScores` in tool `details`. Tests.
- [ ] Note follow-up: OpenClaw plugin gets T2 for free via MCP; no repo change.

## Phase 4 — DEFERRED (revisit with eval baselines only)
- Staleness detection (ask 1) · review/expiry dates (ask 5) ·
  durable-vs-conversation auto-separation remainder (ask 4).

## Sprint acceptance
- [ ] Defaults byte-identical everywhere (no provenance/why unless asked;
      decay 180 core / 0 Pi).
- [ ] Pi duplicate formatter deleted; any harness gets identical rendering.
- [ ] Full green: root vitest (562+new), Pi (115+new), openclaw 67,
      surface-parity 14; format:check clean; mirror diff = marker only.

## Out of scope (hard)
No new MCP tools · no engram-aql changes (frozen) · no live-store purge
tooling · no LLM-side evals in v1 · no OpenClaw-repo changes.
