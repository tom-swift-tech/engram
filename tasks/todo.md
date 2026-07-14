# Task: Engram remediation sprint

Fix six defects surfaced by the 2026-07-13 live-store assessment
(`mira.engram`, 12,213 chunks, 329 MB). Verdict from assessment: **continue —
remediate, don't re-architect.** Every defect below was independently verified
against the source tree (four parallel investigations, 2026-07-13); the
verified mechanism and exact loci are recorded per item. This is fix-work in
dependency order, not a rebuild.

## Status — 2026-07-14 (integration branch `remediation/sprint-d1-d6`)

**Four code lanes DONE & verified green; single PR pending.** Built in parallel
isolated worktrees off `main@2bb22be`, octopus-merged clean (disjoint files):
- **D1** (`src/extract-cpu.ts`) — word-boundary + stopword graph matching. ✔
- **D6** (`src/recall.ts`) — cosine-primary within-tier scoring; `(tier, score)`
  floor byte-identical (proven by test). ✔
- **D2+D4** (`src/reflect.ts`) — `findMatchingObservation` dedup + durability
  rubric + substring attribution guard. ✔
- **D3-gate** (`integrations/pi/src/adapter.ts`) — `isScheduledJobPrompt`
  downgrades cron/job prompts to `tool_result`/0.4. ✔

Verification (integration branch): root **551** green (was 538), Pi **115** green,
build + typecheck + lint + format:check clean, surface-parity pinned at **14**
tools. CLAUDE.md ↔ AGENTS.md re-synced (D6 within-tier note).

**Still open after this PR:** **D5** (reflection catch-up) and **Step 6**
(consolidate-vs-expand decision). Live agent-store cleanup is operator-owned
and out of scope — the library ships no purge/maintenance tooling for consumer
data.

## Decisions locked (2026-07-13)

1. **Scope:** full six-defect sprint, D1→D6 in dependency order.
2. **D3 recurrence-prevention:** content heuristic in `planAutoRetain` (in-repo,
   ships now). Not the upstream #21 fix; note the residual brittleness in the
   code comment and leave #21 open for the durable signal.
3. **Branch base:** merge `fix/model-resolver-preflight` → main FIRST, then
   branch remediation off clean main. (Precondition — see below.)

## Precondition — land the model-resolver PR

`fix/model-resolver-preflight` (HEAD `9192f47`, off `cfc5493`) is the "404 storm
is fixed" work the assessment assumes. Merge it to main, then resolve the new
main SHA as the remediation base. Per repo policy (global CLAUDE.md): the lead
resolves a verified base SHA and creates per-builder worktrees before spawning.
Parallel builders each own a disjoint file set (see §Parallelization).

## Verified findings — mechanism confirmed + divergences from the assessment

