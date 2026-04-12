# engram-aql Rust Binary — Design

**Date:** 2026-04-12
**Status:** Draft (awaiting review)
**Repo:** swift-innovate/engram
**AQL Source:** srirammails/AQL (v0.5)
**Supersedes:** `2026-04-11-aql-engram-integration-design.md`

## Summary

Add AQL (Agent Query Language) support to Engram as a **native Rust binary** that shares the SQLite `.engram` file with the existing TypeScript Engram process. No WASM, no serde format translation, no in-band bridge — the Rust binary uses the `aql-parser` crate as a native dependency and executes queries directly against the shared database.

The TypeScript Engram process continues to own the write pipeline (retain, embedding, extraction queue, reflection). The Rust binary owns the declarative-query surface (RECALL, SCAN, LOOKUP, LOAD, AGGREGATE, ORDER BY, WITH LINKS, FOLLOW LINKS). Both processes can access the same `.engram` file simultaneously via SQLite WAL.

**Phase 1 is read-only.** Write statements (STORE, UPDATE, FORGET, LINK) return an informative error directing the agent to use TypeScript Engram's existing MCP tools. A future Phase 2 can extend the binary with writes once we design around the TS retain pipeline bypass.

## Why This Architecture

The previous design (WASM-bridge, superseded) attempted to load the Rust parser as WASM into Node.js and translate statements through Engram's TypeScript API. Implementation revealed two problems that made that approach infeasible:

1. **Serde format drift.** The Rust AST serialized through serde_json doesn't match idiomatic TypeScript discriminated unions. Building a normalizer would mean maintaining two AST definitions that must stay in lock-step.
2. **LinkStmt semantics mismatch.** The original plan assumed `LINK "id1" TO "id2" TYPE "x"` (record-ID linking). The actual AQL grammar is set-based: `LINK FROM memory WHERE conditions TO memory WHERE conditions TYPE "x"`. The TS translator would have had to re-implement AQL grammar semantics.

Both problems vanish when the Rust binary uses `aql-parser` as a native dependency: it gets strongly-typed Rust AST structures with zero translation, and the grammar semantics are whatever `aql-parser` says they are. The rest is just SQL.

## Goals

1. Agents and humans get a declarative query language for inspecting Engram memory
2. Use the canonical Rust `aql-parser` natively — single source of truth for AQL semantics
3. Preserve the existing TypeScript Engram as-is — no breaking changes for valor-engine, OpenClaw, or other consumers
4. Ship a minimal Phase 1 in ~1 week of focused work
5. Open the door to Phase 2 writes without painting the design into a corner

## Non-Goals

- Rewriting Engram in Rust (TypeScript stays)
- Reproducing Engram's retain/recall pipeline in Rust (the binary is read-only)
- Running Ollama/LLM calls from Rust (REFLECT remains a TypeScript operation)
- Generating embeddings from Rust (no `candle`, no ONNX — query-side only, not write-side)
- Vector similarity search in Phase 1 (`LIKE $var`, `PATTERN $var` — deferred)
- Fighting SQLite's concurrency model (WAL handles multi-process access; we stay within its guarantees)

## Architecture

```
                        ┌────────────────────────────┐
                        │     .engram SQLite file     │
                        │      (WAL mode, shared)     │
                        └───────────┬────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │                               │
                    ▼                               ▼
      ┌──────────────────────────┐   ┌──────────────────────────┐
      │   engram (TypeScript)    │   │   engram-aql (Rust)      │
      │                          │   │                          │
      │   retain → embed →       │   │   parse AQL →            │
      │   store → extract queue  │   │   AST (aql-parser) →     │
      │                          │   │   SQL builder →          │
      │   recall (RRF fusion)    │   │   rusqlite → results     │
      │                          │   │                          │
      │   reflect (Ollama) →     │   │   Read-only Phase 1      │
      │   observations/opinions  │   │                          │
      │                          │   │   Writes → error:        │
      │   MCP: engram_retain,    │   │   "use engram_retain"    │
      │        engram_recall,    │   │                          │
      │        engram_reflect    │   │   MCP: engram_aql        │
      └──────────────────────────┘   └──────────────────────────┘
             OWNS WRITES                   OWNS DECLARATIVE READS
```

