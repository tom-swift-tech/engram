# Engram retrieval-quality eval harness

Answers ask 7 of `tasks/feedback-hermes-report.md` / T3+T4 of
`tasks/sprint-hermes-observability.md`: a way to measure recall quality
instead of arguing about it from vibes. **Report-only** — no thresholds, no
non-zero exit on a "bad" score, and it is **not a CI gate**. It converts
asks 1/4/5 from opinions into numbers a later design decision can point at.

## What it measures

`Engram.retain()` / `Engram.recall()` only — the real local embedder
(`@huggingface/transformers`, same model the test suite downloads), no
Ollama, no reflect/extract, no LLM anywhere. It runs wherever `npm test`
runs.

Four scenario families, each a fixture corpus (`fixtures/*.json`) plus
labeled queries (`scenarios/*.json`):

1. **relevance** (`fixtures/relevance.json`, 27 chunks / 6 topics) — baseline
   precision@5 / recall@5 / MRR against known relevant-chunk-id sets. The
   floor every other family is read relative to.
2. **contradiction** (`fixtures/contradiction.json`, 16 chunks) — old-vs-new
   versions of the same fact. Two pairs stay active-active (both chunks
   live; the newer/higher-trust one is *supposed* to out-rank the stale
   one); two pairs go through `Engram.supersede()` (the old chunk is marked
   `is_active = FALSE` and must be structurally excluded, not merely
   out-ranked). Probes ask 1 (staleness detection) without building any
   detection machinery yet.
3. **contamination** (`fixtures/contamination.json`, 21 chunks) — 6
   `user_stated` facts mixed with 15 `tool_result` noise chunks that share
   heavy vocabulary with them. Measures the trust-tier floor's real-world
   effectiveness (ask 4) beyond the synthetic single-pair case
   `tests/trust-tier.test.ts` already covers.
4. **staleness** (`fixtures/staleness.json`, 10 chunks) — the same fact
   retained at four backdated ages (7d/90d/400d/900d), same query re-run
   under `decayHalfLifeDays` 0/30/180 side by side. Evidence for the
   recency-decay tradeoff CLAUDE.md already documents (asks 2/5).