| ID | Sev | Mechanism (CONFIRMED) | Primary locus | Divergence from assessment |
|----|-----|----------------------|---------------|----------------------------|
| **D1** | Crit (size) | `strategyGraphMatching` does `INSTR(text, canonical_name) > 0` substring matching; only guard is `LENGTH > 2`. No word-boundary, no stopword filter. Re-links every active entity as a substring on every retain → ~129 links/chunk, 71% of DB. | `src/extract-cpu.ts:221-265`; link insert `:150-160`; Tier-1 called inline in retain (`src/retain.ts:367`) | none — confirmed exactly |
| **D6** | Crit (recall) | (a) RRF `1/(k+rank)` with uniform `k=60`, **no per-strategy weight** (`recall.ts:849-885`); only a *breadth* bonus (`:920`). (b) Final sort is `(tier, score)` with tier absolute (`recall.ts:1136-1143`). | `src/recall.ts` fusion `:849-885`, weighting `:898-963`, sort `:1136-1143` | **Security invariant is preserved by construction** — tier is the *primary* key, so a cosine-primary *within-tier* score never lets tier-2 outrank tier-0. We do **not** need to "soften the floor." |
| **D3** | High | Cron/`user`-role prompts pass `planAutoRetain` and store as `experience`/`user_stated`/**0.7** via `ROLE_MAP.user`. `shouldRetain()` is **not wired** into auto-retain and wouldn't catch them anyway (they score high). | `integrations/pi/src/adapter.ts:600-605, 667-703` | **The "gateway that zeroes trust for scheduler sessions" DOES NOT EXIST in this repo.** Only guard is an unreliable `ctx.mode` downgrade (issue #21). Recurrence-prevention is genuinely harder than the assessment implied — see Decision 2. |
| **D2** | High | Observations are insert-only (`reflect.ts:655-673`), no match-before-insert. Opinions dedup+reinforce via `findMatchingOpinion` (`:488-511`). Asymmetry real → 1 insight × ~40 rows. | `src/reflect.ts:655-673` | Assessment said "embedding similarity" dedup — but **observations have no embedding column**. Mirror the existing *lexical* `findMatchingOpinion` seam instead. No schema change. |
| **D4** | Med | Reflect prompt (`reflect.ts:214-298`) has no durable-vs-transient distinction; `resolveEntityIds` (`:478-486`) trusts LLM attributions verbatim. | `src/reflect.ts:256, 261` (+ `:223-226`) | none — confirmed. Attribution-swap is unchecked entity resolution. |
| **D5** | Med | 43.6% reflection coverage; extraction keeps up (free GPU) but reflection runs on metered model at low batch. | reflect scheduling / batch config | none — but cheaper to fix *after* D2/D4 stop wasting belief-writes. |

## Dependency graph (why this order)

```
        D1-fix (stop the bleed) ─────────────┐
        D3-gate (prevent recurrence) ────────┤
                                             ▼
                                        D6-recall (cosine-primary within tier)

        D2 (observation dedup) ──► D5 (reflection catch-up)
        D4 (durability prompt) ──►    (cheaper once D2/D4 cut wasted writes)
```

Key sequencing insight: **D6's code change is fully independent and lands now.**
Cosine-primary within-tier ranking works regardless of store state. Any residual
mislabeled tier-0 noise in a live store is an operator-side data concern, not a
library one — and the security floor protects tier-0 either way.

## Decision points (need a human call before those steps run)

1. **Scope/pace.** Full six-defect sprint, or the two criticals (D1 + D6) first
   to de-risk, then reassess? D1+D6 are the size and read-path fixes; they're
   independent and parallelizable.
2. **D3 recurrence-prevention** (the assessment's premise was wrong — no
   upstream gateway exists here). Three options:
   - **(a)** Content heuristic in `planAutoRetain`: detect job/cron prompts
     ("Process … queue. Execute: bash…") and refuse/downgrade. Brittle, in-repo, ships now.
   - **(b)** Fix issue #21 properly: a reliable scheduler signal from the
     consumer (valor-engine passes an explicit provenance/mode). Correct, but
     spans repos and needs coordination.
   - **(c)** Defer the gate entirely and rely on an operator-side cleanup of the
     live store. Rejected — recurrence stays open until #21, and cleaning a
     consumer's store is not a library deliverable.
3. **Live-store cleanup is out of scope. RESOLVED.** `mira.engram` and any live
   agent store are operator-owned data — the library ships no purge or
   maintenance tooling for them, and we never ask for a live path or run a
   destructive op against one. Cleaning a specific consumer's store is that
   consumer's concern, not a remediation deliverable.

## Work items

### D1 — stop the bleed (extract-cpu) · ~1 day · CRITICAL, independent
- [ ] `src/extract-cpu.ts:221-265` — replace substring `INSTR` matching with
      word-boundary matching; add min-length (≥4?) + stopword denylist
      (reuse existing `STOP_WORDS` `:102-117` / `COMMON_WORDS` `:37-99`, which
      graph-matching currently ignores).
- [ ] New tests in `tests/extract-cpu.test.ts`: assert a 3-char stopword entity
      ("and"/"for") and a sub-word fragment ("est" inside "test") are NOT linked;
      keep the existing whole-word tests (`:28-48`, `:178-198`, `:274-299`) green.

### D3 — gate (recurrence) · scope depends on Decision 2
- [ ] `integrations/pi/src/adapter.ts` `planAutoRetain` (`:667-703`) /
      `ROLE_MAP` (`:600-605`) per chosen option.
- [ ] Update `integrations/pi/tests/auto-retain.test.ts` (asserts user→0.7 at
      `:143-161`) + add cron-rejection cases.

### D6 — recall semantic-primary · ~2–4 days · CRITICAL, independent
- [ ] Thread raw cosine out of `semanticSearch` (`recall.ts:446-512`, currently
      discarded after `ORDER BY distance`) into `ScoredChunk`/`FusedEntry`.
- [ ] Make within-tier `score` cosine-primary × gentle trust tiebreak; add a
      `minScore` cosine gate. Port the assessment's validated params
      (`cosine × 0.94–0.99 trust-bias · minScore 0.42`). Validate with a
      synthetic-fixture ranking test (small in-test `.engram`) — the live-store
      cron-noise 15 → 1 number is the operator's to reproduce, not ours.
- [ ] **Leave the `(tier, score)` comparator (`:1136-1143`) and the tier-2
      floor untouched** — that is what preserves the security invariant.
- [ ] Update `tests/trust-tier.test.ts:105-161` (within-tier trust/mem-type
      ordering) and `tests/recall.test.ts:318-334, 350-511` (trust tiebreak,
      minScore & explainScores numeric assertions). Add a live-store-style
      regression: a strong tier-1 cosine match must beat a weak tier-1 chunk.

### D2 — observation dedup-on-synthesis · ~1–2 days · independent
- [ ] `src/reflect.ts` — add `findMatchingObservation` mirroring
      `findMatchingOpinion` (`:488-511`): `normalizeBelief`/`beliefSimilarity`
      scoped by `domain`+`topic`; route a would-be-new observation into a
      refresh/reinforce (`observation_refreshes` seam already exists at `:675-703`).
- [ ] Test modeled on the opinion-dedup test (`reflect.test.ts:530-598`);
      update exact-count assertions (`:67-80`, `:114-132`, `:675-708`).

### D4 — durability prompt + attribution · ~0.5–1 day · pairs with D2
- [ ] `src/reflect.ts:256` (observations) + `:261` (opinion "new") — add a
      durability rubric: reject transient operational state (expiring tokens,
      current uptime/reliability, in-progress status) as beliefs/observations.
- [ ] Consider a light attribution sanity check in `resolveEntityIds` (`:478-486`).

### D5 — reflection catch-up · ongoing · after D2/D4
- [ ] Larger off-peak reflection batches so beliefs track the graph. Revisit
      once D2/D4 reduce wasted writes.

### Step 6 — consolidate before expanding · decision, not action
- [ ] Revisit the "single-file git-committable" premise (329 MB + 897 MB
      snapshots — a mutating memory DB was never a good git citizen; backup
      strategy vs version control).
- [ ] Audit ContextStore / engram-aql for whether they've earned their keep
      before adding more surface.

## Parallelization (disjoint file ownership → worktrees)

The three code fixes touch **different source files** and can run as parallel
builders in isolated worktrees off a lead-resolved SHA:
- **D1** → `src/extract-cpu.ts`, `tests/extract-cpu.test.ts`
- **D6** → `src/recall.ts`, `tests/recall.test.ts`, `tests/trust-tier.test.ts`
- **D2+D4** → `src/reflect.ts`, `tests/reflect.test.ts`
- **D3-gate** → `integrations/pi/src/adapter.ts`, `integrations/pi/tests/auto-retain.test.ts`

Live agent-store cleanup is operator-owned and out of scope — no live-store step
and no purge/maintenance tooling exists in this sprint.

## Verification

Per changed lane: root vitest + affected integration suite, typecheck, lint,
format. Baseline **692 green** (root 517 / pi 108 / openclaw 67). Surface-parity
(13 MCP tools, CLI↔MCP 1:1) must stay green — none of these touch the tool
surface. Cargo-gated AQL suite out of scope. For D6, validate with a synthetic
in-test `.engram` fixture (a strong tier-1 cosine match must beat a weak tier-1
chunk); the assessment's empirical live-store numbers are the operator's to
reproduce.
