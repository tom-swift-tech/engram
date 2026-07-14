# Spec: Subagent Grounding Layer (Product A)

Status: draft for review
Scope: internal Engram capability — how an orchestrator's ephemeral subagents get situated
Author: Gage
Base tree: `main@aa149af` (+ `fix/engram-remediation` in flight)

Terminology: **orchestrator** = any agent that spawns a subagent and holds a
read/write Engram handle. **subagent** = a stateless, ephemeral consumer of
grounding. Engram is consumer-agnostic — it provides the capability; the
orchestrator is whatever agent the deployment wires in.

---

## 1. What this is

A named, enforced interface that lets an orchestrator spawn a **stateless**
subagent with scoped situated context (world / experience / observation —
**never opinion**) injected at spawn, and receive a structured report back on
completion. The subagent holds no durable state and writes nothing to the
`.engram` store. Everything durable happens on the orchestrator's side of the
boundary, before spawn and after report.

One sentence: **grounding in, report out, nothing written by the subagent.**

## 2. Why belief-free

Disconfirmation in Engram is real but **retrieval-gated**: `reflect.ts` can
`challenge` a belief (−0.15/cycle) and passively decays untouched opinions
(−0.02/cycle, floor 0.1), but a belief is only challengeable if it lands in the
reflect prompt's existing-opinions window (`getExistingOpinions`, top-20 by
confidence, 8000-char budget). A high-confidence-but-wrong belief that never
co-occurs with its contradicting evidence in one batch is never corrected.

Therefore beliefs are **not yet safe to inject blind**. A stateless subagent
has no revision loop of its own and can't tell a sound belief from a stale one.
Injecting `opinion`-type memory into it would export confidence without the
correction machinery. Grounding types (`world`/`experience`/`observation`) carry
no confidence claim of that kind — they're facts and episodes, not adjudicated
beliefs — so they're safe to inject universally. Beliefs stay behind the
orchestrator, the only party holding the full retain/reflect/introspect loop
needed to wield them.

## 3. What already exists (compose, don't build)

Most of A is knobs already present in the tree:

