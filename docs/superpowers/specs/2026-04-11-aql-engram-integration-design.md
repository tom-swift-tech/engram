# AQL-Engram Integration Design

**Date:** 2026-04-11
**Status:** Approved
**Repo:** swift-innovate/engram
**AQL Source:** srirammails/AQL (v0.5)

## Summary

Add AQL (Agent Query Language) as a declarative query layer on top of Engram's existing TypeScript API. AQL strings are parsed by the canonical Rust `aql-parser` crate compiled to WASM, translated into Engram method calls, and executed against the `.engram` SQLite file through Engram's existing pipelines.

Two-phase rollout:
- **Phase 1 (Agentic Core):** The cognitive memory operations — recall, store, link, reflect, pipeline
- **Phase 2 (Analytical):** Complex predicates, aggregation, HAVING — pending clarification from AQL creator on intent

## Goals

1. Give LLM agents a declarative, auditable language for memory access (replacing imperative `recall(query, options)` calls)
2. Give humans a REPL/inspection tool for agent memory ("SQL for your agent's brain")
3. Use the canonical Rust parser as single source of truth — no grammar drift
4. Preserve all Engram guarantees: RRF fusion, trust weighting, temporal decay, fast-write pipeline, extraction queue

## Non-Goals

- Replacing the TypeScript API — `retain()`/`recall()`/`reflect()` remain the primary programmatic interface
- Implementing ClawDB's LanceDB backend — Engram's SQLite backend is the only target
- Full SQL semantics — AQL is a memory language, not a database language

## Architecture

```
Agent or Human
    |
    |  AQL string + optional variables
    v
engram.query(aql, vars?)
    |
    v
┌──────────────────────────────────────────────────┐
│  src/aql.ts                                       │
│                                                    │
│  1. Parse ──► aql-parser WASM ──► Statement AST   │
│                                                    │
│  2. Map memory types                               │
│     AQL EPISODIC  ──► engram 'experience'          │
│     AQL SEMANTIC  ──► engram 'world'               │
│     AQL PROCEDURAL ──► engram 'observation'        │
│     AQL WORKING   ──► engram working_memory table  │
│     AQL TOOLS     ──► engram (new: tool registry)  │
│     AQL ALL       ──► all memory types             │
│                                                    │
│  3. Translate ──► Engram API calls                 │
│     RECALL  ──► engram.recall()                    │
│     STORE   ──► engram.retain()                    │
│     UPDATE  ──► engram.retain() + supersede        │
│     FORGET  ──► engram.forget()                    │
│     SCAN    ──► working memory session queries     │
│     LINK    ──► direct SQLite (entities/relations) │
│     REFLECT ──► engram.reflect()                   │
│     LOOKUP  ──► engram.recall() with key filter    │
│     LOAD    ──► tool registry query (new)          │
│     PIPELINE ──► sequential query chaining         │
│                                                    │
│  4. Return ──► QueryResult                         │
└──────────────────────────────────────────────────┘
```

## Memory Type Mapping

| AQL Type | Engram Storage | Engram memory_type | Notes |
|----------|---------------|-------------------|-------|
| EPISODIC | chunks table | `experience` | Agent's own actions and observations |
| SEMANTIC | chunks table | `world` | Facts about the world, vector-searchable |
| PROCEDURAL | observations table | (n/a — separate table) | Synthesized patterns from reflection |
| WORKING | working_memory table | (n/a — separate table) | Short-term session state |
| TOOLS | (new table needed) | (n/a — new) | Tool registry with ranking |
| ALL | chunks + observations + working_memory | all types | Cross-memory search |

### Mapping Gaps (Engram additions required)

**TOOLS memory type:** AQL's `LOAD FROM TOOLS` implies a ranked tool registry. Engram has no tool storage today. Phase 1 adds a `tools` table:

```sql
CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    api_url TEXT,
    ranking REAL DEFAULT 0.5,
    tags TEXT DEFAULT '[]',        -- JSON array
    namespace TEXT DEFAULT 'default',
    scope TEXT DEFAULT 'private',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);
```

**PROCEDURAL mapping nuance:** AQL treats PROCEDURAL as a read/write memory type. Engram's `observations` table is write-only via `reflect()` — observations are synthesis output, not user-stored records.

