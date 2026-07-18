# Field Report — Hermes agent evaluation of Engram (2026-07-16)

## Source

External user ("Ben") running the **Pi integration** (`pi-engram` tab visible in
screenshot, model `gpt-5.6-luna`). His agent, Hermes, was asked to evaluate
Engram as its own memory system and produced a written assessment. Screenshot
shared 2026-07-16 shows the tail of the report; the full text above the visible
portion has not been provided. **This is the strongest demand-signal class we
track: a live external consumer reporting from production use** (contrast: the
engram-aql freeze was justified partly because its only signal was one inbound
question).

## Hermes's verdict (verbatim gist)

> "Engram is useful as a long-term associative memory, not as an authority.
> Its retrieval mechanisms appear promising, especially semantic plus graph
> search, but the current evidence shows that curation and observability are
> still the limiting factors. … I would trust it to remind me of your
> preferences and recurring workflows. I would not trust it alone to tell me
> the current state of your machine … Engram should provide a lead, followed
> by live verification."

This matches design intent exactly (trust layer, memory-as-lead-not-authority).
The model formed the correct mental model of the tool. The critique is aimed at
**curation and observability**, not retrieval quality.

Stated stronger for: stable preferences, durable environment facts, workflow
conventions, long-lived technical decisions, recurring lessons.
Stated weaker for: current software versions, temporary project state, one-off
debugging details, exact historical claims, credentials/security-sensitive
info, facts needing live verification.

## The 7 requested improvements, mapped to the codebase (verified 2026-07-16)

| # | Ask | Status | Evidence |
|---|-----|--------|----------|
| 1 | Better stale-memory detection | **OPEN** | `supersede`/`forget` are manual; reflect challenges opinions but world-facts never get staleness review. No contradiction-flagging between old and new chunks. |
| 2 | Recency-aware retrieval | **EXISTS in core, invisible in Pi** | `RecallOptions.decayHalfLifeDays` (default 180). Pi adapter **hardcodes `0`** (`integrations/pi/src/adapter.ts:101`, deliberate — issue #19) with no per-call override. Also not exposed on MCP tool or CLI (verified: zero matches in `mcp-tools.ts`/`cli.ts`/`cli-args.ts`). |
| 3 | Stronger ranking for explicit user statements | **SHIPPED, invisible** | The source-tier floor: `user_stated` = tier 0, structurally outranks tool/external content regardless of score. Agent can't see tiers in recall output, so it doesn't know the guarantee exists. |
| 4 | Auto-separation of durable facts vs conversation/test data | **PARTIAL** | Auto-retain stores conversation as `experience` at `tool_result`-tier trust for tool output; `retainMission` gates. But no mechanism distinguishes test-data contamination — a real live-usage symptom. |
| 5 | Clear expiration or review dates | **OPEN (durable scope)** | TTL exists only for task-scoped ContextStore artifacts. Durable chunks have no `review_after`/expiry concept. |
| 6 | Audit view: why was a memory retrieved | **EXISTS in core+MCP+CLI, missing in Pi** | `explainScores` → `strategyScores` breakdown shipped in `recall.ts`, `mcp-tools.ts:153`, CLI `--explain-scores`. **Not** in the Pi tool schema/passthrough (`integrations/pi/src/{types,adapter,index}.ts`), and `formatRecallResults` (`index.ts:539`) shows only trust + source, no tier/type/date/strategy. |
| 7 | Eval tests: precision, recall, contradiction handling, contamination | **OPEN** | 562 tests pin mechanics; no retrieval-quality benchmark exists. Keystone item — it would tell us whether 1/4/5 are real problems or vibes. |

## Read on the pattern

Three of seven asks (2, 3, 6) are **adapter-lag**: the capability exists but the
Pi tool surface can't see it. Same failure mode as the 2026-07-09
`engram_recall` widening. An agent's evaluation of a memory library is really
an evaluation of the **tool schema + formatted output** — capabilities not
surfaced there do not exist from the agent's point of view.

## Disposition

Sprint specced: `tasks/sprint-hermes-observability.md` (surface parity + eval
harness first; staleness/expiry deferred pending eval data).

## Open follow-ups with the reporter

- **Dropped (2026-07-18)**: no channel to reach the reporter ("Ben") beyond the
  original screenshot share; not worth chasing further. The 7-item mapping
  above and the shipped sprint work stand on their own regardless of the full
  report text.