| Need | Existing mechanism | File |
|------|--------------------|------|
| Exclude beliefs from grounding | `RecallOptions.memoryTypes: ['world','experience','observation']` + `includeOpinions:false` + `includeObservations:false` | `recall.ts` |
| Scope grounding under a spawn | `scope:['task']` + `parentRef` | `recall.ts`, `context-store.ts` |
| Ephemeral / no-reflect-pollution | `scope='task'` rows excluded from `v_unreflected` / `getUnreflectedFacts` | `schema.sql`, `reflect.ts` |
| Trust floor on agent writes | `source_type` tiering (`agent_generated` = tier 1, can't outrank `user_stated`) | `recall.ts` |
| Bounded injection | `formatForPrompt(maxChars)` / `TokenBudget` | `recall.ts`, `context-store.ts` |
| Report-up artifact shape | `DecisionArtifact` | `context-store.ts` |
| Parent/child spawn chain | `ContextRef` + `parent_ref` | `context-store.ts` |
| Orchestrator commits report task-scoped | `commitContext()` | `context-store.ts` |
| Orchestrator promotes a keeper to durable | `promoteToDurable()` / `retain()` | `context-store.ts`, `retain.ts` |

What does **not** exist yet, and is the actual build:

- **A hard read-only guarantee.** Nothing structurally prevents a caller with a
  `db` handle from calling `retain`/`reflect`/`commitContext`. Today read-only
  is convention. A needs it enforced, because "subagent writes durable state" is
  exactly the ownership-ambiguity bug class the store is meant to avoid.
- **A single named entry point** so a spawn is one call, not a recipe of five
  `RecallOptions` a caller can get subtly wrong (e.g. forgetting to exclude
  opinions).

## 4. The interface

### 4.1 `groundSubagent(...)` — the read path (orchestrator-side, at spawn)

```ts
export interface GroundingScope {
  /** Relevance query describing the subagent's task. Drives RRF retrieval. */
  task: string;
  /** Char budget for the injected block. Default 2000 (formatForPrompt default). */
  maxChars?: number;
  /** Durable memory types to ground from. Hard-capped to the grounding set. */
  memoryTypes?: Array<'world' | 'experience' | 'observation'>;
}

export interface Grounding {
  /** Ready-to-inject system-prompt block (headered, budgeted). */
  prompt: string;
  /** Structured form, for callers that assemble their own prompt. */
  facts: RecallResult[];
  observations: RecallResponse['observations'];
  /** Provenance: what scope/query produced this, for the report audit trail. */
  meta: { task: string; injectedChars: number };
}

export function groundSubagent(
  engram: ReadonlyEngram,
  scope: GroundingScope,
): Promise<Grounding>;
```

Semantics:

- Runs `recall()` with `memoryTypes` **intersected** with
  `['world','experience','observation']` — `opinion` is dropped even if a caller
  passes it. `includeOpinions:false`, `includeObservations` follows whether
  `observation` is in the set.
- The auto-path grounds from **durable memory only** (`scope:['durable']`). A
  subagent is automatically situated with world/experience/observation facts;
  it is **not** automatically fed the parent task's committed decisions. Task
  context is injected explicitly (§4.1a) so the orchestrator retains control of
  exactly what a subagent sees — the same principle that keeps beliefs behind
  the orchestrator, applied one layer down.
- Returns a `formatForPrompt`-rendered block. Belief section is structurally
  absent (no opinions in the response), so the 0.85 confidence-cap path never
  fires — there are simply no beliefs to cap.

### 4.1a Explicit task-context injection (orchestrator-side, deliberate)

When the orchestrator wants a subagent to see specific parent-task decisions, it
injects them explicitly rather than relying on auto-inheritance:

```ts
/** Orchestrator selects exactly which committed artifacts under a parent the subagent sees. */
export function taskContext(
  engram: ReadonlyEngram,
  parent: ContextRef,
  relevanceQuery: string,
  budget?: TokenBudget,
): Promise<ContextSlice>;   // thin pass-through to queryContext()
```

The orchestrator calls `taskContext(...)`, reviews/selects the slice, and
concatenates it into the subagent prompt alongside the `groundSubagent` block.
The subagent receives a single assembled prompt; it never queries the task scope
itself. This keeps the "what task-context does this subagent get" decision with
the orchestrator, consistent with single-writer provenance and with beliefs
staying behind the orchestrator.

### 4.2 `SubagentReport` — the hand-back (subagent-side, on completion)

The subagent returns a plain object. It does **not** touch the db.

```ts
export interface SubagentReport {
  /** The subagent's task output — freeform, consumed by the orchestrator. */
  result: unknown;
  /**
   * Optional structured decision record, DecisionArtifact-shaped. Present when
   * the subagent reached a decision worth metabolizing. The orchestrator — not
   * the subagent — decides whether this becomes task-scoped context or durable
   * memory.
   */
  artifact?: DecisionArtifact;
  /**
   * Optional raw experiences the subagent thinks are worth remembering.
   * These are CANDIDATES. The orchestrator reflects on them; it is the single
   * writer.
   */
  candidateExperiences?: Array<{ text: string; context?: string }>;
}
```

### 4.3 Orchestrator-side metabolism (after report, existing tools)

Not new code — this is the orchestrator composing existing ops on the report:

- `report.artifact` → `commitContext()` (task-scoped, TTL'd) if useful only
  within the current task; or `promoteToDurable()` later if it proves durable.
- `report.candidateExperiences` → the orchestrator decides per-item: drop, or
  `retain()` as `experience` with `source_type:'agent_generated'` (tier 1 —
  cannot outrank user-stated facts). Reflection then metabolizes them into
  beliefs on the **next cycle**, under the orchestrator's identity, with full
  provenance.
- Every durable write traces to the orchestrator's judgment, not to an ephemeral
  agent that no longer exists. Provenance stays clean; the belief loop closes on
  the orchestrator.

## 5. The read-only guarantee

The one real enforcement gap. Options, in preference order:

1. **`ReadonlyEngram` capability wrapper** (recommended). A thin object exposing
   only `recall` / `groundSubagent` / `queryContext` / `introspect`, constructed
   from an Engram instance, handed to the subagent-spawning path. No `retain`,
   `reflect`, `commitContext`, `promoteToDurable`, `supersede`, `forget` on the
   surface. Subagent code physically cannot call a write — it doesn't hold a
   reference to one. Cheapest, strongest, no schema change.
2. **Read-only SQLite connection** (`better-sqlite3` `readonly:true`) for the
   subagent's db handle. Defense in depth under option 1 — even a raw-SQL escape
   hatch fails at the driver. Costs a second connection; worth it.
3. Convention + review. Rejected — this is the exact class of thing not to leave
   to convention.

Recommendation: **1 + 2.** Capability wrapper for the API surface, read-only
connection behind it so there's no SQL bypass. A stateless subagent gets a
`ReadonlyEngram` over a `readonly` connection and is structurally incapable of
mutating the store.

## 6. Explicit non-goals (scope fences)

- **Not belief injection.** Opinions never reach a subagent. (Orchestrator-only,
  gated on the retrieval-gap fix in §2 being closed first — separate work.)
- **Not the Herd transparent shim.** The universal-provider surface is a later
  layer built *on* A, not part of A.
- **Not new MCP tools.** Surface-parity pins the tool count at 14; A adds no
  tools. `groundSubagent` is a library function the orchestrator's spawn path
  calls, not an MCP-exposed op. (If subagents later need it over MCP, that's a
  deliberate surface-parity change, out of scope here.)
- **Not subagent working state.** Subagents are stateless (operator decision).
  No ContextStore writes by subagents, no `working_memory` rows. Working state,
  if any, lives in the subagent's own process memory and dies with it.
- **Not the disconfirmation fix.** The retrieval-gated-challenge gap (§2) is
  real and load-bearing for the orchestrator's *own* belief-injection, but A
  sidesteps it by never injecting beliefs. Fixing it is prerequisite for a
  future "orchestrator reasons from its own beliefs" path, not for A.

## 7. Build order

1. `ReadonlyEngram` wrapper + `readonly`-connection plumbing (§5). Foundation —
   everything else is handed this.
2. `groundSubagent()` over `recall()` with the hard grounding-type cap (§4.1).
3. `SubagentReport` type + a reference orchestrator-side metabolize helper that
   composes `commitContext`/`retain`/`promoteToDurable` (§4.3). Thin; mostly
   wiring.
4. Tests: (a) opinions never appear in a `groundSubagent` result even when asked
   for; (b) a `ReadonlyEngram` throws/absent on every write op; (c) parent-scoped
   grounding pulls task artifacts under the parent and nothing from sibling
   scopes; (d) a report round-trips through metabolize into a durable
   `agent_generated` experience that is then challengeable by reflect.

## 8. Decision record: task-context is explicit, not auto-inherited

`groundSubagent`'s auto-path grounds from durable memory only. A subagent does
**not** automatically inherit the parent task's committed decisions. When the
orchestrator wants a subagent to see specific parent-task context, it pulls it
with `taskContext()` (§4.1a), selects the slice, and injects it into the prompt
itself.

Rationale: auto-inheriting the parent scope would silently determine what a
subagent is situated with, taking that control out of the orchestrator's hands —
the same loss of control this spec rejects for beliefs, reintroduced one layer
down. Explicit injection is one more call and keeps provenance and situating
decisions where they belong: with the single writer. Ergonomics lost to that
call are worth the consistency.

## 9. Sequencing note

A touches `recall.ts` (adds `groundSubagent`). The in-flight
`fix/engram-remediation` sprint (D1–D6, `tasks/todo.md`) also touches
`recall.ts` — the D6 lane reworks recall scoring/`minScore`. A should land
**after** that sprint merges, or on a branch rebased on it, not in parallel.
