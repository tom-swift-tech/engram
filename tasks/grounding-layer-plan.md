# Plan: Subagent Grounding Layer (Product A)

Spec: `docs/GROUNDING-LAYER-SPEC.md` (Gage, draft).
Base tree: `main@62795f5` (post PR #28 — introspect + reflect empty-response).
Sequencing decisions (user-confirmed 2026-07-14):

1. **Build now in a new file.** `groundSubagent`/`taskContext` live in a new
   `src/grounding.ts` that *composes* `recall()`/`formatForPrompt()` — it does
   **not** edit recall's scoring internals (fusion `:849-885`, weighting
   `:898-963`, sort `:1136-1143`), which is the only surface the D6 remediation
   lane rewrites. So grounding and D6 touch disjoint regions and can proceed in
   parallel. This honors spec §9's *intent* (avoid the recall.ts collision) via
   file isolation instead of serialization. The only shared edit is additive
   re-export lines in `engram.ts`.
2. **Read-only = capability wrapper + readonly connection (spec §5 option 1+2).**
   `ReadonlyEngram` exposes no write methods AND rides a `{readonly:true}`
   better-sqlite3 connection, so even a raw-SQL escape fails at the driver.
   Verified feasible: `recall()`/`introspect()`/`queryContext()` are pure reads
   (no INSERT/UPDATE/temp-table), so a readonly connection never breaks them.

Non-goals reaffirmed (spec §6): no belief injection, no new MCP tools
(`surface-parity.test.ts` count stays **14** — spec's "13" is stale, but the
"adds zero tools" property holds), no subagent working state, no
disconfirmation fix.

---

## Build order (dependency-ordered)

### Step 1 — `ReadonlyEngram` + readonly-connection plumbing  ·  foundation

**New file: `src/readonly-engram.ts`**

```ts
export class ReadonlyEngram {
  private readonly db: Database.Database;      // {readonly:true} connection
  private readonly embedder: EmbeddingProvider; // shared from parent Engram
  // constructed only via Engram.readonlyView()
  async recall(query, options?): Promise<RecallResponse>
  async queryContext(ref, relevanceQuery, budget?): Promise<ContextSlice>
  introspect(subject?, options?): IntrospectResult
  close(): void   // closes only the readonly sibling connection
}
```

**`src/engram.ts` — add factory method:**

```ts
readonlyView(): ReadonlyEngram
```

- Opens a **second** connection: `new Database(this.dbPath, { readonly: true })`.
- Applies `busy_timeout = 5000` (WAL `journal_mode` is already persisted in the
  file header by the parent's read-write open; a readonly conn cannot and need
  not set it). Loads `sqlite-vec` (try/catch, same graceful-degrade as `init`).
- Reuses `this.embedder` — embedding is connection-independent.
- **Precondition (document it):** the parent `Engram` must already be open, so
  schema bootstrap + migrations have run. A readonly connection cannot migrate;
  it assumes an already-current file. `readonlyView()` enforces this structurally
  by only existing as a method on a live `Engram`.
- Expose only read ops. No `retain`/`reflect`/`commitContext`/`promoteContext`/
  `supersede`/`forget`/`expireContext` on the surface.

**Why a second connection, not delegation to the parent's RW handle:** the
parent `db` is read-write; delegating would give up option-2 defense-in-depth.
A dedicated readonly handle means a raw-SQL escape hatch fails at the driver
(`SQLITE_READONLY`), which is exactly the enforcement the spec asks for. WAL
mode makes the concurrent second reader free — no writer contention.

**Re-exports in `engram.ts`:** `ReadonlyEngram` type + class.

---

### Step 2 — `groundSubagent()` + `taskContext()`  ·  the read interface

**New file: `src/grounding.ts`**

```ts
const GROUNDING_TYPES = ['world', 'experience', 'observation'] as const;

export interface GroundingScope {
  task: string;
  maxChars?: number;          // default 2000 (formatForPrompt default)
  memoryTypes?: Array<'world' | 'experience' | 'observation'>;
  topK?: number;              // minor extension beyond spec — default 10
}
export interface Grounding {
  prompt: string;
  facts: RecallResult[];
  observations: RecallResponse['observations'];
  meta: { task: string; injectedChars: number };
}

export function groundSubagent(engram: ReadonlyEngram, scope: GroundingScope): Promise<Grounding>
export function taskContext(engram: ReadonlyEngram, parent: ContextRef, relevanceQuery: string, budget?: TokenBudget): Promise<ContextSlice>
```

`groundSubagent` semantics (spec §4.1):
- `memoryTypes` = requested set **intersected** with `GROUNDING_TYPES` (default
  all three). `opinion` is dropped even if a caller passes it — this is the hard
  cap. If the intersection is empty, fall back to all three grounding types
  (never zero — a caller asking only for `opinion` still gets grounded, just
  belief-free).