Every recall pins `decayHalfLifeDays: 0` explicitly except the staleness
family, which is *about* decay — scores are otherwise wall-clock-dependent
(see CLAUDE.md's "Recency decay tradeoff" note).

`results[]` from `recall()` is tier-major, not pure-relevance order (see
CLAUDE.md: "Consumers must NOT read `results[0]` as the highest-relevance
match overall"). The harness deliberately does **not** re-sort by score —
it measures what an agent calling `recall()` actually sees, in the order it
actually sees it.

## How to run

```bash
npm run eval          # tsx evals/run.ts
```

First run downloads the local embedding model (same one-time cost
`npm test` pays). Produces:

- `evals/results.json` — machine-readable, full per-query detail
- a markdown table per family on stdout (reproduced below)

## Baseline (2026-07-16)

### relevance

| query | P@5 | R@5 | RR |
|---|---|---|---|
| What tool provisions VMs in the homelab? | 0.20 | 0.50 | 1.00 |
| How many Proxmox nodes are needed for quorum? | 0.20 | 1.00 | 1.00 |
| Why is SQLite chosen over Postgres? | 0.40 | 1.00 | 1.00 |
| What language is preferred for systems programming? | 0.20 | 1.00 | 1.00 |
| What language is used for new tooling projects? | 0.20 | 1.00 | 1.00 |
| How does WAL mode help concurrent database access? | 0.20 | 1.00 | 1.00 |
| How is DNS handled in the homelab network? | 0.20 | 0.50 | 1.00 |
| What runs the CI pipeline? | 0.40 | 1.00 | 1.00 |
| How are homelab metrics visualized? | 0.40 | 1.00 | 1.00 |
| How are disk usage alerts delivered? | 0.20 | 1.00 | 1.00 |

**Aggregate: P@5=0.26, R@5=0.90, MRR=1.00**

MRR of 1.0 across all 10 queries means the single best match always lands
at rank 1; P@5 sits well under 1.0 by construction (most queries have 1-2
labeled-relevant ids against a 27-chunk, 6-topic corpus and a fixed k=5
window, so most of the top-5 is legitimately drawn from other topics, not a
miss).

### contradiction

| query | P@5 | R@5 | RR | distractor rank |
|---|---|---|---|---|
| What Node.js version does the staging server run? | 0.20 | 1.00 | 1.00 | 2 |
| What is the primary deployment region? | 0.20 | 1.00 | 0.50 | 1 |
| What is the API gateway rate limit? | 0.20 | 1.00 | 1.00 | excluded |
| How long is the on-call rotation? | 0.20 | 1.00 | 1.00 | excluded |

**Aggregate: P@5=0.20, R@5=1.00, MRR=0.875**

Three of four pairs behave as hoped. The fourth is the interesting finding:
for "What is the primary deployment region?", the **stale** fact
("The primary deployment region is **us-east-1**.", trust 0.75, 120 days
old) ranks *above* the current one ("...moved to **eu-central-1** for
latency reasons.", trust 0.9, 10 days old) — with `decayHalfLifeDays: 0`
pinned, so decay isn't the cause. The stale sentence is a closer phrasing
match to the query ("is region X" vs. "was moved to region X for reason
Y"), and semantic similarity wins over the trust/recency multipliers here.
This is exactly the ask-1 gap (no staleness detection exists yet) made
concrete: recall's trust weighting is a *soft* tiebreak on top of cosine
similarity (see CLAUDE.md D6), not a hard "newer wins" rule, and phrasing
can beat it. The two `supersede()` pairs sidestep the problem entirely by
structurally excluding the old chunk — worth weighing against a
detection-based fix for Phase 4.

### contamination

| query | P@5 | R@5 | RR | distractor rank |
|---|---|---|---|---|
| When is the production database backed up? | 0.20 | 1.00 | 1.00 | 7 |
| What is the support SLA for first response? | 0.20 | 1.00 | 1.00 | 8 |
| How long do refunds take to process? | 0.20 | 1.00 | 1.00 | 7 |
| What authentication is required for balance transfers? | 0.20 | 1.00 | 1.00 | 8 |
| How often is the search index rebuilt? | 0.20 | 1.00 | 1.00 | 7 |
| When does the billing cycle close? | 0.20 | 1.00 | 1.00 | 7 |

**Aggregate: P@5=0.20, R@5=1.00, MRR=1.00, avgNoiseInTop5=0.00**

The tier floor holds cleanly here: every `user_stated` core fact wins rank 1
and zero `tool_result` noise chunks crack the top 5 across all six queries,
despite heavy vocabulary overlap by design. This is a real corpus, not the
synthetic single-pair case in `tests/trust-tier.test.ts` — good evidence the
floor generalizes.

### staleness

Query: "What does the reporting service use for local caching?" — same
text retained at 7d/90d/400d/900d old, target = freshest (7d).

| decayHalfLifeDays | target rank | order (age variant → rank) |
|---|---|---|
| 0 | 1 | 7d→1, 90d→2, 400d→3, 900d→4 |
| 30 | 1 | 7d→1, 90d→8, 400d→9, 900d→10 |
| 180 | 1 | 7d→1, 90d→3, 400d→9, 900d→10 |

Even at `decayHalfLifeDays: 0` (no decay applied) the four identical-text
duplicates come out in age order (7d, 90d, 400d, 900d) rather than tied —
with cosine and trust score identical across all four, the tiebreak falls
through to retain/insertion order, not anything decay-related. That's worth
knowing before reading too much into a `0` result: "no decay" does not mean
"ties break randomly," it means "ties break on whatever non-decay signal is
left," which here is insertion order specifically because the fixture is a
maximally-degenerate all-else-equal case.

At `decayHalfLifeDays: 30` the 400d/900d variants fall to rank 9-10 (out of
a 10-chunk store) — decay is doing real, steep work. At `180` the same two
variants are still pushed to 9-10, but the 90d variant recovers from rank 8
to rank 3 — the longer half-life is materially gentler on medium-age facts
specifically, which is the tradeoff CLAUDE.md's "Recency decay tradeoff"
note describes in the abstract, now with a concrete before/after.

## Regenerating

`evals/results.json` is committed as the current baseline snapshot. Re-run
`npm run eval` any time recall/retain scoring changes and diff the numbers
above against the new run — this harness has no pass/fail threshold by
design (see T3), so a numeric regression is a judgment call for whoever's
reviewing it, not an automated gate.