Phase 1 resolution:
- `RECALL FROM PROCEDURAL` → queries the `observations` table (read works naturally)
- `STORE INTO PROCEDURAL` → creates a new observation row directly (bypasses reflect, marked `source_type = 'agent_generated'` to distinguish from reflect-synthesized observations)
- Field mapping: `confidence` → derived from source chunk trust scores, `pattern_id` → `observations.id`, `summary`/`description` → `observations.summary`, `domain`/`topic` → mapped directly
- Arbitrary fields beyond these → stored as JSON in a new `data_json` column on observations (mirrors working_memory's pattern)

**LINK mapping:** AQL's `LINK` creates typed edges between records. Engram already has `entities` and `relations` tables — a natural fit. The translator maps:
- `LINK <source_id> TO <target_id> TYPE "relation_type"` → INSERT into `relations` table
- `WITH LINKS` → JOIN through `chunk_entities` + `relations`
- `FOLLOW LINKS TYPE "x" DEPTH n` → recursive CTE on `relations`

## Phase 1: Agentic Core

### In-Scope Statements

#### RECALL

```
RECALL FROM SEMANTIC WHERE context = "infrastructure" LIMIT 5 RETURN *
```

Translates to:
```typescript
engram.recall(inferredQuery, {
  memoryTypes: ['world'],
  contextFilter: 'infrastructure',
  topK: 5,
});
```

**Simple WHERE translation:** Phase 1 supports single-field equality filters. These map to existing RecallOptions:
- `WHERE context = "x"` → `contextFilter: "x"`
- `WHERE source = "x"` → `sourceFilter: "x"`
- `WHERE trust_score >= N` → `minTrust: N`
- `WHERE memory_type = "x"` → `memoryTypes: [mapped_type]`

**WHERE with semantic content:** When WHERE references a content field (e.g., `WHERE concept = "auth"`), the value is used as the semantic query input to `recall()`.

**RETURN fields:** Maps to post-processing — recall returns full results, translator selects requested fields.

**WINDOW modifier:**
- `WINDOW LAST 5` → `topK: 5` with `ORDER BY created_at DESC`
- `WINDOW LAST 24h` → `after: <24h ago ISO string>`

**MIN_CONFIDENCE:** Maps to `minTrust` on RecallOptions.

**SCOPE / NAMESPACE:** Engram doesn't have scope/namespace on chunks today. Phase 1 accepts these modifiers syntactically but ignores them at execution time, emitting a warning in `QueryResult.warnings`. If Phase 2 confirms these are needed (per AQL creator input), Engram will add `scope` and `namespace` columns to the chunks table.

#### SCAN

```
SCAN FROM WORKING WINDOW LAST 5
```

Direct query against `working_memory` table. Returns the N most recent active sessions. No RRF fusion — SCAN is a direct read, not a semantic search.

#### LOOKUP

```
LOOKUP FROM EPISODIC KEY bid_id = "e-001"
```

Translates to a direct SQLite query on the chunks table:
```sql
SELECT * FROM chunks WHERE id = ? AND memory_type = 'experience' AND is_active = TRUE
```

LOOKUP is exact-match by design — no semantic search, no RRF. Falls through to `recall()` only if KEY targets a content field.

#### LOAD

```
LOAD FROM TOOLS WHERE task = "image_resize" LIMIT 3 RETURN name, api_url
```

Queries the new `tools` table, ordered by ranking. Returns top-N tools matching the filter.

#### STORE

```
STORE INTO EPISODIC (event = "deployed_v2", outcome = "success", confidence = 0.9)
```

Translates to:
```typescript
engram.retain(
  JSON.stringify({ event: "deployed_v2", outcome: "success", confidence: 0.9 }),
  {
    memoryType: 'experience',
    sourceType: 'agent_generated',
    trustScore: 0.9,  // from confidence field if present
  }
);
```

**Field mapping for STORE:**
- All key-value pairs are serialized as the text content (JSON)
- `confidence` → `trustScore` on RetainOptions
- `scope` → stored in context field (Phase 1 workaround)
- `namespace` → stored in source field prefix (Phase 1 workaround)
- `ttl` → Engram has no TTL today; Phase 1 logs a warning, Phase 2 adds TTL support

**STORE INTO TOOLS:** Inserts into the `tools` table directly.

#### UPDATE

```
UPDATE EPISODIC SET outcome = "rollback" WHERE event = "deployed_v2"
```

Translates to:
1. Query for matching chunks
2. For each match: `engram.supersede(oldChunkId, updatedText)`

This preserves Engram's supersession chain — the old chunk is marked `superseded_by` and a new chunk is created.

#### FORGET

```
FORGET FROM WORKING WHERE stale = true
```

Translates to:
- For chunks: soft-delete via `is_active = FALSE`
- For working memory: `expireStaleWorkingSessions()`
- For tools: soft-delete via `is_active = FALSE`

Engram's existing `forget(chunkId)` is called per matched record. FORGET is idempotent.

#### LINK

```
LINK chunk-abc TO chunk-xyz TYPE "caused_by" WEIGHT 0.8
```

Direct insert into Engram's `relations` table:
```sql
INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, confidence)
VALUES (?, ?, ?, 'caused_by', 0.8)
```

**Entity resolution:** AQL LINK references record IDs, but Engram's `relations` table connects entity IDs. The translator resolves this:
1. If source/target IDs match entities directly → create the relation
2. If source/target IDs are chunk IDs → look up associated entities via `chunk_entities`. If a chunk has exactly one subject entity, use it. If multiple, use the first subject entity.
3. If no entities exist for a chunk → create a placeholder entity (type: 'concept', name derived from chunk text, canonical_name from ID) and then create the relation
4. The WEIGHT modifier maps to `relations.confidence`

#### WITH LINKS / FOLLOW LINKS

```
RECALL FROM SEMANTIC WHERE concept = "auth"
  FOLLOW LINKS TYPE "implements" INTO PROCEDURAL
  RETURN pattern, confidence
```

Execution:
1. `engram.recall("auth", { memoryTypes: ['world'] })` — get initial results
2. For each result, query `chunk_entities` → `relations` (filtered by type "implements") → target entities → `chunk_entities` → target chunks in observations
3. Return the linked observations

`FOLLOW LINKS DEPTH N` uses a recursive CTE on the `relations` table, capped at depth N.

`WITH LINKS` attaches link metadata to results without traversing — adds a `links` array to each returned record.

#### REFLECT

```
REFLECT FROM EPISODIC WHERE outcome = "success",
        FROM PROCEDURAL WHERE domain = "deployment"
  THEN STORE INTO EPISODIC (synthesis = "deployment patterns")
```

Execution:
1. Recall matching records from each source
2. Pass aggregated context to `engram.reflect()` (or a targeted variant)
3. If THEN clause present, store the reflection output

For Phase 1, basic REFLECT (no arguments) maps directly to `engram.reflect()`. REFLECT with FROM clauses requires a new `engram.reflectOn(chunks)` method that reflects on specific records rather than all unreflected facts.

#### PIPELINE

```
PIPELINE deploy_review TIMEOUT 30s
  RECALL FROM EPISODIC WHERE event = "deploy" WINDOW LAST 10
  THEN RECALL FROM PROCEDURAL WHERE domain = "deployment"
  THEN STORE INTO EPISODIC (review = "complete")
```

Execution:
1. Execute each stage sequentially
2. Results from stage N are available as `{variables}` in stage N+1
3. TIMEOUT applies to the entire pipeline — abort if exceeded
4. Named pipelines are logged for audit

The translator maintains a variable scope across stages. Each stage's results populate variables that subsequent stages can reference via `{varname}` or `$varname`.

### New Engram Additions Required (Phase 1)

| Addition | Reason |
|----------|--------|
| `tools` table in schema.sql | LOAD FROM TOOLS needs storage |
| `engram.query(aql, vars?)` method | Public AQL entry point |
| `engram.reflectOn(chunks)` method | REFLECT with targeted FROM clauses |
| `aql-parser` WASM as npm dependency | Parser loaded at Engram.create() |
| `engram_aql` MCP tool | AQL strings via MCP |
| `src/aql.ts` module | Translator implementation |

### QueryResult Type

```typescript
interface AqlQueryResult {
  success: boolean;
  statement: string;          // which AQL statement type was executed
  data: Record<string, unknown>[];  // result records
  count: number;
  timing_ms: number;
  error?: string;
  warnings?: string[];        // e.g., "SCOPE modifier ignored (not yet supported)"
  links?: Link[];             // populated when WITH LINKS is used
  pipeline_stages?: number;   // for PIPELINE queries
}
```

## Structured Query Features (Confirmed Agentic — Phase 1)

Per AQL creator clarification (2026-04-11): ORDER BY, AGGREGATE, and compound WHERE are agent self-assessment operations, not analytics. Example use cases:
- "How many times have I deployed?" → `AGGREGATE COUNT(*) AS total`
- "What were my last 10 actions?" → `ORDER BY created_at DESC LIMIT 10`
- "Average confidence on ops tasks?" → `AGGREGATE AVG(confidence) AS avg_conf`
- "Deploys that succeeded this week?" → `WHERE outcome = "success" AND created_at > "2026-04-07"`

### Implementation: Direct SQLite Query Path

These features cannot be expressed through Engram's `RecallOptions` (which is semantic-search-oriented). When AQL queries use structured predicates, the translator bypasses `engram.recall()` and queries SQLite directly.

**Decision rule:** If a RECALL query uses ONLY simple filters that map to RecallOptions (context, source, trust, memory type), use `engram.recall()` for RRF fusion. If it uses compound WHERE, comparison operators, ORDER BY, or AGGREGATE, use direct SQLite for deterministic results.

This is a read-only escape hatch — writes always go through Engram's API.

### Compound WHERE

```
RECALL FROM EPISODIC WHERE outcome = "success" AND confidence > 0.8
```

Translated to:
```sql
SELECT * FROM chunks
WHERE memory_type = 'experience' AND is_active = TRUE
  AND json_extract(data_json_or_text, '$.outcome') = 'success'
  AND json_extract(data_json_or_text, '$.confidence') > 0.8
```

**Field resolution for WHERE:** AQL field names are resolved in priority order:
1. Direct column match (e.g., `trust_score`, `source`, `context`, `created_at`) → SQL column
2. JSON field extraction (e.g., `outcome`, `campaign`) → `json_extract(text, '$.field')` since STORE serializes fields as JSON text

**Condition groups with AND/OR:** Translated directly to SQL `AND`/`OR` with parentheses preserving precedence.

**Comparison operators:**

| AQL Op | SQL Op | Example |
|--------|--------|---------|
| `=` | `=` | `WHERE name = "deploy"` |
| `!=`, `<>` | `!=` | `WHERE status != "failed"` |
| `<`, `>`, `<=`, `>=` | same | `WHERE confidence > 0.8` |
| `CONTAINS` | `LIKE '%x%'` | `WHERE text CONTAINS "deploy"` |
| `STARTS_WITH` | `LIKE 'x%'` | `WHERE name STARTS_WITH "k8s"` |
| `ENDS_WITH` | `LIKE '%x'` | `WHERE name ENDS_WITH "_prod"` |
| `IN` | `IN (...)` | `WHERE status IN ["success", "partial"]` |

### ORDER BY

```
RECALL FROM EPISODIC ALL ORDER BY created_at DESC LIMIT 10
```

Translates directly to `ORDER BY created_at DESC LIMIT 10` in SQL. When used with direct SQL path, ordering is deterministic (not RRF-ranked).

### AGGREGATE and HAVING

```
RECALL FROM EPISODIC WHERE domain = "ops"
  AGGREGATE COUNT(*) AS total, AVG(confidence) AS avg_conf
  HAVING avg_conf > 0.7
```

Translated to:
```sql
SELECT COUNT(*) AS total, AVG(json_extract(text, '$.confidence')) AS avg_conf
FROM chunks
WHERE memory_type = 'experience' AND is_active = TRUE
  AND context = 'ops'
HAVING avg_conf > 0.7
```

**Supported aggregate functions:** COUNT, SUM, AVG, MIN, MAX.

AGGREGATE queries always use the direct SQL path (aggregation is inherently structured, not semantic).

## WASM Integration

### Loading Strategy

The `aql-parser` WASM module is loaded once during `Engram.create()` and cached for the lifetime of the instance.

```typescript
// src/aql.ts
import init, { parse } from 'aql-parser-wasm';

let wasmReady = false;

export async function initAqlParser(): Promise<void> {
  if (!wasmReady) {
    await init();
    wasmReady = true;
  }
}

export function parseAql(query: string): Statement {
  const result = parse(query);  // returns JSON string
  return JSON.parse(result);
}
```

### Build Integration

The existing `clawdb-wasm` crate bundles the full in-memory executor — we only need the parser. Two options:

**Option A (recommended): Build aql-parser directly as WASM.**
The `aql-parser` crate is already a standalone library with no async or storage dependencies — it can compile to WASM directly:

```bash
# In aql-engram repo — add a thin WASM wrapper for aql-parser
cd crates/aql-parser
wasm-pack build --target nodejs --out-dir ../../pkg-parser
# produces: pkg-parser/aql_parser.js + .wasm + .d.ts
```

This requires adding `wasm-bindgen` exports to `aql-parser` (or a thin `aql-parser-wasm` crate that wraps it). The existing `clawdb-wasm` crate already demonstrates the pattern — its `parse()` export calls `aql_parser::parse()` and returns JSON.

**Option B: Reuse clawdb-wasm's parse() export.**
The existing WASM build already exports a `parse(query: string): string` function that returns the AST as JSON, independent of the executor. We can use it as-is and ignore the `execute`/`clear`/`stats`/`dump` exports.

```bash
cd crates/clawdb-wasm
wasm-pack build --target nodejs --out-dir ../../pkg-node
```

Option A is cleaner (smaller WASM binary, no dead code), but Option B works immediately with zero changes to the AQL repo.

**Target:** `--target nodejs` (not `--target web`) since Engram runs in Node.js.

### Parser Output Contract

The WASM `parse()` function returns a JSON-serialized AST. The translator works against this JSON structure, not Rust types. The AST shape is defined by `aql-parser`'s `Statement` enum — the TypeScript side needs matching type definitions.

A `types/aql-ast.d.ts` file in Engram mirrors the Rust AST types for type safety. This is generated from the Rust types (or hand-maintained with conformance tests validating the shape).

## MCP Tool

```typescript
{
  name: 'engram_aql',
  description: 'Execute an AQL (Agent Query Language) query against this agent\'s memory. '
    + 'Supports: RECALL, SCAN, LOOKUP, LOAD, STORE, UPDATE, FORGET, LINK, REFLECT, PIPELINE. '
    + 'Example: RECALL FROM SEMANTIC WHERE context = "infrastructure" LIMIT 5 RETURN *',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'AQL query string',
      },
      variables: {
        type: 'object',
        description: 'Optional variables for parameterized queries ({varname} or $varname)',
      },
    },
    required: ['query'],
  },
}
```

## Testing Strategy

### Conformance Tests

The AQL repo ships 150 YAML conformance tests. Phase 1 runs the subset that covers agentic operations against Engram's backend. A test harness:

1. Loads seed data from `tests/fixtures/seed.aql` via `engram.query()` (STORE statements)
2. Executes each test case's query via `engram.query()`
3. Validates against the expected results (success, count, contains, error_contains)

Tests that exercise Phase 2 features (AGGREGATE, complex WHERE) are skipped with a marker.

### Engram-Specific Tests

Additional tests beyond AQL conformance:

- Memory type mapping (AQL EPISODIC → Engram experience, etc.)
- Trust score preservation through STORE → RECALL roundtrip
- LINK creating proper entries in entities/relations tables
- PIPELINE variable passing between stages
- REFLECT triggering actual Engram reflection cycle
- WASM parser initialization and error handling
- MCP tool integration (engram_aql tool accepts string, returns structured result)

### Test Location

```
tests/
├── aql.test.ts                  # Translator unit tests
├── aql-conformance.test.ts      # AQL YAML suite run against Engram
└── aql-mcp.test.ts              # MCP tool integration
```

## File Changes

```
engram/
├── src/
│   ├── aql.ts                   # NEW — translator + query() method
│   ├── aql-types.ts             # NEW — TypeScript AST types matching Rust
│   ├── engram.ts                # MODIFIED — add query() method, init WASM
│   ├── schema.sql               # MODIFIED — add tools table
│   ├── mcp-tools.ts             # MODIFIED — add engram_aql tool
│   └── reflect.ts               # MODIFIED — add reflectOn(chunks) method
├── tests/
│   ├── aql.test.ts              # NEW
│   ├── aql-conformance.test.ts  # NEW
│   └── aql-mcp.test.ts          # NEW
├── package.json                 # MODIFIED — add aql-parser-wasm dependency
└── types/
    └── aql-ast.d.ts             # NEW — generated or hand-maintained AST types
```