### Process Boundary Rules

1. **TypeScript Engram owns writes.** All data enters the `.engram` file via TS retain/supersede/forget or reflect. This preserves the dedup pipeline, embedding generation, extraction queue, FTS5 triggers, and trust layer.
2. **Rust `engram-aql` is read-only in Phase 1.** The Rust process opens the database with SQLite's `SQLITE_OPEN_READ_ONLY` flag where possible, or read-write with a discipline of "only SELECT statements." Phase 1 rejects all write AQL statements at the parser-dispatch level before they can touch the database.
3. **Both processes coexist via WAL.** SQLite WAL mode allows concurrent readers alongside one writer. Multiple readers don't block each other. The Rust reader process will naturally see committed writes from TS (with some small lag for WAL checkpointing).
4. **Schema is read-only contract from TS to Rust.** `engram/src/schema.sql` is the source of truth. Rust reads it at startup to verify expected tables exist, but never modifies it. Schema evolution happens on the TS side and `engram-aql` validates compatibility on open.

## Repository Layout

```
engram/                              # Repo root (polyglot)
├── src/                             # TypeScript source (unchanged)
│   ├── schema.sql                   # Shared schema — read by both TS and Rust
│   ├── engram.ts
│   ├── retain.ts
│   ├── recall.ts
│   ├── reflect.ts
│   ├── mcp-tools.ts                 # Existing MCP tools (unchanged)
│   └── mcp-server.ts                # TS MCP server binary (unchanged)
│
├── engram-aql/                      # NEW: Rust crate
│   ├── Cargo.toml                   # Crate config
│   ├── README.md                    # Rust-side docs
│   ├── src/
│   │   ├── main.rs                  # Binary entrypoint (clap subcommands)
│   │   ├── lib.rs                   # Library API (for embedding in other Rust code)
│   │   ├── executor.rs              # AQL AST → SQL query builder
│   │   ├── memory_map.rs            # AQL memory type → SQLite table mapping
│   │   ├── sql_builder.rs           # Condition → SQL translation
│   │   ├── result.rs                # Result types (QueryResult, AqlLink, etc.)
│   │   ├── schema.rs                # Schema verification on open
│   │   ├── subcommand/
│   │   │   ├── query.rs             # `engram-aql query` — one-shot CLI query
│   │   │   ├── repl.rs              # `engram-aql repl` — interactive prompt
│   │   │   └── mcp.rs               # `engram-aql mcp` — MCP stdio server
│   │   └── error.rs                 # Error types
│   ├── tests/
│   │   ├── common/mod.rs            # Test helpers: seed .engram files
│   │   ├── recall.rs                # RECALL statement integration tests
│   │   ├── lookup.rs                # LOOKUP
│   │   ├── scan.rs                  # SCAN
│   │   ├── load.rs                  # LOAD FROM TOOLS
│   │   ├── aggregate.rs             # AGGREGATE + HAVING
│   │   ├── graph.rs                 # WITH LINKS + FOLLOW LINKS
│   │   ├── write_rejection.rs       # STORE/UPDATE/FORGET/LINK → error
│   │   └── schema_compat.rs         # Schema verification
│   └── fixtures/
│       └── seed.sql                 # Test data inserted via rusqlite
│
├── tests/                           # TypeScript tests (unchanged)
├── docs/
│   └── superpowers/
│       ├── specs/
│       │   ├── 2026-04-11-aql-engram-integration-design.md    # Superseded
│       │   └── 2026-04-12-engram-aql-rust-binary-design.md    # THIS FILE
│       └── plans/
│           └── 2026-04-12-engram-aql-rust-binary.md           # New plan
└── package.json                     # TypeScript side (unchanged)
```

