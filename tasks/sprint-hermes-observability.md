# Sprint Spec — Recall Observability & Surface Parity ("Hermes sprint") · v2

**Origin:** `tasks/feedback-hermes-report.md` — 7 asks from a live external
consumer. The report happened to arrive via the Pi integration, but **the fixes
are harness-agnostic by construction**: capability and canonical rendering land
in core (`src/`), are exposed through the two harness-agnostic transports
(MCP + CLI), and adapters get a thin parity patch *last*. Any agent — raw MCP,
CLI-skill, OpenClaw, Pi, valor-engine — gets the same result.
(v1 of this spec scoped the work to the Pi adapter; corrected per
`tasks/lessons.md` 2026-07-16.)

**Prioritization logic:** asks 2/3/6 are already-built core capabilities that
agents can't see — pure exposure/rendering work, cheapest wins. Ask 7 (eval
harness) is the keystone: it converts asks 1/4/5 from vibes into measurable
problems before we build machinery for them. Asks 1/5 and the remainder of 4
are **deferred** pending eval baselines.

---

## Phase 1 — Core observability (harness-agnostic)

### T1: Provenance + "why" in the canonical formatter (`formatForPrompt`)
**Answers asks 3 + 6 (visibility). Owned files:** `src/recall.ts`
(`formatForPrompt`, ~line 1346, and `FormatForPromptOptions`),
`tests/recall.test.ts`.

- `formatForPrompt` already takes `showTrust`/`showSource`; extend the options:
  - `showProvenance?: boolean` — per-result line gains
    `[world/user_stated, trust 0.85, 2026-03-14]`: memory type, sourceType
    (makes the tier guarantee *visible* — ask 3), trust, created date (lets
    the agent judge staleness itself — a zero-machinery partial answer to
    ask 1).
  - `showWhy?: boolean` — when the response was produced with
    `explainScores: true`, append one compact line per result derived from
    `strategyScores`: `  why: semantic 0.82 · keyword r3 · tier 0`. Terse —
    this text lands in agent context. No-op (silent) if the response has no
    `strategyScores`.
- Both default `false` — existing output byte-identical for all current
  callers (Pi session-resume/startup-recall reuse this function; their
  budgets must not shift unrequested).
- Respect the existing `maxChars`/`tryAdd` budget machinery.
- Tests: snapshot with/without each flag; budget truncation still correct;
  no-explain response + `showWhy` renders nothing extra.

### T2: `decayHalfLifeDays` + advertisement on MCP tool & CLI
**Answers ask 2 across every harness. Owned files:** `src/mcp-tools.ts`,
`src/cli.ts`, `src/cli-args.ts`, `tests/mcp-server.test.ts`, `tests/cli.test.ts`.

- `engram_recall` MCP tool: add `decayHalfLifeDays` number param (min 0;
  clamp helper in `cli-args.ts` canonical copy + the private `mcp-tools.ts`
  mirror, per existing convention). Omitted → library default 180 (unchanged).
- CLI: `--decay-half-life-days <n>` on `recall`, same validation.
- **Description strings are part of the fix** (agents only use what the
  schema/description advertises — this is the discoverability defect): the
  `engram_recall` description gains one sentence on the trust-tier guarantee
  ("user_stated always outranks tool/external content") and the decay
  semantics (`0` = no recency decay, for long-continuity use).
- MCP recall result: when `explainScores`/provenance options are used, the
  formatted output comes from T1's `formatForPrompt` flags — check how the
  MCP tool currently renders results and thread the flags through (a
  `showProvenance`/`showWhy` input param each, default false).
- **No new tools** — parameters on an existing tool; `surface-parity.test.ts`
  stays pinned at 14.
- Docs: CLAUDE.md + AGENTS.md recall bullet (both files, mirror invariant);
  `skills/cli-memory/SKILL.md` + `skills/engram.md` recall sections.

## Phase 2 — Eval harness (core-level, no harness involved)

### T3: Retrieval-quality eval harness scaffold
**Answers ask 7. Owned files:** new `evals/` directory (greenfield —
`evals/run.ts`, `evals/fixtures/*`, `evals/scenarios/*`), `package.json`
(one script line).

- **Embedding-only by design**: retain/recall need no LLM, so the harness
  runs anywhere the test suite runs (no Ollama). Reflect/opinion quality is
  out of scope for v1 (needs a generation model + judge — different project).
- Deterministic fixture builder: seed a temp `.engram` from a labeled corpus
  (JSON: `{text, memoryType, sourceType, trustScore, createdAt}` — backdate
  via direct SQL the way existing decay tests do).