- `recall(scope.task, { memoryTypes, includeOpinions:false,
  includeObservations: memoryTypes.includes('observation'), scope:['durable'],
  topK })`. Durable-only — a subagent is auto-situated with facts, never
  auto-fed the parent task scope (that's `taskContext`, deliberate, spec §8).
- `formatForPrompt(response, { maxChars })`. Belief section is structurally
  absent (no opinions in the response), so the 0.85 confidence-cap path never
  fires. `meta.injectedChars = prompt.length`.

`taskContext` — thin pass-through to `engram.queryContext(parent, relevanceQuery,
budget)`. Exists as a named seam so the "orchestrator explicitly selects task
context" decision (spec §8) is a first-class call, not an inline `queryContext`.

**Design note — recency decay:** `groundSubagent` inherits recall's default
`decayHalfLifeDays: 180`. For a subagent situated with stable `world` facts that
may be a footgun (the issue-#19 trap). Leaving it at the default for now to match
recall; flag in the doc that a caller grounding from long-lived world facts
should pass `decayHalfLifeDays: 0`. (Not adding it to `GroundingScope` yet —
revisit if a consumer needs it.)

---

### Step 3 — `SubagentReport` + reference metabolize helper  ·  the hand-back

**In `src/grounding.ts` (or `src/subagent-report.ts`):**

```ts
export interface SubagentReport {
  result: unknown;
  artifact?: DecisionArtifact;
  candidateExperiences?: Array<{ text: string; context?: string }>;
}

export interface MetabolizeOptions {
  scope?: TaskScope;          // for artifact → commitContext
  keepExperiences?: (c: {text:string; context?:string}) => boolean; // orchestrator's per-item filter
}
export interface MetabolizeResult {
  artifactRef?: ContextRef;
  retainedExperienceIds: string[];
}

export function metabolizeReport(orchestrator: Engram, report: SubagentReport, opts?: MetabolizeOptions): Promise<MetabolizeResult>
```

Semantics (spec §4.3) — composes existing ops, **the orchestrator is the single
writer**:
- `report.artifact` → `orchestrator.commitContext(artifact, opts.scope)`
  (task-scoped, TTL'd). Promotion to durable is left to the orchestrator later
  via `promoteContext()` — not auto-run here.
- each `report.candidateExperiences[i]` passing `keepExperiences` (default: keep
  all) → `orchestrator.retain(text, { memoryType:'experience',
  sourceType:'agent_generated', trustScore:0.6, context })`. Tier 1 — cannot
  outrank user-stated facts. Reflection metabolizes them into beliefs on the
  **next cycle**, under the orchestrator's identity.
- Returns the refs/ids so the orchestrator can chain (e.g. `promoteContext`
  later). This helper is a **reference composition**, thin and mostly wiring —
  real orchestrators may inline their own policy.

**Re-exports in `engram.ts`:** `groundSubagent`, `taskContext`,
`metabolizeReport`, and types `GroundingScope`, `Grounding`, `SubagentReport`,
`MetabolizeOptions`, `MetabolizeResult`.

---

### Step 4 — Tests

**New: `tests/readonly-engram.test.ts`**
- (b1) `ReadonlyEngram` has no `retain`/`reflect`/`commitContext`/`supersede`/
  `forget` — assert the methods are `undefined` on the instance.
- (b2) Reaching the underlying readonly connection and attempting a write throws
  `SQLITE_READONLY` (driver-level backstop proof). Use a small raw-SQL probe.
- readonly `recall`/`introspect`/`queryContext` return the same results a
  read-write `Engram` would for the same file (parity smoke).
- `close()` on the view does not close the parent's connection (independent
  handles).

**New: `tests/grounding.test.ts`**
- (a) opinions never appear in a `groundSubagent` result even when
  `memoryTypes` includes `'opinion'` — retain an opinion + world facts, ground
  with `memoryTypes:['world','opinion']`, assert `grounding.prompt` has no
  "Beliefs" section and `facts` contains no `memoryType==='opinion'` row.
- (c) parent-scoped `taskContext` pulls artifacts committed under `parent` and
  **nothing** from a sibling scope — commit two artifacts under two different
  parents, assert cross-scope isolation.
- (d) a report round-trips through `metabolizeReport` into a durable
  `agent_generated` `experience` chunk that is then **challengeable by reflect**
  (assert the retained chunk lands in `getUnreflectedFacts` / survives a reflect
  cycle as expected). Use the existing mock generator pattern from
  `reflect.test.ts`.
- empty-intersection fallback: `memoryTypes:['opinion']` still grounds (three
  grounding types), belief-free.

**Test infra:** reuse `tests/helpers.ts` `MockEmbedder`/mock generator so no
Ollama/network. Follow the `decayHalfLifeDays:0` rule when comparing scores
across two recall calls (handoff gotcha).

---

### Step 5 — Docs (mirror-locked)

- **`CLAUDE.md` + `AGENTS.md`** (edit **both** — CI mirror filter): add a
  "Grounding Layer" bullet under Decisions or a new subsection; add
  `grounding.ts` + `readonly-engram.ts` to File Structure; note surface-parity
  stays 14 (library-only, no MCP tool).
- **`README.md`**: short usage snippet (`const ro = engram.readonlyView();
  const g = await groundSubagent(ro, { task });`).
- Skills (`skills/engram.md`, `skills/cli-memory/SKILL.md`): **no change** — no
  new MCP tool or CLI subcommand. Confirm surface-parity test still green.

---

## Verification pipeline (per verification-loop skill)

`npm run build` → typecheck → lint → `npm test` (expect 529 + new grounding/
readonly tests, all green; surface-parity still pins 14). Prettier: touched
`.ts` only; do not reformat markdown. Then commit on a feature branch
(`feat/grounding-layer`) with conventional-commit messages.

## Open items / deferred

- `decayHalfLifeDays` on `GroundingScope` — deferred until a consumer needs it.
- Belief injection for the orchestrator's own reasoning — blocked on the
  disconfirmation retrieval-gap fix (spec §2/§6), out of scope here.
- MCP exposure of `groundSubagent` — deliberate surface-parity change, out of
  scope (spec §6).

## Effort estimate

~1–1.5 days. Step 1 (readonly plumbing) and Step 4 (tests) are the bulk; Steps
2–3 are thin composition over existing ops. Single builder, one worktree,
base = `main@62795f5`.