**Note:** The `engram-aql/` directory is a standalone Cargo crate — not a Cargo workspace root. The engram repo doesn't become a Cargo workspace; it just gains a Rust subdirectory. The TypeScript build (`tsc`) ignores the Rust directory entirely, and `cargo` operations run from within `engram-aql/`.

## Cargo Configuration

### `engram-aql/Cargo.toml`

```toml
[package]
name = "engram-aql"
version = "0.1.0"
edition = "2021"
license = "Apache-2.0"
description = "AQL query binary for Engram agent memory files"

[[bin]]
name = "engram-aql"
path = "src/main.rs"

[lib]
name = "engram_aql"
path = "src/lib.rs"

[dependencies]
# AQL parser — native Rust dependency, no WASM
aql-parser = { git = "https://github.com/srirammails/AQL.git", rev = "<pinned-commit-hash>" }

# SQLite access
rusqlite = { version = "0.31", features = ["bundled", "chrono", "serde_json"] }

# CLI + REPL
clap = { version = "4.5", features = ["derive"] }
rustyline = "14"  # REPL line editing

# MCP server
# NOTE: Phase 1 hand-rolls the MCP stdio loop since rmcp is still young.
# Phase 2 can switch to rmcp (https://github.com/anthropic-experimental/rmcp)
# once it stabilizes.
tokio = { version = "1", features = ["macros", "rt-multi-thread", "io-std", "io-util"] }

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Utilities
chrono = { version = "0.4", features = ["serde"] }
anyhow = "1"
thiserror = "1"
tracing = "0.1"
tracing-subscriber = "0.3"

[dev-dependencies]
tempfile = "3"
pretty_assertions = "1"
```

**Pinning note:** The `aql-parser` git dependency pins a specific commit hash. We deliberately don't use `main` because grammar changes could silently break our executor. Phase 2 can revisit pinning strategy (e.g., fork AQL to a swift-innovate branch we control).

## Binary Subcommands

### `engram-aql query <db-path> "<aql-string>"`

One-shot query execution. Parses AQL, runs it, prints JSON to stdout, exits.

```bash
$ engram-aql query ./tracer.engram 'RECALL FROM EPISODIC WHERE context = "ops" ORDER BY created_at DESC LIMIT 5'
{
  "success": true,
  "statement": "Recall",
  "data": [
    {"id": "abc", "text": "...", "trust_score": 0.9, ...},
    ...
  ],
  "count": 5,
  "timing_ms": 12,
  "warnings": null
}
```

Exit code: 0 on success (including empty results), non-zero on parse error or execution error.

**Use case:** Scripts, pipelines, one-off debugging.

### `engram-aql repl <db-path>`

Interactive REPL with line editing, history, and multi-statement support.

```
$ engram-aql repl ./tracer.engram
engram-aql 0.1.0 — read-only mode
Connected to: ./tracer.engram (schema version: 1)

aql> RECALL FROM SEMANTIC ALL LIMIT 3 RETURN id, text, trust_score
┌─────┬──────────────────────────────┬─────────────┐
│ id  │ text                         │ trust_score │
├─────┼──────────────────────────────┼─────────────┤
│ abc │ Tom prefers Terraform        │ 0.90        │
│ def │ Proxmox runs on bare metal   │ 0.85        │
│ ghi │ SQLite WAL mode allows ...   │ 0.80        │
└─────┴──────────────────────────────┴─────────────┘
3 rows · 5ms

aql> AGGREGATE COUNT(*) AS total FROM EPISODIC
┌───────┐
│ total │
├───────┤
│   42  │
└───────┘
1 row · 3ms

aql> \help
...

aql> \quit
```

**Use case:** Humans exploring agent memory. The "SQL for your agent's brain" experience.

REPL commands start with backslash to distinguish from AQL:
- `\help` — show help
- `\schema` — show schema version and table list
- `\stats` — show memory statistics (chunks/entities/relations/observations counts)
- `\quit` — exit