- Metrics runner: per-scenario **precision@k, recall@k, MRR**; emits
  `evals/results.json` + markdown summary to stdout.
- `npm run eval`. **Report-only, NOT a CI gate** in v1 — baselines before
  thresholds.
- Gotcha (standing): every recall pins `decayHalfLifeDays: 0` explicitly
  unless the scenario is *about* decay — scores are wall-clock-dependent.

### T4: Eval scenarios (same lane as T3, sequential)
Four families, mapping 1:1 to Hermes's testable claims:

1. **Relevance** — labeled query→relevant-chunk-id sets; baseline P@5/R@5.
2. **Contradiction handling** — superseded + conflicting versions of the same
   fact; does the newer / higher-tier statement win? Probes ask 1 without
   building detection machinery.
3. **Contamination** — `user_stated` facts mixed with `tool_result`/test-noise
   chunks sharing vocabulary; tier-floor effectiveness in practice (ask 4).
4. **Staleness probes** — same fact at multiple backdated timestamps; ranking
   under `decayHalfLifeDays` 0 / 30 / 180 (evidence for asks 2/5).

Deliverable: baseline numbers committed in `evals/README.md` — the input to
the Phase-4 deferred-items decision.

## Phase 3 — Adapter parity patches (thin, LAST)

### T5: Pi binding parity + formatter convergence
**Owned files:** `integrations/pi/src/{types,adapter,index}.ts`,
`integrations/pi/tests/*`. Depends on T1+T2 merged.

- Pass through `explainScores` + `decayHalfLifeDays` on the Pi `engram_recall`
  tool (typebox schema + adapter + description). **Pi's decay default stays
  hardcoded 0** (issue #19 decision unchanged — this adds per-call opt-in);
  regression-pin omitted → 0.
- **Converge, don't extend, the duplicate formatter:** Pi's hand-rolled
  `formatRecallResults` (`index.ts:539`) is drift against core
  `formatForPrompt`. Replace it with core's formatter (provenance/why via
  T1's flags), keeping the tool-result `details` object for structured data
  (`strategyScores` included when requested).
- OpenClaw plugin (external repo): out of this repo's scope — record a
  one-line follow-up in `tasks/` that it should pick up the same knobs when
  next touched; it consumes MCP, so T2's description/param work already
  reaches it with zero adapter changes.

## Phase 4 — DEFERRED (recorded, not scheduled)

Revisit only with eval baselines in hand:
- **Staleness detection** (ask 1) — candidate: recall-time flag when a result
  contradicts a newer higher-tier chunk. Needs contradiction-eval hit rates.
- **Review/expiry dates on durable chunks** (ask 5) — schema change
  (`review_after`); only if evals show date-based curation beats
  ranking-based mitigation.
- **Durable-vs-conversation auto-separation** (ask 4 remainder) — retain-side
  classification; needs the contamination baseline.

---

## Sequencing & lanes

```
Lane A (builder): T1        (src/recall.ts + tests)
Lane B (builder): T2        (src/cli*, src/mcp-tools.ts, docs, skills)  ─ parallel with A
Lane C (builder): T3 → T4   (evals/** only)                              ─ parallel with A+B
Lane D (builder): T5        (integrations/pi/**) — AFTER A+B merge
```
A/B/C are file-disjoint → per-agent worktrees off a lead-resolved base SHA per
the claim-lock protocol. D branches off the post-merge SHA. Reviewer pass per
lane before merge.

## Acceptance criteria (sprint-level)

- [ ] Default behavior byte-identical everywhere: no provenance/why lines and
      no explain payload unless requested; decay 180 in core, 0 in Pi.
- [ ] `formatForPrompt` provenance/why flags work for ANY consumer of core.
- [ ] MCP + CLI accept the decay knob; descriptions advertise tier guarantee
      + decay semantics; surface-parity suite still pins 14 tools.
- [ ] `npm run eval` produces baseline P@5/R@5/MRR for all four scenario
      families with no LLM dependency.
- [ ] Pi formatter converged onto core `formatForPrompt` (duplicate deleted).
- [ ] CLAUDE.md + AGENTS.md updated together (mirror diff = marker only);
      `npm run format` on touched `src/**`/`tests/**` before commit.
- [ ] Full green: root vitest (562+new), Pi vitest (115+new), openclaw 67.

## Out of scope (hard boundaries)

- No new MCP tools (14 stays 14).
- No engram-aql changes (frozen at Phase 2; demand signal is core, not AQL).
- No purge/cleanup tooling for live consumer stores (`tasks/lessons.md`
  2026-07-14).
- No reflect/extract (LLM-side) eval — v1 harness is retrieval-only.
- No OpenClaw-repo changes (external; reached via MCP automatically).