### `engram-aql mcp <db-path>`

Run as an MCP stdio server. Exposes a single tool: `engram_aql`.

```json
{
  "name": "engram_aql",
  "description": "Execute an AQL (Agent Query Language) read query against this agent's memory. Supports: RECALL, SCAN, LOOKUP, LOAD, WITH LINKS, FOLLOW LINKS, AGGREGATE, ORDER BY. Writes (STORE/UPDATE/FORGET/LINK) are not yet supported — use engram_retain instead.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "AQL query string. Example: RECALL FROM EPISODIC WHERE context = \"ops\" ORDER BY created_at DESC LIMIT 5"
      }
    },
    "required": ["query"]
  }
}
```

The MCP server:
1. Reads JSON-RPC requests from stdin
2. Responds on stdout
3. Logs to stderr (tracing-subscriber output)
4. Keeps the SQLite connection open for the lifetime of the process
5. Handles `initialize`, `tools/list`, and `tools/call` methods
6. Returns a structured `CallToolResult` with the JSON query result as a text content block

Agents run `engram-aql mcp /path/to/agent.engram` as a subprocess (same pattern as the existing `engram-mcp` TypeScript server).

## Memory Type Mapping

Unchanged from the superseded spec. Summarized here for completeness:

| AQL Type    | Engram Table        | Engram memory_type value |
|-------------|---------------------|--------------------------|
| EPISODIC    | chunks              | `experience`             |
| SEMANTIC    | chunks              | `world`                  |
| PROCEDURAL  | observations        | (separate table)         |
| WORKING     | working_memory      | (separate table)         |
| TOOLS       | tools (NEW)         | (separate table)         |
| ALL         | chunks + observations + working_memory | all types   |

**Schema additions still required:**
- New `tools` table (id, name, description, api_url, ranking, tags, namespace, scope, is_active, timestamps)

The tools table needs to exist before `engram-aql` can support LOAD FROM TOOLS. This is a TypeScript-side change to `src/schema.sql`. We'll make it as part of the implementation plan even though the Rust binary only reads from it.

## Statement Handling (Phase 1)

### Supported (Read-Only)

| Statement | Translation Strategy | Notes |
|-----------|---------------------|-------|
| **RECALL**  | AQL predicate/modifiers → SQL WHERE/ORDER BY/LIMIT against the appropriate table | Structured, not semantic. No RRF fusion (that's TS). |
| **SCAN**    | SELECT FROM working_memory WHERE expires_at IS NULL ORDER BY updated_at DESC LIMIT N | Direct read, no semantic layer. |
| **LOOKUP**  | AQL KEY predicate → SELECT * WHERE field = ? | Exact-match only. |
| **LOAD**    | SELECT FROM tools WHERE ... ORDER BY ranking DESC LIMIT N | Ranked tool lookup. |
| **WHERE** (compound) | Full SQL WHERE with AND/OR/grouping + all comparison operators | Fields are resolved in priority order: known column → json_extract(text, '$.field') |
| **AGGREGATE** | SQL aggregate functions (COUNT, SUM, AVG, MIN, MAX) with optional HAVING | Pure SQL. |
| **ORDER BY** | SQL ORDER BY clause | Direct column or json_extract path. |
| **LIMIT** | SQL LIMIT | Default cap of 1000 to prevent runaway queries. |
| **RETURN fields** | Post-query field selection | Supports direct columns and json_extract for JSON-stored fields. |
| **WITH LINKS** | JOIN through chunk_entities → relations to attach link metadata | Attaches to results without expanding row count. |
| **FOLLOW LINKS** | Recursive CTE on relations table, bounded by DEPTH | Returns expanded result set. |
| **WINDOW** | LAST N → LIMIT, LAST duration → WHERE created_at > ?, TOP N BY field → ORDER BY field LIMIT N, SINCE condition → WHERE | All map to SQL clauses. |
| **NAMESPACE / SCOPE** | Accepted syntactically, emits warning in result | Engram schema doesn't have these columns today. Phase 2 can add them. |
| **MIN_CONFIDENCE** | Maps to `trust_score >= ?` | Engram's trust_score is the nearest equivalent. |
| **TIMEOUT** | Phase 1: no-op with warning | Phase 2: sqlite_interrupt hook + async deadline. |

### Rejected at Parser Dispatch (Write Operations)

| Statement | Phase 1 Behavior |
|-----------|------------------|
| **STORE**  | Error: "STORE not supported in engram-aql read-only mode. Use engram_retain via TypeScript MCP server." |
| **UPDATE** | Error: "UPDATE not supported. Use engram_supersede." |
| **FORGET** | Error: "FORGET not supported. Use engram_forget." |
| **LINK**   | Error: "LINK not supported. Tool for this is planned for Phase 2." |
| **REFLECT** | Error: "REFLECT requires LLM access. Use engram_reflect via TypeScript MCP server." |
| **PIPELINE** with any of the above | Error at first write-statement stage. |
| **PIPELINE** with read-only stages | Supported — sequential execution, result passing between stages. |

The rejection happens at the dispatch layer (after parsing, before SQL generation), so all queries still get full syntactic validation. The error message includes a pointer to the TypeScript MCP tool the agent should use instead.

## QueryResult Structure

Rust `QueryResult` serialized to JSON for MCP / CLI / REPL consumption:

```rust
#[derive(Serialize)]
pub struct QueryResult {
    pub success: bool,
    pub statement: String,              // "Recall", "Scan", etc. (from Statement variant name)
    pub data: Vec<serde_json::Value>,   // Result rows
    pub count: usize,
    pub timing_ms: u64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub links: Option<Vec<AqlLink>>,    // Populated by WITH LINKS

    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline_stages: Option<usize>, // Populated by PIPELINE
}

#[derive(Serialize)]
pub struct AqlLink {
    pub source_id: String,
    pub target_id: String,
    pub link_type: String,
    pub confidence: f64,
}
```

Field visibility in JSON output is controlled by `serde(skip_serializing_if)` so simple queries produce clean output without empty/null noise.

## Schema Verification

On every startup, `engram-aql` verifies the database schema is compatible with what it expects. This prevents silent failures from schema drift.

```rust
// Embed schema.sql at compile time from engram/src/schema.sql
const EXPECTED_SCHEMA: &str = include_str!("../../src/schema.sql");

pub fn verify_schema(conn: &Connection) -> Result<(), SchemaError> {
    // Required tables for Phase 1
    let required_tables = [
        "chunks",
        "entities",
        "relations",
        "chunk_entities",
        "opinions",
        "observations",
        "working_memory",
        "tools",        // New in this work
        "bank_config",
    ];

    for table in required_tables {
        let exists: bool = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |row| row.get::<_, i64>(0).map(|n| n > 0),
        )?;
        if !exists {
            return Err(SchemaError::MissingTable(table.to_string()));
        }
    }

    // Required columns on chunks (catches old .engram files)
    let required_chunk_cols = ["id", "text", "memory_type", "trust_score", "is_active"];
    for col in required_chunk_cols {
        if !column_exists(conn, "chunks", col)? {
            return Err(SchemaError::MissingColumn("chunks".into(), col.into()));
        }
    }

    Ok(())
}
```

If the `.engram` file is missing a table, `engram-aql` exits with a clear error:

```
error: database at ./tracer.engram is missing required table 'tools'
hint: this may be an older .engram file. Run TypeScript Engram once to upgrade the schema:
      npx engram-mcp ./tracer.engram --upgrade
```

The schema file is embedded via `include_str!`, which means `cargo build` fails if `engram/src/schema.sql` is missing — the Rust binary can't exist without the schema contract.

## SQL Builder Patterns

The translator pattern from the superseded spec carries over — this is the core reusable logic. Key design:

### Field Resolution

When an AQL query references a field like `outcome`, we need to decide where to look:

1. **Direct column on target table:** `trust_score`, `source`, `context`, `created_at`, etc. — use directly
2. **JSON field extraction:** `outcome`, `event`, `campaign`, etc. — stored inside the chunk's `text` column as JSON, use `json_extract(text, '$.outcome')`

```rust
fn resolve_field(field: &str, table: Table) -> FieldRef {
    let known_cols = match table {
        Table::Chunks => CHUNK_COLUMNS,
        Table::Tools => TOOL_COLUMNS,
        Table::Observations => OBSERVATION_COLUMNS,
        Table::WorkingMemory => WORKING_MEMORY_COLUMNS,
    };

    if known_cols.contains(field) {
        FieldRef::Column(field.to_string())
    } else {
        // JSON extraction from the text (chunks) or data_json (observations/working_memory)
        let json_col = match table {
            Table::Chunks => "text",
            Table::Observations => "data_json",
            Table::WorkingMemory => "data_json",
            Table::Tools => "tags", // tools don't have a JSON bag; fallback
        };
        FieldRef::JsonPath(json_col.to_string(), format!("$.{}", field))
    }
}
```

### Condition Translation

The Rust `Condition` enum is untagged serde (that's fine — we're in Rust, not JSON). Translation to SQL:

```rust
fn condition_to_sql(
    cond: &Condition,
    table: Table,
    params: &mut Vec<rusqlite::types::Value>,
) -> String {
    match cond {
        Condition::Simple { field, operator, value, logical_op: _ } => {
            let field_sql = resolve_field(field, table).to_sql();
            let val = value_to_rusqlite(value);
            match operator {
                Operator::Eq  => { params.push(val); format!("{} = ?", field_sql) }
                Operator::Ne  => { params.push(val); format!("{} != ?", field_sql) }
                Operator::Gt  => { params.push(val); format!("{} > ?", field_sql) }
                Operator::Gte => { params.push(val); format!("{} >= ?", field_sql) }
                Operator::Lt  => { params.push(val); format!("{} < ?", field_sql) }
                Operator::Lte => { params.push(val); format!("{} <= ?", field_sql) }
                Operator::Contains => {
                    // Wrap with % for LIKE
                    let Value::String(s) = value else { /* error */ };
                    params.push(format!("%{}%", s).into());
                    format!("{} LIKE ?", field_sql)
                }
                Operator::StartsWith => { /* similar */ }
                Operator::EndsWith => { /* similar */ }
                Operator::In => {
                    let Value::Array(items) = value else { /* error */ };
                    let placeholders: Vec<&str> = (0..items.len()).map(|_| "?").collect();
                    for item in items {
                        params.push(value_to_rusqlite(item));
                    }
                    format!("{} IN ({})", field_sql, placeholders.join(", "))
                }
            }
        }
        Condition::Group { conditions, logical_op } => {
            // Group conditions are joined by the logical_op of EACH SUBSEQUENT CONDITION,
            // not the group's own logical_op.
            // This matches aql-parser's semantics: condition.logical_op is how THIS condition
            // joins to the PREVIOUS condition in the sibling list.
            let parts: Vec<String> = conditions.iter().enumerate().map(|(i, c)| {
                let sql = condition_to_sql(c, table, params);
                if i == 0 {
                    sql
                } else {
                    let op = c.logical_op().unwrap_or(LogicalOp::And);
                    format!("{} {}", op.as_sql(), sql)
                }
            }).collect();
            format!("({})", parts.join(" "))
        }
    }
}
```

**Semantic note:** The aql-parser `Condition` carries `logical_op: Option<LogicalOp>` on each condition, representing how it joins to its left sibling. The first condition in a list has `logical_op = None`; subsequent ones have `Some(And)` or `Some(Or)`. Our SQL builder must respect this or it will produce wrong WHERE clauses.

### WITH LINKS / FOLLOW LINKS

**WITH LINKS** performs a post-query JOIN to attach link metadata without expanding rows:

```sql
-- Base query runs normally
SELECT * FROM chunks WHERE ...;

-- Then for each result row, look up related entities
SELECT r.source_entity_id, r.target_entity_id, r.relation_type, r.confidence
FROM relations r
JOIN chunk_entities ce1 ON (ce1.entity_id = r.source_entity_id OR ce1.entity_id = r.target_entity_id)
WHERE ce1.chunk_id IN (<result_ids>) AND r.is_active = TRUE;
```

Results populate `QueryResult.links`.

**FOLLOW LINKS** uses a recursive CTE bounded by DEPTH:

```sql
WITH RECURSIVE graph_walk(entity_id, depth) AS (
    -- Seed from the query result entities
    SELECT entity_id, 0 FROM chunk_entities WHERE chunk_id IN (<result_ids>)
    UNION
    SELECT r.target_entity_id, g.depth + 1
    FROM relations r
    JOIN graph_walk g ON r.source_entity_id = g.entity_id
    WHERE r.relation_type = ?1 AND r.is_active = TRUE AND g.depth < ?2
)
SELECT DISTINCT c.*
FROM chunks c
JOIN chunk_entities ce ON c.id = ce.chunk_id
WHERE ce.entity_id IN (SELECT entity_id FROM graph_walk WHERE depth > 0)
  AND c.is_active = TRUE;
```

The `INTO <memory_type>` clause from AQL determines which table the target chunks come from (chunks vs observations).

## Testing Strategy

### Integration Tests

Tests operate against real SQLite databases created from the shared schema:

```rust
// engram-aql/tests/common/mod.rs
pub fn new_test_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(include_str!("../../../src/schema.sql")).unwrap();
    conn
}

pub fn seed_chunks(conn: &Connection) {
    conn.execute_batch(include_str!("../fixtures/seed.sql")).unwrap();
}
```

Every test creates a fresh in-memory database, seeds deterministic test data, runs AQL queries, and asserts on the structured results.

### Test Categories

1. **RECALL translation tests** — All predicate/modifier combinations
2. **LOOKUP tests** — Key-based exact match
3. **SCAN tests** — Working memory window semantics
4. **LOAD tests** — Tools table queries with ranking
5. **AGGREGATE tests** — COUNT/SUM/AVG/MIN/MAX + HAVING
6. **ORDER BY tests** — Direct columns and JSON paths
7. **Graph tests** — WITH LINKS and FOLLOW LINKS with recursive CTE
8. **Compound WHERE tests** — AND/OR, grouping, precedence
9. **Comparison operator tests** — All 11 operators (including CONTAINS, IN, etc.)
10. **Write rejection tests** — Every write statement returns the right error
11. **Schema verification tests** — Missing table / missing column cases
12. **CLI tests** — `engram-aql query` with representative queries
13. **MCP server tests** — stdio JSON-RPC round-trip

### Shared Fixture Compatibility

Where possible, test fixtures should match the seed data in the AQL repo's conformance suite (`aql/tests/fixtures/seed.aql`) so we can eventually run AQL's 150-case conformance suite against our executor. Phase 1 doesn't require conformance — but staying fixture-compatible makes it easy to add later.

## MCP Server Implementation

Phase 1 hand-rolls the MCP stdio loop rather than depending on `rmcp` (which is still maturing). The MCP protocol is simple JSON-RPC over stdin/stdout:

```rust
// Minimum viable MCP server
async fn run_mcp_server(db_path: &Path) -> Result<()> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    verify_schema(&conn)?;

    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut stdout = tokio::io::stdout();
    let mut line = String::new();

    loop {
        line.clear();
        let n = stdin.read_line(&mut line).await?;
        if n == 0 { break; }  // EOF

        let req: JsonRpcRequest = serde_json::from_str(&line)?;
        let resp = match req.method.as_str() {
            "initialize" => handle_initialize(req),
            "tools/list" => handle_tools_list(req),
            "tools/call" => handle_tool_call(req, &conn).await,
            "notifications/initialized" => continue, // notification, no response
            _ => method_not_found(req),
        };

        let line = serde_json::to_string(&resp)? + "\n";
        stdout.write_all(line.as_bytes()).await?;
        stdout.flush().await?;
    }
    Ok(())
}
```

Tracing output goes to stderr so it doesn't interleave with JSON-RPC. Agents (Claude Code, Cursor, etc.) configure it the same way they configure `engram-mcp`:

```json
{
  "mcpServers": {
    "engram-aql": {
      "command": "engram-aql",
      "args": ["mcp", "./tracer.engram"]
    }
  }
}
```

Phase 2 can migrate to `rmcp` once it stabilizes, without changing the MCP tool surface.

## Deployment

### Installation

Phase 1 distribution options:

1. **`cargo install --path engram-aql`** — developer install from the engram repo
2. **Pre-built binaries via GitHub Releases** — one binary per (linux-x64, linux-arm64, macos-arm64, windows-x64) platform, attached to `engram vX.Y.Z` release tags
3. **Homebrew formula / apt package** — Phase 2, once there are external users

For the initial rollout (valor-engine, OpenClaw, Tom's personal use), cargo install is sufficient.

### Versioning

The Rust binary version tracks the engram repo version. A `v0.1.0` engram release ships both TypeScript and Rust artifacts together. They must use compatible schemas — the Rust binary's `include_str!` ensures any schema change on the TS side triggers a Rust recompile and potentially a version bump.

## Open Questions (Phase 2 Scope)

These are deliberately out of scope for Phase 1, noted here so we don't lose track:

1. **Writes.** How to support STORE/UPDATE/FORGET/LINK without duplicating the TS retain pipeline. Options include: (a) Rust calls TS via IPC, (b) Rust writes directly and skips embedding/extraction, (c) move retain pipeline to Rust. Needs its own brainstorm.
2. **Vector search.** LIKE / PATTERN predicates. Requires loading `sqlite-vec` into Rust and either accepting pre-computed vectors (easier) or embedding query strings in-process via `candle` (harder).
3. **REFLECT trigger.** The Rust binary could dispatch to TS via IPC or an HTTP callback to trigger a reflection cycle. Deferred until write support is figured out — they're related problems.
4. **Timeout enforcement.** AQL's `TIMEOUT` modifier. SQLite supports query interruption via `sqlite3_interrupt`; rusqlite wraps this as `Connection::interrupt`. Pair with a tokio deadline.
5. **Conformance suite.** Running AQL's 150-case conformance tests against `engram-aql`. Requires test fixture compatibility (see Testing Strategy above) and adapting the conformance harness for Rust integration tests.
6. **Cross-process transaction semantics.** If Rust starts a read transaction while TS is writing, WAL provides snapshot isolation — but we should document the read-consistency guarantees explicitly.
7. **Column additions for SCOPE/NAMESPACE/TTL.** If Phase 2 confirms these are agentic, they get added to `chunks` and `src/schema.sql`, and Rust picks them up on the next rebuild.

## Effort Estimate

Phase 1 as scoped here: **~5-7 focused working days**

- Cargo crate setup + AQL parser wiring: 0.5 day
- Schema verification + memory type mapping: 0.5 day
- RECALL/LOOKUP/SCAN/LOAD executors: 1.5 days
- AGGREGATE/ORDER BY/GROUP: 0.5 day
- WITH LINKS / FOLLOW LINKS graph traversal: 1 day
- PIPELINE sequential execution: 0.5 day
- Write rejection layer: 0.5 day
- CLI subcommand (query): 0.5 day
- REPL subcommand with rustyline: 1 day
- MCP stdio server: 1 day
- Test suite (above categories): 1.5 days
- Docs + README + schema.sql tools table addition: 0.5 day

Rough total: ~9 days of work, compressed if there's parallelization across tasks.
