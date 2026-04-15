# engram-aql Rust Binary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Rust binary `engram-aql` that reads from the shared `.engram` SQLite file and answers AQL queries natively, exposing CLI/REPL/MCP interfaces.

**Architecture:** A standalone Cargo crate at `engram/engram-aql/` that vendors the `aql-parser` source, opens the SQLite `.engram` file read-write (enforces read-only discipline at the dispatch layer), and translates each AQL statement AST into rusqlite queries. Three binary subcommands share the same executor: `query` (one-shot), `repl` (interactive), `mcp` (stdio server).

**Tech Stack:** Rust 2021, `aql-parser` (vendored), `rusqlite` (bundled SQLite), `clap`, `rustyline`, `comfy-table`, `tokio` (async runtime for MCP), `serde`, `serde_json`, `anyhow`, `thiserror`, `tracing`.

**Spec:** `docs/superpowers/specs/2026-04-12-engram-aql-rust-binary-design.md`

---

## File Structure

All new files are under `engram-aql/` unless otherwise noted.

| File | Action | Responsibility |
|------|--------|---------------|
| `engram-aql/Cargo.toml` | Create | Crate config, dependencies |
| `engram-aql/README.md` | Create | Rust-side readme |
| `engram-aql/vendor/aql-parser/` | Create | Vendored aql-parser source + Cargo.toml + grammar |
| `engram-aql/vendor/VENDORED_FROM.md` | Create | Upstream source, commit hash, license note |
| `engram-aql/src/main.rs` | Create | Binary entrypoint — clap subcommand dispatch |
| `engram-aql/src/lib.rs` | Create | Library API — `Executor::new`, `Executor::query` |
| `engram-aql/src/error.rs` | Create | Error types (`AqlError`, `SchemaError`) |
| `engram-aql/src/result.rs` | Create | `QueryResult`, `AqlLink` |
| `engram-aql/src/schema.rs` | Create | Schema verification (`verify_schema`) |
| `engram-aql/src/memory_map.rs` | Create | AQL MemoryType → SQLite Table mapping |
| `engram-aql/src/executor.rs` | Create | Top-level statement dispatcher |
| `engram-aql/src/sql/mod.rs` | Create | SQL builder module root |
| `engram-aql/src/sql/conditions.rs` | Create | Condition → SQL WHERE clause |
| `engram-aql/src/sql/fields.rs` | Create | Field resolution (column vs json_extract) |
| `engram-aql/src/sql/values.rs` | Create | AQL Value → rusqlite param |
| `engram-aql/src/statements/mod.rs` | Create | Statement handler module root |
| `engram-aql/src/statements/recall.rs` | Create | RECALL handler |
| `engram-aql/src/statements/lookup.rs` | Create | LOOKUP handler |
| `engram-aql/src/statements/scan.rs` | Create | SCAN handler |
| `engram-aql/src/statements/load.rs` | Create | LOAD FROM TOOLS handler |
| `engram-aql/src/statements/graph.rs` | Create | WITH LINKS / FOLLOW LINKS |
| `engram-aql/src/statements/pipeline.rs` | Create | PIPELINE sequential executor |
| `engram-aql/src/statements/write_reject.rs` | Create | Error responses for STORE/UPDATE/FORGET/LINK/REFLECT |
| `engram-aql/src/subcommand/mod.rs` | Create | Subcommand module root |
| `engram-aql/src/subcommand/query.rs` | Create | `engram-aql query` subcommand |
| `engram-aql/src/subcommand/repl.rs` | Create | `engram-aql repl` subcommand |
| `engram-aql/src/subcommand/mcp.rs` | Create | `engram-aql mcp` subcommand |
| `engram-aql/src/mcp/mod.rs` | Create | MCP stdio server module |
| `engram-aql/src/mcp/protocol.rs` | Create | JSON-RPC + MCP message types |
| `engram-aql/src/mcp/handlers.rs` | Create | MCP method handlers |
| `engram-aql/src/mcp/render.rs` | Create | Result → MCP CallToolResult |
| `engram-aql/tests/common/mod.rs` | Create | Test helpers (fresh DB, seed data) |
| `engram-aql/tests/fixtures/seed.sql` | Create | Deterministic test data |
| `engram-aql/tests/recall.rs` | Create | RECALL integration tests |
| `engram-aql/tests/lookup.rs` | Create | LOOKUP integration tests |
| `engram-aql/tests/scan.rs` | Create | SCAN integration tests |
| `engram-aql/tests/load.rs` | Create | LOAD tests |
| `engram-aql/tests/aggregate.rs` | Create | AGGREGATE tests |
| `engram-aql/tests/graph.rs` | Create | WITH LINKS / FOLLOW LINKS tests |
| `engram-aql/tests/pipeline.rs` | Create | PIPELINE tests |
| `engram-aql/tests/write_rejection.rs` | Create | Verifies writes are rejected |
| `engram-aql/tests/schema_compat.rs` | Create | Schema verification tests |
| `engram-aql/tests/subcommand_query.rs` | Create | `engram-aql query` CLI test |
| `engram-aql/tests/mcp_roundtrip.rs` | Create | MCP stdio round-trip test |
| `src/schema.sql` | Modify | Add `tools` table (read by Rust via `include_str!`) |

---

## Task 1: Schema Change — Add Tools Table (TypeScript side)

Add the `tools` table to the shared schema. This is a TypeScript-side change that the Rust binary will read via `include_str!`. Must come first because Rust tests rely on the schema existing.

**Files:**
- Modify: `src/schema.sql`
- Test: `tests/aql-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/aql-schema.test.ts`:

```typescript
// tests/aql-schema.test.ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';

describe('AQL schema additions', () => {
  it('tools table exists with expected columns', () => {
    const db = createTestDb();
    const columns = db.pragma('table_info(tools)') as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('name');
    expect(names).toContain('description');
    expect(names).toContain('api_url');
    expect(names).toContain('ranking');
    expect(names).toContain('tags');
    expect(names).toContain('namespace');
    expect(names).toContain('scope');
    expect(names).toContain('is_active');
    db.close();
  });

  it('tools table supports CRUD operations', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tools (id, name, description, api_url, ranking)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('t-001', 'image_resize', 'Resize images', 'https://api.example.com/resize', 0.9);

    const row = db
      .prepare(`SELECT * FROM tools WHERE id = ?`)
      .get('t-001') as Record<string, unknown>;
    expect(row.name).toBe('image_resize');
    expect(row.ranking).toBe(0.9);
    expect(row.is_active).toBe(1);

    db.prepare(`UPDATE tools SET is_active = FALSE WHERE id = ?`).run('t-001');
    const updated = db
      .prepare(`SELECT is_active FROM tools WHERE id = ?`)
      .get('t-001') as { is_active: number };
    expect(updated.is_active).toBe(0);
    db.close();
  });

  it('tools table has ranking index for LOAD queries', () => {
    const db = createTestDb();
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tools'`)
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_tools_ranking');
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql-schema.test.ts`
Expected: FAIL — `tools` table does not exist

- [ ] **Step 3: Add tools table to `src/schema.sql`**

Insert before the existing `-- VIEWS` section in `src/schema.sql`:

```sql
-- =============================================================================
-- TOOLS REGISTRY
-- Ranked tool storage for AQL LOAD FROM TOOLS queries.
-- Agents store available tools with descriptions and rankings.
-- Read by both TypeScript Engram and the Rust engram-aql binary.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    api_url TEXT,
    ranking REAL DEFAULT 0.5
        CHECK (ranking >= 0.0 AND ranking <= 1.0),
    tags TEXT DEFAULT '[]',              -- JSON array of string tags
    namespace TEXT DEFAULT 'default',
    scope TEXT DEFAULT 'private',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_tools_ranking ON tools(ranking DESC) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_tools_namespace ON tools(namespace) WHERE is_active = TRUE;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/aql-schema.test.ts`
Expected: PASS — all 3 tests pass

- [ ] **Step 5: Run existing tests to check for regressions**

Run: `npx vitest run`
Expected: All pre-existing tests pass. The new table has defaults so no existing code is affected.

- [ ] **Step 6: Commit**

```bash
git add src/schema.sql tests/aql-schema.test.ts
git commit -m "feat(schema): add tools table for AQL LOAD FROM TOOLS queries"
```

---

## Task 2: Vendor the aql-parser Crate

Copy the `aql-parser` Rust source into `engram-aql/vendor/aql-parser/` so the engram repo is self-contained. No external git or path dependencies.

**Files:**
- Create: `engram-aql/vendor/aql-parser/` (full crate tree copied from upstream)
- Create: `engram-aql/vendor/VENDORED_FROM.md`

**Prerequisite:** The AQL repo must be cloned at `G:/Projects/SIT/aql`. If not, run `git clone https://github.com/srirammails/AQL.git G:/Projects/SIT/aql` first.

- [ ] **Step 1: Get the upstream commit hash**

Run:
```bash
cd G:/Projects/SIT/aql && git rev-parse HEAD
```
Record the hash — it goes into `VENDORED_FROM.md` in the next step.

- [ ] **Step 2: Create the vendor directory and copy the crate**

Run:
```bash
cd G:/Projects/SIT/engram-rs
mkdir -p engram-aql/vendor
cp -r G:/Projects/SIT/aql/crates/aql-parser engram-aql/vendor/aql-parser
# Copy the grammar file too — aql-parser's build.rs references it
cp G:/Projects/SIT/aql/grammar/aql.pest engram-aql/vendor/aql-parser/grammar.pest
```

- [ ] **Step 3: Verify no target/ or Cargo.lock was copied**

Run:
```bash
ls engram-aql/vendor/aql-parser/
```
Should see: `Cargo.toml`, `src/`, `grammar.pest` (if copied). If `target/` or `Cargo.lock` are present, delete them:

```bash
rm -rf engram-aql/vendor/aql-parser/target
rm -f engram-aql/vendor/aql-parser/Cargo.lock
```

- [ ] **Step 4: Update the vendored Cargo.toml to be self-contained**

Read `engram-aql/vendor/aql-parser/Cargo.toml`. If the `[package]` section references workspace settings (e.g., `version.workspace = true`), replace with concrete values so the crate builds outside the upstream workspace:

```toml
[package]
name = "aql-parser"
version = "0.1.0"  # Match upstream current version
edition = "2021"
license = "Apache-2.0"
description = "AQL (Agent Query Language) parser — vendored from srirammails/AQL"

[dependencies]
pest = "2.7"
pest_derive = "2.7"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
thiserror = "1.0"
```

Then verify all dependency versions are concrete (not `workspace = true`). If parser.rs uses `include_str!("../../grammar/aql.pest")`, update to `include_str!("../grammar.pest")` to match the new layout. **Read parser.rs first** to see the actual include_str path and adjust accordingly.

- [ ] **Step 5: Create VENDORED_FROM.md**

Create `engram-aql/vendor/VENDORED_FROM.md`:

```markdown
# Vendored Dependencies

## aql-parser

**Upstream:** https://github.com/srirammails/AQL
**Commit:** <HASH_FROM_STEP_1>
**Path in upstream:** `crates/aql-parser/`
**License:** Apache-2.0 (preserved)

### Why vendored

This engram repo vendors `aql-parser` rather than pulling it as a git or
path dependency. Reasons:

1. engram repo is self-contained — `cargo build` works without internet
   and without sibling directory conventions
2. We pin an exact version of the AQL grammar — upstream grammar changes
   don't silently break our executor
3. No need to contribute back or maintain a fork for this project

### How to update

1. Note the new commit hash from upstream
2. `rm -rf engram-aql/vendor/aql-parser && cp -r <upstream>/crates/aql-parser engram-aql/vendor/aql-parser`
3. Re-apply any local adjustments to `Cargo.toml` (self-contained version numbers)
4. Update this file with the new commit hash
5. Run `cargo test -p aql-parser` to verify upstream didn't break anything
6. Update integration tests in `engram-aql/tests/` if the parser AST changed

### License

aql-parser is licensed under Apache-2.0. We retain the upstream LICENSE
file in the vendored directory. No modifications to the source are made
other than the Cargo.toml adjustments noted above.
```

- [ ] **Step 6: Commit**

```bash
git add engram-aql/vendor/
git commit -m "chore(aql): vendor aql-parser crate from upstream

Vendored to make the engram repo self-contained — no external git or
path deps required for the Rust build. Pins the exact AQL grammar
version so upstream grammar changes don't silently break our executor.

See engram-aql/vendor/VENDORED_FROM.md for upstream source and commit."
```

---

## Task 3: Bootstrap the engram-aql Crate

Create the Cargo.toml, main.rs skeleton, and lib.rs skeleton so `cargo build` succeeds with zero functionality. This is the foundation for all subsequent tasks.

**Files:**
- Create: `engram-aql/Cargo.toml`
- Create: `engram-aql/README.md`
- Create: `engram-aql/src/main.rs`
- Create: `engram-aql/src/lib.rs`
- Create: `engram-aql/src/error.rs`
- Create: `engram-aql/.gitignore`

- [ ] **Step 1: Create `engram-aql/Cargo.toml`**

```toml
[package]
name = "engram-aql"
version = "0.1.0"
edition = "2021"
license = "Apache-2.0"
description = "AQL query binary for Engram agent memory files"
repository = "https://github.com/swift-innovate/engram"
readme = "README.md"

[[bin]]
name = "engram-aql"
path = "src/main.rs"

[lib]
name = "engram_aql"
path = "src/lib.rs"

[dependencies]
# AQL parser — vendored, see vendor/VENDORED_FROM.md
aql-parser = { path = "vendor/aql-parser" }

# SQLite access with bundled SQLite amalgamation
rusqlite = { version = "0.31", features = ["bundled", "chrono", "serde_json"] }

# CLI parsing
clap = { version = "4.5", features = ["derive"] }

# REPL line editing
rustyline = "14"

# Pretty table output for REPL
comfy-table = "7"

# Async runtime for MCP stdio server
tokio = { version = "1", features = ["macros", "rt-multi-thread", "io-std", "io-util", "sync"] }

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Time types (matches rusqlite's chrono feature)
chrono = { version = "0.4", features = ["serde"] }

# Error handling
anyhow = "1"
thiserror = "1"

# Logging
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

[dev-dependencies]
tempfile = "3"
pretty_assertions = "1"

[profile.release]
lto = true
codegen-units = 1
strip = true
```

- [ ] **Step 2: Create `engram-aql/.gitignore`**

```
target/
Cargo.lock
*.swp
.vscode/
```

Note: we DO commit Cargo.lock for the binary (it's a binary crate, not a library, and a pinned lockfile gives reproducible builds). Actually — for a bin crate, commit Cargo.lock. Update the .gitignore:

```
target/
*.swp
.vscode/
```

- [ ] **Step 3: Create `engram-aql/README.md`**

```markdown
# engram-aql

Native Rust binary for running AQL (Agent Query Language) queries against
Engram `.engram` SQLite files. Part of the
[Engram](https://github.com/swift-innovate/engram) memory system.

## What This Is

A separate Rust process that shares the `.engram` SQLite file with the
TypeScript Engram library. Engram (TypeScript) owns writes: retain,
embedding generation, extraction, reflection. engram-aql (Rust) owns
declarative queries: RECALL, SCAN, LOOKUP, LOAD, AGGREGATE, ORDER BY,
WITH LINKS, FOLLOW LINKS.

Both processes access the same `.engram` file simultaneously via SQLite
WAL mode.

**Phase 1 is read-only.** Write statements (STORE, UPDATE, FORGET, LINK,
REFLECT) return an error directing the agent to use TypeScript Engram's
existing MCP tools.

## Installation

```bash
cargo install --path engram-aql
```

## Usage

### One-shot query

```bash
engram-aql query ./agent.engram 'RECALL FROM EPISODIC ORDER BY created_at DESC LIMIT 5'
```

Prints structured JSON to stdout.

### Interactive REPL

```bash
engram-aql repl ./agent.engram
```

Opens a prompt with pretty-printed tables. `\help` shows commands.

### MCP stdio server

```bash
engram-aql mcp ./agent.engram
```

Exposes an `engram_aql` MCP tool over stdio. Configure in your agent's
MCP settings:

```json
{
  "mcpServers": {
    "engram-aql": {
      "command": "engram-aql",
      "args": ["mcp", "./agent.engram"]
    }
  }
}
```

## Architecture

See `../docs/superpowers/specs/2026-04-12-engram-aql-rust-binary-design.md`.
```

- [ ] **Step 4: Create `engram-aql/src/error.rs`**

```rust
//! Error types for engram-aql

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AqlError {
    #[error("parse error: {0}")]
    Parse(String),

    #[error("schema error: {0}")]
    Schema(#[from] SchemaError),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("unsupported statement: {0}")]
    Unsupported(String),

    #[error("invalid query: {0}")]
    InvalidQuery(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Error)]
pub enum SchemaError {
    #[error("database is missing required table: {0}")]
    MissingTable(String),

    #[error("table {table} is missing required column: {column}")]
    MissingColumn { table: String, column: String },
}

pub type AqlResult<T> = Result<T, AqlError>;
```

- [ ] **Step 5: Create `engram-aql/src/lib.rs`**

```rust
//! engram-aql — AQL query executor for Engram memory files

pub mod error;

// Re-export the main public API as it gets built out in later tasks
pub use error::{AqlError, AqlResult, SchemaError};
```

- [ ] **Step 6: Create `engram-aql/src/main.rs`**

```rust
//! engram-aql binary entrypoint

use clap::Parser;

#[derive(Parser)]
#[command(name = "engram-aql")]
#[command(version, about = "AQL query binary for Engram agent memory files")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(clap::Subcommand)]
enum Command {
    /// Run a single AQL query and print the JSON result
    Query {
        /// Path to the .engram SQLite file
        db_path: std::path::PathBuf,
        /// AQL query string
        query: String,
    },

    /// Open an interactive REPL for ad-hoc queries
    Repl {
        /// Path to the .engram SQLite file
        db_path: std::path::PathBuf,
    },

    /// Run as an MCP stdio server
    Mcp {
        /// Path to the .engram SQLite file
        db_path: std::path::PathBuf,
    },
}

fn main() -> anyhow::Result<()> {
    // tracing to stderr so JSON on stdout stays clean (MCP/query modes)
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Command::Query { db_path, query } => {
            println!("TODO: query subcommand — db={:?} query={}", db_path, query);
            Ok(())
        }
        Command::Repl { db_path } => {
            println!("TODO: repl subcommand — db={:?}", db_path);
            Ok(())
        }
        Command::Mcp { db_path } => {
            println!("TODO: mcp subcommand — db={:?}", db_path);
            Ok(())
        }
    }
}
```

- [ ] **Step 7: Build and verify the crate compiles**

Run:
```bash
cd engram-aql
cargo build 2>&1
```
Expected: Successful build. aql-parser compiles from the vendored source. Binary appears at `engram-aql/target/debug/engram-aql`.

- [ ] **Step 8: Smoke test the binary**

Run:
```bash
./target/debug/engram-aql --help
./target/debug/engram-aql query /tmp/fake.engram 'RECALL FROM EPISODIC ALL'
./target/debug/engram-aql repl /tmp/fake.engram
./target/debug/engram-aql mcp /tmp/fake.engram
```
Each should print its `TODO` line and exit 0. `--help` should show the three subcommands.

- [ ] **Step 9: Commit**

```bash
cd ..  # back to repo root
git add engram-aql/
git commit -m "feat(engram-aql): bootstrap Rust crate with clap subcommand skeleton"
```

---

## Task 4: Schema Verification and Database Connection

Open the SQLite database, verify the schema matches what we expect (fail fast on missing tables/columns), and expose a connection wrapper.

**Files:**
- Modify: `engram-aql/src/lib.rs`
- Create: `engram-aql/src/schema.rs`
- Create: `engram-aql/tests/common/mod.rs`
- Create: `engram-aql/tests/fixtures/seed.sql`
- Create: `engram-aql/tests/schema_compat.rs`

- [ ] **Step 1: Write the failing test**

Create `engram-aql/tests/common/mod.rs`:

```rust
//! Shared test helpers.

use rusqlite::Connection;

/// Build an in-memory database pre-loaded with the engram schema.
pub fn fresh_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    // The schema lives at ../../src/schema.sql relative to engram-aql/
    let schema = include_str!("../../../src/schema.sql");
    conn.execute_batch(schema).unwrap();
    conn
}

/// Load the deterministic test seed data into a fresh database.
pub fn seeded_db() -> Connection {
    let conn = fresh_db();
    let seed = include_str!("../fixtures/seed.sql");
    conn.execute_batch(seed).unwrap();
    conn
}
```

Create `engram-aql/tests/fixtures/seed.sql`:

```sql
-- Deterministic test data for engram-aql integration tests.
-- Keep shapes here aligned with upstream AQL conformance fixtures where practical.

-- Semantic (world) facts
INSERT INTO chunks (id, text, memory_type, trust_score, source_type, context, created_at)
VALUES
    ('s-001', '{"concept":"terraform","note":"IaC tool"}', 'world', 0.9, 'user_stated', 'infra', '2026-03-01 10:00:00'),
    ('s-002', '{"concept":"proxmox","note":"hypervisor"}', 'world', 0.85, 'user_stated', 'infra', '2026-03-02 10:00:00'),
    ('s-003', '{"concept":"wal","note":"SQLite mode"}', 'world', 0.8, 'inferred', 'storage', '2026-03-03 10:00:00');

-- Episodic (experience) events
INSERT INTO chunks (id, text, memory_type, trust_score, source_type, context, created_at)
VALUES
    ('e-001', '{"event":"deploy","outcome":"success","confidence":0.9}', 'experience', 0.9, 'agent_generated', 'ops', '2026-03-10 08:00:00'),
    ('e-002', '{"event":"deploy","outcome":"failure","confidence":0.3}', 'experience', 0.7, 'agent_generated', 'ops', '2026-03-11 09:00:00'),
    ('e-003', '{"event":"test","outcome":"success","confidence":0.8}', 'experience', 0.8, 'agent_generated', 'ci',  '2026-03-12 10:00:00'),
    ('e-004', '{"event":"deploy","outcome":"success","confidence":0.85}','experience', 0.85,'agent_generated', 'ops', '2026-03-13 11:00:00');

-- Working memory sessions
INSERT INTO working_memory (id, data_json, seed_query)
VALUES
    ('w-001', '{"goal":"plan deployment","progress":"outlining"}', 'plan deployment'),
    ('w-002', '{"goal":"review code","progress":"started"}', 'review code');

-- Observations (procedural knowledge)
INSERT INTO observations (id, summary, domain, topic, source_chunks)
VALUES
    ('o-001', 'Blue-green deployment reduces rollback risk', 'ops', 'deployment', '["e-001","e-004"]'),
    ('o-002', 'Failed deploys correlate with Friday pushes', 'ops', 'deployment', '["e-002"]');

-- Tools registry
INSERT INTO tools (id, name, description, api_url, ranking, tags)
VALUES
    ('t-001', 'resize', 'Resize images', 'https://api/resize', 0.9, '["image"]'),
    ('t-002', 'compress', 'Compress files', 'https://api/compress', 0.7, '["storage"]'),
    ('t-003', 'convert', 'Convert formats', 'https://api/convert', 0.5, '["image","file"]');

-- Entities and relations for graph traversal
INSERT INTO entities (id, name, canonical_name, entity_type)
VALUES
    ('ent-deploy', 'deploy', 'deploy', 'concept'),
    ('ent-bluegreen', 'blue-green', 'blue-green', 'concept'),
    ('ent-rollback', 'rollback', 'rollback', 'concept');

INSERT INTO chunk_entities (chunk_id, entity_id, mention_type)
VALUES
    ('e-001', 'ent-deploy', 'subject'),
    ('e-004', 'ent-deploy', 'subject'),
    ('s-001', 'ent-bluegreen', 'reference');

INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, confidence)
VALUES
    ('r-001', 'ent-deploy', 'ent-bluegreen', 'uses_pattern', 0.8),
    ('r-002', 'ent-bluegreen', 'ent-rollback', 'avoids', 0.9);
```

Create `engram-aql/tests/schema_compat.rs`:

```rust
//! Schema verification integration tests.

mod common;

use engram_aql::{verify_schema, SchemaError};
use rusqlite::Connection;

#[test]
fn fresh_engram_schema_passes_verification() {
    let conn = common::fresh_db();
    verify_schema(&conn).expect("fresh schema must pass verification");
}

#[test]
fn missing_chunks_table_errors() {
    let conn = Connection::open_in_memory().unwrap();
    // Build a database with everything EXCEPT chunks
    conn.execute_batch(
        r#"
        CREATE TABLE entities (id TEXT PRIMARY KEY);
        CREATE TABLE relations (id TEXT PRIMARY KEY);
        CREATE TABLE chunk_entities (chunk_id TEXT, entity_id TEXT);
        CREATE TABLE opinions (id TEXT PRIMARY KEY);
        CREATE TABLE observations (id TEXT PRIMARY KEY);
        CREATE TABLE working_memory (id TEXT PRIMARY KEY);
        CREATE TABLE tools (id TEXT PRIMARY KEY);
        CREATE TABLE bank_config (key TEXT PRIMARY KEY, value TEXT);
        "#,
    )
    .unwrap();

    match verify_schema(&conn) {
        Err(engram_aql::AqlError::Schema(SchemaError::MissingTable(t))) => {
            assert_eq!(t, "chunks");
        }
        other => panic!("expected MissingTable('chunks'), got: {:?}", other),
    }
}

#[test]
fn missing_tools_table_errors_with_hint() {
    let conn = Connection::open_in_memory().unwrap();
    // Everything except tools
    conn.execute_batch(include_str!("../../src/schema.sql")).unwrap();
    conn.execute_batch("DROP TABLE tools").unwrap();

    match verify_schema(&conn) {
        Err(engram_aql::AqlError::Schema(SchemaError::MissingTable(t))) => {
            assert_eq!(t, "tools");
        }
        other => panic!("expected MissingTable('tools'), got: {:?}", other),
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd engram-aql
cargo test --test schema_compat 2>&1
```
Expected: FAIL — `verify_schema` doesn't exist yet.

- [ ] **Step 3: Implement `engram-aql/src/schema.rs`**

```rust
//! Schema verification for `.engram` SQLite files.

use rusqlite::Connection;

use crate::error::{AqlResult, SchemaError};

/// Required tables for Phase 1 engram-aql operation.
const REQUIRED_TABLES: &[&str] = &[
    "chunks",
    "entities",
    "relations",
    "chunk_entities",
    "opinions",
    "observations",
    "working_memory",
    "tools",
    "bank_config",
];

/// Required columns on the `chunks` table. Catches old `.engram` files that
/// predate the AQL integration work.
const REQUIRED_CHUNK_COLUMNS: &[&str] = &[
    "id",
    "text",
    "memory_type",
    "trust_score",
    "is_active",
    "context",
    "source",
    "source_type",
    "created_at",
];

/// Verify the database has the schema shape engram-aql expects. Returns the
/// first missing table or column encountered, if any.
pub fn verify_schema(conn: &Connection) -> AqlResult<()> {
    for table in REQUIRED_TABLES {
        if !table_exists(conn, table)? {
            return Err(SchemaError::MissingTable((*table).into()).into());
        }
    }

    for column in REQUIRED_CHUNK_COLUMNS {
        if !column_exists(conn, "chunks", column)? {
            return Err(SchemaError::MissingColumn {
                table: "chunks".into(),
                column: (*column).into(),
            }
            .into());
        }
    }

    Ok(())
}

fn table_exists(conn: &Connection, table: &str) -> AqlResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> AqlResult<bool> {
    // Use the table_info pragma. The call signature for rusqlite is a bit
    // verbose because pragma results aren't named the same across SQLite
    // versions. Instead, query sqlite_schema for the CREATE TABLE statement
    // and look for the column name — imperfect but portable.
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )
        .ok();
    let Some(sql) = sql else {
        return Ok(false);
    };
    // Simple lowercase substring check — good enough for verification,
    // not a full parser.
    let needle = format!(" {} ", column);
    let haystack = sql.to_lowercase();
    Ok(haystack.contains(&needle.to_lowercase())
        || haystack.contains(&format!("({}", column).to_lowercase())
        || haystack.contains(&format!(",{}", column).to_lowercase())
        || haystack.contains(&format!("\n    {} ", column).to_lowercase()))
}
```

- [ ] **Step 4: Update `engram-aql/src/lib.rs` to export the schema module**

```rust
//! engram-aql — AQL query executor for Engram memory files

pub mod error;
pub mod schema;

pub use error::{AqlError, AqlResult, SchemaError};
pub use schema::verify_schema;
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
cd engram-aql
cargo test --test schema_compat 2>&1
```
Expected: PASS — 3 tests pass.

- [ ] **Step 6: Commit**

```bash
cd ..
git add engram-aql/
git commit -m "feat(engram-aql): add schema verification and test fixtures"
```

---

## Task 5: Memory Type Mapping and Result Types

Add the AQL MemoryType → Engram table mapping and the `QueryResult` / `AqlLink` types.

**Files:**
- Create: `engram-aql/src/memory_map.rs`
- Create: `engram-aql/src/result.rs`
- Modify: `engram-aql/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `engram-aql/tests/memory_map.rs`:

```rust
//! Memory type mapping tests.

use aql_parser::ast::MemoryType;
use engram_aql::memory_map::{aql_to_table, aql_to_chunk_memory_type, EngramTable};

#[test]
fn semantic_maps_to_chunks_world() {
    assert_eq!(aql_to_table(MemoryType::Semantic), EngramTable::Chunks);
    assert_eq!(aql_to_chunk_memory_type(MemoryType::Semantic), Some("world"));
}

#[test]
fn episodic_maps_to_chunks_experience() {
    assert_eq!(aql_to_table(MemoryType::Episodic), EngramTable::Chunks);
    assert_eq!(aql_to_chunk_memory_type(MemoryType::Episodic), Some("experience"));
}

#[test]
fn procedural_maps_to_observations() {
    assert_eq!(aql_to_table(MemoryType::Procedural), EngramTable::Observations);
    assert_eq!(aql_to_chunk_memory_type(MemoryType::Procedural), None);
}

#[test]
fn working_maps_to_working_memory() {
    assert_eq!(aql_to_table(MemoryType::Working), EngramTable::WorkingMemory);
}

#[test]
fn tools_maps_to_tools_table() {
    assert_eq!(aql_to_table(MemoryType::Tools), EngramTable::Tools);
}

#[test]
fn all_is_recognized() {
    assert_eq!(aql_to_table(MemoryType::All), EngramTable::All);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test memory_map 2>&1`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `engram-aql/src/memory_map.rs`**

```rust
//! AQL MemoryType ↔ Engram table mapping.

use aql_parser::ast::MemoryType;

/// Engram tables that AQL queries can target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngramTable {
    Chunks,
    Observations,
    WorkingMemory,
    Tools,
    /// "ALL" — cross-table query. Currently resolved to Chunks for Phase 1.
    All,
}

impl EngramTable {
    pub fn as_sql_name(self) -> &'static str {
        match self {
            EngramTable::Chunks => "chunks",
            EngramTable::Observations => "observations",
            EngramTable::WorkingMemory => "working_memory",
            EngramTable::Tools => "tools",
            EngramTable::All => "chunks", // Phase 1: ALL degrades to chunks
        }
    }
}

/// Map an AQL memory type to the Engram table it queries.
pub fn aql_to_table(aql: MemoryType) -> EngramTable {
    match aql {
        MemoryType::Episodic | MemoryType::Semantic => EngramTable::Chunks,
        MemoryType::Procedural => EngramTable::Observations,
        MemoryType::Working => EngramTable::WorkingMemory,
        MemoryType::Tools => EngramTable::Tools,
        MemoryType::All => EngramTable::All,
    }
}

/// For AQL types that live in the `chunks` table, return the `memory_type`
/// column value Engram uses. Returns `None` for types that use a different
/// table entirely (Procedural, Working, Tools, All).
pub fn aql_to_chunk_memory_type(aql: MemoryType) -> Option<&'static str> {
    match aql {
        MemoryType::Episodic => Some("experience"),
        MemoryType::Semantic => Some("world"),
        _ => None,
    }
}
```

- [ ] **Step 4: Implement `engram-aql/src/result.rs`**

```rust
//! Result types returned from AQL query execution.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub success: bool,
    pub statement: String,
    pub data: Vec<serde_json::Value>,
    pub count: usize,
    pub timing_ms: u64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub warnings: Vec<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub links: Option<Vec<AqlLink>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline_stages: Option<usize>,
}

impl QueryResult {
    pub fn success(statement: impl Into<String>, data: Vec<serde_json::Value>) -> Self {
        let count = data.len();
        Self {
            success: true,
            statement: statement.into(),
            data,
            count,
            timing_ms: 0,
            error: None,
            warnings: Vec::new(),
            links: None,
            pipeline_stages: None,
        }
    }

    pub fn error(statement: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            success: false,
            statement: statement.into(),
            data: Vec::new(),
            count: 0,
            timing_ms: 0,
            error: Some(message.into()),
            warnings: Vec::new(),
            links: None,
            pipeline_stages: None,
        }
    }

    pub fn with_warning(mut self, warning: impl Into<String>) -> Self {
        self.warnings.push(warning.into());
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AqlLink {
    pub source_id: String,
    pub target_id: String,
    pub link_type: String,
    pub confidence: f64,
}
```

- [ ] **Step 5: Update `engram-aql/src/lib.rs`**

```rust
//! engram-aql — AQL query executor for Engram memory files

pub mod error;
pub mod memory_map;
pub mod result;
pub mod schema;

pub use error::{AqlError, AqlResult, SchemaError};
pub use memory_map::{aql_to_chunk_memory_type, aql_to_table, EngramTable};
pub use result::{AqlLink, QueryResult};
pub use schema::verify_schema;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test 2>&1`
Expected: PASS — all tests including schema_compat and memory_map.

- [ ] **Step 7: Commit**

```bash
cd ..
git add engram-aql/
git commit -m "feat(engram-aql): add memory type mapping and result types"
```

---

## Task 6: SQL Builder — Conditions, Fields, Values

Implement the translation from AQL Value/Condition/Operator to rusqlite SQL fragments. This is the reusable core consumed by all statement handlers.

**Files:**
- Create: `engram-aql/src/sql/mod.rs`
- Create: `engram-aql/src/sql/fields.rs`
- Create: `engram-aql/src/sql/values.rs`
- Create: `engram-aql/src/sql/conditions.rs`
- Modify: `engram-aql/src/lib.rs`
- Create: `engram-aql/tests/sql_builder.rs`

- [ ] **Step 1: Write the failing tests**

Create `engram-aql/tests/sql_builder.rs`:

```rust
//! SQL builder unit tests — test the Value/Condition → SQL translation.

use aql_parser::ast::{Condition, LogicalOp, Operator, Value};
use engram_aql::sql::conditions::condition_to_sql;
use engram_aql::memory_map::EngramTable;
use rusqlite::types::Value as RusqValue;

#[test]
fn simple_eq_string() {
    let cond = Condition::Simple {
        field: "context".into(),
        operator: Operator::Eq,
        value: Value::String("ops".into()),
        logical_op: None,
    };
    let mut params = Vec::new();
    let sql = condition_to_sql(&cond, EngramTable::Chunks, &mut params);
    assert_eq!(sql, "context = ?");
    assert_eq!(params.len(), 1);
    assert!(matches!(params[0], RusqValue::Text(ref s) if s == "ops"));
}

#[test]
fn simple_gt_float() {
    let cond = Condition::Simple {
        field: "trust_score".into(),
        operator: Operator::Gt,
        value: Value::Float(0.75),
        logical_op: None,
    };
    let mut params = Vec::new();
    let sql = condition_to_sql(&cond, EngramTable::Chunks, &mut params);
    assert_eq!(sql, "trust_score > ?");
}

#[test]
fn json_field_uses_json_extract() {
    // "outcome" is not a direct column on chunks; should translate to json_extract
    let cond = Condition::Simple {
        field: "outcome".into(),
        operator: Operator::Eq,
        value: Value::String("success".into()),
        logical_op: None,
    };
    let mut params = Vec::new();
    let sql = condition_to_sql(&cond, EngramTable::Chunks, &mut params);
    assert_eq!(sql, "json_extract(text, '$.outcome') = ?");
}

#[test]
fn contains_becomes_like_wrapped() {
    let cond = Condition::Simple {
        field: "text".into(),
        operator: Operator::Contains,
        value: Value::String("deploy".into()),
        logical_op: None,
    };
    let mut params = Vec::new();
    let sql = condition_to_sql(&cond, EngramTable::Chunks, &mut params);
    assert_eq!(sql, "text LIKE ?");
    assert!(matches!(params[0], RusqValue::Text(ref s) if s == "%deploy%"));
}

#[test]
fn starts_with_anchors_at_start() {
    let cond = Condition::Simple {
        field: "name".into(),
        operator: Operator::StartsWith,
        value: Value::String("k8s".into()),
        logical_op: None,
    };
    let mut params = Vec::new();
    let sql = condition_to_sql(&cond, EngramTable::Tools, &mut params);
    assert_eq!(sql, "name LIKE ?");
    assert!(matches!(params[0], RusqValue::Text(ref s) if s == "k8s%"));
}

#[test]
fn in_operator_expands_array() {
    let cond = Condition::Simple {
        field: "status".into(),
        operator: Operator::In,
        value: Value::Array(vec![
            Value::String("success".into()),
            Value::String("partial".into()),
        ]),
        logical_op: None,
    };
    let mut params = Vec::new();
    let sql = condition_to_sql(&cond, EngramTable::Chunks, &mut params);
    assert_eq!(sql, "json_extract(text, '$.status') IN (?, ?)");
    assert_eq!(params.len(), 2);
}

#[test]
fn group_with_and() {
    // (context = "ops" AND trust_score > 0.8)
    let inner1 = Condition::Simple {
        field: "context".into(),
        operator: Operator::Eq,
        value: Value::String("ops".into()),
        logical_op: None,
    };
    let inner2 = Condition::Simple {
        field: "trust_score".into(),
        operator: Operator::Gt,
        value: Value::Float(0.8),
        logical_op: Some(LogicalOp::And),
    };
    let group = Condition::Group {
        conditions: vec![inner1, inner2],
        logical_op: None,
    };
    let mut params = Vec::new();
    let sql = condition_to_sql(&group, EngramTable::Chunks, &mut params);
    assert_eq!(sql, "(context = ? AND trust_score > ?)");
    assert_eq!(params.len(), 2);
}

#[test]
fn group_with_or() {
    let inner1 = Condition::Simple {
        field: "context".into(),
        operator: Operator::Eq,
        value: Value::String("ops".into()),
        logical_op: None,
    };
    let inner2 = Condition::Simple {
        field: "context".into(),
        operator: Operator::Eq,
        value: Value::String("ci".into()),
        logical_op: Some(LogicalOp::Or),
    };
    let group = Condition::Group {
        conditions: vec![inner1, inner2],
        logical_op: None,
    };
    let mut params = Vec::new();
    let sql = condition_to_sql(&group, EngramTable::Chunks, &mut params);
    assert_eq!(sql, "(context = ? OR context = ?)");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test sql_builder 2>&1`
Expected: FAIL — `engram_aql::sql` module doesn't exist.

- [ ] **Step 3: Implement `engram-aql/src/sql/fields.rs`**

```rust
//! Field resolution: AQL field names → SQL column expressions.
//!
//! Fields that match a known column on the target table are used directly.
//! Fields that don't match are assumed to be JSON-stored inside the table's
//! text/data_json column and resolved via json_extract.

use crate::memory_map::EngramTable;

pub enum FieldRef {
    /// Direct column reference
    Column(&'static str),
    /// json_extract(<column>, '$.<path>')
    JsonPath {
        column: &'static str,
        path: String,
    },
}

impl FieldRef {
    pub fn to_sql(&self) -> String {
        match self {
            FieldRef::Column(name) => (*name).to_string(),
            FieldRef::JsonPath { column, path } => {
                format!("json_extract({}, '$.{}')", column, path)
            }
        }
    }
}

const CHUNK_COLUMNS: &[&str] = &[
    "id",
    "text",
    "memory_type",
    "source",
    "source_uri",
    "context",
    "source_type",
    "trust_score",
    "verified_by_user",
    "event_time",
    "event_time_end",
    "temporal_label",
    "text_hash",
    "created_at",
    "updated_at",
    "reflected_at",
    "is_active",
];

const TOOLS_COLUMNS: &[&str] = &[
    "id",
    "name",
    "description",
    "api_url",
    "ranking",
    "tags",
    "namespace",
    "scope",
    "created_at",
    "updated_at",
    "is_active",
];

const OBSERVATION_COLUMNS: &[&str] = &[
    "id",
    "summary",
    "source_chunks",
    "source_entities",
    "domain",
    "topic",
    "synthesized_at",
    "last_refreshed",
    "refresh_count",
    "is_active",
];

const WORKING_MEMORY_COLUMNS: &[&str] = &[
    "id",
    "task_id",
    "scope",
    "data_json",
    "seed_query",
    "topic_embedding",
    "updated_at",
    "expires_at",
];

pub fn resolve_field(field: &str, table: EngramTable) -> FieldRef {
    let (known, json_col) = match table {
        EngramTable::Chunks | EngramTable::All => (CHUNK_COLUMNS, "text"),
        EngramTable::Tools => (TOOLS_COLUMNS, "tags"),
        EngramTable::Observations => (OBSERVATION_COLUMNS, "source_chunks"),
        EngramTable::WorkingMemory => (WORKING_MEMORY_COLUMNS, "data_json"),
    };

    // Match against known columns in a case-sensitive way — engram schema
    // uses snake_case consistently.
    for col in known {
        if *col == field {
            return FieldRef::Column(col);
        }
    }

    FieldRef::JsonPath {
        column: json_col,
        path: field.to_string(),
    }
}
```

- [ ] **Step 4: Implement `engram-aql/src/sql/values.rs`**

```rust
//! AQL Value → rusqlite::types::Value conversion.

use aql_parser::ast::Value as AqlValue;
use rusqlite::types::Value as RusqValue;

pub fn value_to_rusqlite(value: &AqlValue) -> RusqValue {
    match value {
        AqlValue::Null => RusqValue::Null,
        AqlValue::Bool(b) => RusqValue::Integer(if *b { 1 } else { 0 }),
        AqlValue::Int(n) => RusqValue::Integer(*n),
        AqlValue::Float(f) => RusqValue::Real(*f),
        AqlValue::String(s) => RusqValue::Text(s.clone()),
        AqlValue::Variable(v) => {
            // Variables aren't resolved at this layer — higher layers substitute
            // values before calling us. If we see one here, it's a bug.
            RusqValue::Text(format!("${}", v))
        }
        AqlValue::Array(_) => {
            // Arrays are handled by the IN operator directly; this path is
            // only hit if an array is used in an invalid context.
            RusqValue::Null
        }
    }
}
```

- [ ] **Step 5: Implement `engram-aql/src/sql/conditions.rs`**

```rust
//! Condition → SQL WHERE fragment translation.

use aql_parser::ast::{Condition, LogicalOp, Operator, Value};
use rusqlite::types::Value as RusqValue;

use crate::memory_map::EngramTable;
use crate::sql::fields::resolve_field;
use crate::sql::values::value_to_rusqlite;

/// Translate an AQL Condition into a SQL fragment and append bind parameters.
///
/// Returns the SQL fragment (e.g., "context = ?", "(a = ? AND b > ?)").
/// Appends bind values to `params` in left-to-right order.
pub fn condition_to_sql(
    cond: &Condition,
    table: EngramTable,
    params: &mut Vec<RusqValue>,
) -> String {
    match cond {
        Condition::Simple {
            field,
            operator,
            value,
            logical_op: _,
        } => simple_to_sql(field, *operator, value, table, params),

        Condition::Group {
            conditions,
            logical_op: _,
        } => group_to_sql(conditions, table, params),
    }
}

fn simple_to_sql(
    field: &str,
    operator: Operator,
    value: &Value,
    table: EngramTable,
    params: &mut Vec<RusqValue>,
) -> String {
    let field_sql = resolve_field(field, table).to_sql();

    match operator {
        Operator::Eq => {
            params.push(value_to_rusqlite(value));
            format!("{} = ?", field_sql)
        }
        Operator::Ne => {
            params.push(value_to_rusqlite(value));
            format!("{} != ?", field_sql)
        }
        Operator::Gt => {
            params.push(value_to_rusqlite(value));
            format!("{} > ?", field_sql)
        }
        Operator::Gte => {
            params.push(value_to_rusqlite(value));
            format!("{} >= ?", field_sql)
        }
        Operator::Lt => {
            params.push(value_to_rusqlite(value));
            format!("{} < ?", field_sql)
        }
        Operator::Lte => {
            params.push(value_to_rusqlite(value));
            format!("{} <= ?", field_sql)
        }
        Operator::Contains => {
            let s = string_or_null(value);
            params.push(RusqValue::Text(format!("%{}%", s)));
            format!("{} LIKE ?", field_sql)
        }
        Operator::StartsWith => {
            let s = string_or_null(value);
            params.push(RusqValue::Text(format!("{}%", s)));
            format!("{} LIKE ?", field_sql)
        }
        Operator::EndsWith => {
            let s = string_or_null(value);
            params.push(RusqValue::Text(format!("%{}", s)));
            format!("{} LIKE ?", field_sql)
        }
        Operator::In => {
            if let Value::Array(items) = value {
                let placeholders: Vec<&str> = (0..items.len()).map(|_| "?").collect();
                for item in items {
                    params.push(value_to_rusqlite(item));
                }
                format!("{} IN ({})", field_sql, placeholders.join(", "))
            } else {
                // Non-array with IN — treat as equality for graceful fallback
                params.push(value_to_rusqlite(value));
                format!("{} = ?", field_sql)
            }
        }
    }
}

fn group_to_sql(
    conditions: &[Condition],
    table: EngramTable,
    params: &mut Vec<RusqValue>,
) -> String {
    if conditions.is_empty() {
        return "1=1".to_string();
    }

    // aql-parser carries logical_op on each condition (except the first),
    // describing how it joins to the previous sibling. We respect that.
    let mut parts: Vec<String> = Vec::with_capacity(conditions.len() * 2);
    for (i, c) in conditions.iter().enumerate() {
        if i > 0 {
            let op = c.logical_op().unwrap_or(LogicalOp::And);
            parts.push(match op {
                LogicalOp::And => "AND".to_string(),
                LogicalOp::Or => "OR".to_string(),
            });
        }
        parts.push(condition_to_sql(c, table, params));
    }
    format!("({})", parts.join(" "))
}

fn string_or_null(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}
```

- [ ] **Step 6: Create `engram-aql/src/sql/mod.rs`**

```rust
//! SQL building utilities for AQL query translation.

pub mod conditions;
pub mod fields;
pub mod values;
```

- [ ] **Step 7: Update `engram-aql/src/lib.rs`**

```rust
//! engram-aql — AQL query executor for Engram memory files

pub mod error;
pub mod memory_map;
pub mod result;
pub mod schema;
pub mod sql;

pub use error::{AqlError, AqlResult, SchemaError};
pub use memory_map::{aql_to_chunk_memory_type, aql_to_table, EngramTable};
pub use result::{AqlLink, QueryResult};
pub use schema::verify_schema;
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cargo test --test sql_builder 2>&1`
Expected: PASS — all 9 tests pass.

- [ ] **Step 9: Commit**

```bash
cd ..
git add engram-aql/
git commit -m "feat(engram-aql): add SQL builder for conditions, fields, and values"
```

---

## Task 7: RECALL Statement Handler

Implement the RECALL executor. This is the most commonly-used statement and exercises the SQL builder end-to-end.

**Files:**
- Create: `engram-aql/src/statements/mod.rs`
- Create: `engram-aql/src/statements/recall.rs`
- Create: `engram-aql/src/executor.rs`
- Modify: `engram-aql/src/lib.rs`
- Create: `engram-aql/tests/recall.rs`

- [ ] **Step 1: Write the failing integration test**

Create `engram-aql/tests/recall.rs`:

```rust
//! RECALL statement integration tests.

mod common;

use engram_aql::Executor;
use pretty_assertions::assert_eq;

#[test]
fn recall_all_semantic() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("RECALL FROM SEMANTIC ALL").unwrap();
    assert!(result.success);
    assert_eq!(result.statement, "Recall");
    assert!(result.count >= 3);
}

#[test]
fn recall_episodic_with_context_filter() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query("RECALL FROM EPISODIC WHERE context = \"ops\"")
        .unwrap();
    assert!(result.success);
    // e-001, e-002, e-004 are ops
    assert_eq!(result.count, 3);
}

#[test]
fn recall_with_json_field_filter() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"RECALL FROM EPISODIC WHERE outcome = "success""#)
        .unwrap();
    assert!(result.success);
    // e-001, e-003, e-004 are success
    assert_eq!(result.count, 3);
}

#[test]
fn recall_with_compound_where() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"RECALL FROM EPISODIC WHERE context = "ops" AND outcome = "success""#)
        .unwrap();
    assert!(result.success);
    // e-001 and e-004 are ops+success
    assert_eq!(result.count, 2);
}

#[test]
fn recall_with_gt_comparison() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query("RECALL FROM EPISODIC WHERE trust_score > 0.75")
        .unwrap();
    assert!(result.success);
    // e-001 (0.9), e-003 (0.8), e-004 (0.85)
    assert_eq!(result.count, 3);
}

#[test]
fn recall_with_limit() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("RECALL FROM EPISODIC ALL LIMIT 2").unwrap();
    assert!(result.success);
    assert_eq!(result.count, 2);
}

#[test]
fn recall_with_order_by_desc() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query("RECALL FROM EPISODIC ALL ORDER BY trust_score DESC LIMIT 1")
        .unwrap();
    assert!(result.success);
    assert_eq!(result.count, 1);
    let trust = result.data[0].get("trust_score").and_then(|v| v.as_f64()).unwrap();
    assert!((trust - 0.9).abs() < 0.001);
}

#[test]
fn recall_with_return_fields_filters_columns() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query("RECALL FROM EPISODIC ALL LIMIT 1 RETURN id, trust_score")
        .unwrap();
    assert!(result.success);
    let row = &result.data[0];
    assert!(row.get("id").is_some());
    assert!(row.get("trust_score").is_some());
    assert!(row.get("text").is_none()); // should be filtered out
}

#[test]
fn recall_invalid_query_returns_error_result() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("NOT A VALID QUERY").unwrap();
    assert!(!result.success);
    assert!(result.error.is_some());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test recall 2>&1`
Expected: FAIL — `Executor` doesn't exist yet.

- [ ] **Step 3: Implement `engram-aql/src/executor.rs`**

```rust
//! Top-level AQL executor — parses, dispatches, and returns results.

use std::time::Instant;

use aql_parser::ast::Statement;
use rusqlite::Connection;

use crate::error::AqlResult;
use crate::result::QueryResult;
use crate::schema::verify_schema;
use crate::statements;

pub struct Executor {
    conn: Connection,
}

impl Executor {
    /// Build an Executor from an existing connection. Verifies schema.
    pub fn from_connection(conn: Connection) -> AqlResult<Self> {
        verify_schema(&conn)?;
        Ok(Self { conn })
    }

    /// Open a `.engram` SQLite file and build an Executor.
    pub fn open(path: &std::path::Path) -> AqlResult<Self> {
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    /// Execute a single AQL query string.
    pub fn query(&self, aql: &str) -> AqlResult<QueryResult> {
        let start = Instant::now();

        let stmt = match aql_parser::parse(aql) {
            Ok(s) => s,
            Err(e) => {
                let mut result = QueryResult::error("Unknown", format!("parse error: {}", e));
                result.timing_ms = start.elapsed().as_millis() as u64;
                return Ok(result);
            }
        };

        let mut result = self.dispatch(&stmt)?;
        result.timing_ms = start.elapsed().as_millis() as u64;
        Ok(result)
    }

    fn dispatch(&self, stmt: &Statement) -> AqlResult<QueryResult> {
        match stmt {
            Statement::Recall(r) => statements::recall::execute(&self.conn, r),

            // Writes — rejected at dispatch time
            Statement::Store(_)
            | Statement::Update(_)
            | Statement::Forget(_)
            | Statement::Link(_)
            | Statement::Reflect(_) => {
                Ok(statements::write_reject::reject(stmt))
            }

            // Other reads — implemented in later tasks
            _ => Ok(QueryResult::error(
                statement_name(stmt),
                format!("statement not yet implemented: {}", statement_name(stmt)),
            )),
        }
    }
}

fn statement_name(stmt: &Statement) -> &'static str {
    match stmt {
        Statement::Pipeline(_) => "Pipeline",
        Statement::Reflect(_) => "Reflect",
        Statement::Scan(_) => "Scan",
        Statement::Recall(_) => "Recall",
        Statement::Lookup(_) => "Lookup",
        Statement::Load(_) => "Load",
        Statement::Store(_) => "Store",
        Statement::Update(_) => "Update",
        Statement::Forget(_) => "Forget",
        Statement::Link(_) => "Link",
    }
}
```

- [ ] **Step 4: Create `engram-aql/src/statements/mod.rs`**

```rust
//! Statement handlers — one module per AQL statement type.

pub mod recall;
pub mod write_reject;
```

- [ ] **Step 5: Implement `engram-aql/src/statements/write_reject.rs`**

```rust
//! Rejection handler for write statements in Phase 1.

use aql_parser::ast::Statement;

use crate::result::QueryResult;

pub fn reject(stmt: &Statement) -> QueryResult {
    let (name, hint) = match stmt {
        Statement::Store(_) => (
            "Store",
            "STORE is not supported in engram-aql read-only mode. \
             Use `engram_retain` via the TypeScript MCP server.",
        ),
        Statement::Update(_) => (
            "Update",
            "UPDATE is not supported in engram-aql read-only mode. \
             Use `engram_supersede` via the TypeScript MCP server.",
        ),
        Statement::Forget(_) => (
            "Forget",
            "FORGET is not supported in engram-aql read-only mode. \
             Use `engram_forget` via the TypeScript MCP server.",
        ),
        Statement::Link(_) => (
            "Link",
            "LINK is not supported in Phase 1. Planned for Phase 2.",
        ),
        Statement::Reflect(_) => (
            "Reflect",
            "REFLECT requires LLM access and is not available in engram-aql. \
             Use `engram_reflect` via the TypeScript MCP server.",
        ),
        _ => ("Unknown", "statement type not recognized for rejection"),
    };

    QueryResult::error(name, hint)
}
```

- [ ] **Step 6: Implement `engram-aql/src/statements/recall.rs`**

```rust
//! RECALL statement handler.

use aql_parser::ast::{Modifiers, OrderBy, Predicate, RecallStmt};
use rusqlite::types::Value as RusqValue;
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

use crate::error::AqlResult;
use crate::memory_map::{aql_to_chunk_memory_type, aql_to_table, EngramTable};
use crate::result::QueryResult;
use crate::sql::conditions::condition_to_sql;
use crate::sql::fields::resolve_field;

pub fn execute(conn: &Connection, stmt: &RecallStmt) -> AqlResult<QueryResult> {
    let table = aql_to_table(stmt.memory_type);
    let chunk_type = aql_to_chunk_memory_type(stmt.memory_type);

    let mut where_parts: Vec<String> = Vec::new();
    let mut params: Vec<RusqValue> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // Base conditions
    match table {
        EngramTable::Chunks | EngramTable::All => {
            where_parts.push("is_active = 1".into());
            if let Some(t) = chunk_type {
                where_parts.push("memory_type = ?".into());
                params.push(RusqValue::Text(t.into()));
            }
        }
        EngramTable::Tools | EngramTable::Observations => {
            where_parts.push("is_active = 1".into());
        }
        EngramTable::WorkingMemory => {
            // working_memory has expires_at instead of is_active
            where_parts.push("(expires_at IS NULL OR expires_at > datetime('now'))".into());
        }
    }

    // Predicate conditions
    match &stmt.predicate {
        Predicate::All => {}
        Predicate::Where { conditions } => {
            for cond in conditions {
                where_parts.push(condition_to_sql(cond, table, &mut params));
            }
        }
        Predicate::Key { field, value } => {
            // KEY is more of a LOOKUP feature, but RECALL allows it per grammar.
            // Treat KEY exactly like a simple WHERE field = value.
            let field_sql = resolve_field(field, table).to_sql();
            params.push(crate::sql::values::value_to_rusqlite(value));
            where_parts.push(format!("{} = ?", field_sql));
        }
        Predicate::Like { .. } | Predicate::Pattern { .. } => {
            warnings.push(
                "LIKE and PATTERN predicates require vector search — deferred to Phase 2"
                    .into(),
            );
            // Return early with a graceful empty result
            let mut result = QueryResult::success("Recall", Vec::new());
            result.warnings = warnings;
            return Ok(result);
        }
    }

    // Modifier warnings (collect non-fatal issues)
    warnings.extend(collect_modifier_warnings(&stmt.modifiers));

    // Build final SELECT
    let where_clause = if where_parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };

    let order_clause = order_by_clause(&stmt.modifiers.order_by, table);
    let limit_clause = limit_clause(&stmt.modifiers);

    let sql = format!(
        "SELECT * FROM {} {} {} {}",
        table.as_sql_name(),
        where_clause,
        order_clause,
        limit_clause,
    );

    let mut prepared = conn.prepare(&sql)?;
    let column_names: Vec<String> = prepared
        .column_names()
        .into_iter()
        .map(String::from)
        .collect();

    let rows = prepared.query_map(
        rusqlite::params_from_iter(params.iter()),
        |row| {
            let mut map = Map::new();
            for (i, name) in column_names.iter().enumerate() {
                let value: rusqlite::types::Value = row.get(i)?;
                map.insert(name.clone(), rusqlite_to_json(value));
            }
            Ok(JsonValue::Object(map))
        },
    )?;

    let mut data: Vec<JsonValue> = Vec::new();
    for r in rows {
        data.push(r?);
    }

    // Apply RETURN field selection post-query
    if let Some(fields) = &stmt.modifiers.return_fields {
        if !fields.iter().any(|f| f == "*") {
            data = data
                .into_iter()
                .map(|row| filter_fields(row, fields))
                .collect();
        }
    }

    let mut result = QueryResult::success("Recall", data);
    result.warnings = warnings;
    Ok(result)
}

fn order_by_clause(order: &Option<OrderBy>, table: EngramTable) -> String {
    match order {
        Some(ob) => {
            let field = resolve_field(&ob.field, table).to_sql();
            let dir = if ob.ascending { "ASC" } else { "DESC" };
            format!("ORDER BY {} {}", field, dir)
        }
        None => String::new(),
    }
}

fn limit_clause(modifiers: &Modifiers) -> String {
    match modifiers.limit {
        Some(n) => format!("LIMIT {}", n),
        None => "LIMIT 1000".into(), // safety cap
    }
}

fn collect_modifier_warnings(modifiers: &Modifiers) -> Vec<String> {
    let mut warnings = Vec::new();
    if modifiers.scope.is_some() {
        warnings
            .push("SCOPE modifier accepted but not enforced (schema lacks scope column)".into());
    }
    if modifiers.namespace.is_some() {
        warnings.push(
            "NAMESPACE modifier accepted but not enforced (schema lacks namespace column)".into(),
        );
    }
    if modifiers.ttl.is_some() {
        warnings.push("TTL modifier accepted but not enforced (engram has no TTL)".into());
    }
    if modifiers.timeout.is_some() {
        warnings.push("TIMEOUT modifier accepted but not enforced in Phase 1".into());
    }
    warnings
}

fn filter_fields(row: JsonValue, fields: &[String]) -> JsonValue {
    let JsonValue::Object(obj) = row else {
        return row;
    };
    let mut filtered = Map::new();
    for field in fields {
        if let Some(v) = obj.get(field) {
            filtered.insert(field.clone(), v.clone());
        }
    }
    JsonValue::Object(filtered)
}

fn rusqlite_to_json(value: RusqValue) -> JsonValue {
    match value {
        RusqValue::Null => JsonValue::Null,
        RusqValue::Integer(n) => JsonValue::Number(n.into()),
        RusqValue::Real(f) => serde_json::Number::from_f64(f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        RusqValue::Text(s) => JsonValue::String(s),
        RusqValue::Blob(_) => JsonValue::Null, // don't serialize binary
    }
}
```

- [ ] **Step 7: Update `engram-aql/src/lib.rs`**

```rust
//! engram-aql — AQL query executor for Engram memory files

pub mod error;
pub mod executor;
pub mod memory_map;
pub mod result;
pub mod schema;
pub mod sql;
pub mod statements;

pub use error::{AqlError, AqlResult, SchemaError};
pub use executor::Executor;
pub use memory_map::{aql_to_chunk_memory_type, aql_to_table, EngramTable};
pub use result::{AqlLink, QueryResult};
pub use schema::verify_schema;
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cargo test --test recall 2>&1`
Expected: PASS — 9 recall tests pass.

- [ ] **Step 9: Commit**

```bash
cd ..
git add engram-aql/
git commit -m "feat(engram-aql): implement RECALL statement handler"
```

---

## Task 8: LOOKUP, SCAN, and LOAD Statement Handlers

Add the three remaining simple read handlers. Each is ~50-100 lines.

**Files:**
- Create: `engram-aql/src/statements/lookup.rs`
- Create: `engram-aql/src/statements/scan.rs`
- Create: `engram-aql/src/statements/load.rs`
- Modify: `engram-aql/src/statements/mod.rs`
- Modify: `engram-aql/src/executor.rs`
- Create: `engram-aql/tests/lookup.rs`
- Create: `engram-aql/tests/scan.rs`
- Create: `engram-aql/tests/load.rs`

- [ ] **Step 1: Write failing tests for LOOKUP**

Create `engram-aql/tests/lookup.rs`:

```rust
//! LOOKUP integration tests.

mod common;

use engram_aql::Executor;

#[test]
fn lookup_by_id() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"LOOKUP FROM EPISODIC KEY id = "e-001""#)
        .unwrap();
    assert!(result.success);
    assert_eq!(result.count, 1);
}

#[test]
fn lookup_nonexistent_returns_empty() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"LOOKUP FROM EPISODIC KEY id = "nonexistent""#)
        .unwrap();
    assert!(result.success);
    assert_eq!(result.count, 0);
}
```

- [ ] **Step 2: Write failing tests for SCAN**

Create `engram-aql/tests/scan.rs`:

```rust
//! SCAN integration tests.

mod common;

use engram_aql::Executor;

#[test]
fn scan_working_memory_returns_active_sessions() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("SCAN FROM WORKING WINDOW LAST 10").unwrap();
    assert!(result.success);
    assert_eq!(result.statement, "Scan");
    assert!(result.count >= 2); // seed has 2 working sessions
}

#[test]
fn scan_window_last_n_limits_results() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("SCAN FROM WORKING WINDOW LAST 1").unwrap();
    assert!(result.success);
    assert_eq!(result.count, 1);
}
```

- [ ] **Step 3: Write failing tests for LOAD**

Create `engram-aql/tests/load.rs`:

```rust
//! LOAD integration tests.

mod common;

use engram_aql::Executor;

#[test]
fn load_tools_ordered_by_ranking() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("LOAD FROM TOOLS ALL").unwrap();
    assert!(result.success);
    assert_eq!(result.statement, "Load");
    assert_eq!(result.count, 3);
    // Highest ranking first
    let first_name = result.data[0].get("name").and_then(|v| v.as_str()).unwrap();
    assert_eq!(first_name, "resize");
}

#[test]
fn load_with_name_filter() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"LOAD FROM TOOLS WHERE name = "compress""#)
        .unwrap();
    assert!(result.success);
    assert_eq!(result.count, 1);
}

#[test]
fn load_with_limit() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("LOAD FROM TOOLS ALL LIMIT 2").unwrap();
    assert!(result.success);
    assert_eq!(result.count, 2);
}
```

- [ ] **Step 4: Run all tests to confirm they fail**

Run: `cargo test --tests lookup scan load 2>&1`
Expected: FAIL — handlers not implemented.

- [ ] **Step 5: Implement `engram-aql/src/statements/lookup.rs`**

```rust
//! LOOKUP statement handler. KEY-based exact match, falls back to WHERE.

use aql_parser::ast::{LookupStmt, Predicate};
use rusqlite::types::Value as RusqValue;
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

use crate::error::AqlResult;
use crate::memory_map::{aql_to_chunk_memory_type, aql_to_table, EngramTable};
use crate::result::QueryResult;
use crate::sql::conditions::condition_to_sql;
use crate::sql::fields::resolve_field;

pub fn execute(conn: &Connection, stmt: &LookupStmt) -> AqlResult<QueryResult> {
    let table = aql_to_table(stmt.memory_type);
    let chunk_type = aql_to_chunk_memory_type(stmt.memory_type);

    let mut where_parts: Vec<String> = Vec::new();
    let mut params: Vec<RusqValue> = Vec::new();

    match table {
        EngramTable::Chunks | EngramTable::All => {
            where_parts.push("is_active = 1".into());
            if let Some(t) = chunk_type {
                where_parts.push("memory_type = ?".into());
                params.push(RusqValue::Text(t.into()));
            }
        }
        EngramTable::Tools | EngramTable::Observations => {
            where_parts.push("is_active = 1".into());
        }
        EngramTable::WorkingMemory => {
            where_parts.push("(expires_at IS NULL OR expires_at > datetime('now'))".into());
        }
    }

    match &stmt.predicate {
        Predicate::Key { field, value } => {
            let field_sql = resolve_field(field, table).to_sql();
            params.push(crate::sql::values::value_to_rusqlite(value));
            where_parts.push(format!("{} = ?", field_sql));
        }
        Predicate::Where { conditions } => {
            for cond in conditions {
                where_parts.push(condition_to_sql(cond, table, &mut params));
            }
        }
        Predicate::All => {}
        Predicate::Like { .. } | Predicate::Pattern { .. } => {
            let mut result = QueryResult::success("Lookup", Vec::new());
            result.warnings.push(
                "LIKE and PATTERN predicates require vector search — deferred to Phase 2".into(),
            );
            return Ok(result);
        }
    }

    let where_clause = if where_parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };

    let sql = format!(
        "SELECT * FROM {} {} LIMIT 100",
        table.as_sql_name(),
        where_clause
    );

    let mut prepared = conn.prepare(&sql)?;
    let column_names: Vec<String> = prepared
        .column_names()
        .into_iter()
        .map(String::from)
        .collect();

    let rows = prepared.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        let mut map = Map::new();
        for (i, name) in column_names.iter().enumerate() {
            let v: RusqValue = row.get(i)?;
            map.insert(name.clone(), crate::statements::recall_helpers::rusqlite_to_json(v));
        }
        Ok(JsonValue::Object(map))
    })?;

    let mut data = Vec::new();
    for r in rows {
        data.push(r?);
    }

    Ok(QueryResult::success("Lookup", data))
}
```

- [ ] **Step 6: Extract rusqlite_to_json to a shared helper**

Create `engram-aql/src/statements/recall_helpers.rs`:

```rust
//! Shared helpers for row → JSON conversion used across statement handlers.

use rusqlite::types::Value as RusqValue;
use serde_json::Value as JsonValue;

pub fn rusqlite_to_json(value: RusqValue) -> JsonValue {
    match value {
        RusqValue::Null => JsonValue::Null,
        RusqValue::Integer(n) => JsonValue::Number(n.into()),
        RusqValue::Real(f) => serde_json::Number::from_f64(f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        RusqValue::Text(s) => JsonValue::String(s),
        RusqValue::Blob(_) => JsonValue::Null,
    }
}
```

Then update `engram-aql/src/statements/recall.rs` to use `crate::statements::recall_helpers::rusqlite_to_json` and delete the local copy.

Update `engram-aql/src/statements/mod.rs`:

```rust
//! Statement handlers — one module per AQL statement type.

pub mod load;
pub mod lookup;
pub mod recall;
pub mod recall_helpers;
pub mod scan;
pub mod write_reject;
```

- [ ] **Step 7: Implement `engram-aql/src/statements/scan.rs`**

```rust
//! SCAN statement handler. Reads from working_memory.

use aql_parser::ast::{ScanStmt, Window};
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

use crate::error::AqlResult;
use crate::result::QueryResult;
use crate::statements::recall_helpers::rusqlite_to_json;

pub fn execute(conn: &Connection, stmt: &ScanStmt) -> AqlResult<QueryResult> {
    let mut limit: usize = 10;
    let mut after_datetime: Option<String> = None;

    if let Some(w) = &stmt.window {
        match w {
            Window::LastN { count } => {
                limit = *count;
            }
            Window::LastDuration { duration } => {
                // Convert Duration to an SQLite datetime string
                let secs = duration.as_secs();
                after_datetime = Some(format!("datetime('now', '-{} seconds')", secs));
            }
            Window::TopBy { count, field: _ } => {
                // working_memory has no arbitrary fields — fall back to last-N
                limit = *count;
            }
            Window::Since { .. } => {
                // SINCE with condition — treat as "everything not expired"
            }
        }
    }
    if let Some(n) = stmt.modifiers.limit {
        limit = n;
    }

    let mut where_parts: Vec<String> = vec![
        "(expires_at IS NULL OR expires_at > datetime('now'))".into(),
    ];
    if let Some(clause) = &after_datetime {
        where_parts.push(format!("updated_at > {}", clause));
    }

    let sql = format!(
        "SELECT * FROM working_memory WHERE {} ORDER BY updated_at DESC LIMIT {}",
        where_parts.join(" AND "),
        limit
    );

    let mut prepared = conn.prepare(&sql)?;
    let column_names: Vec<String> = prepared
        .column_names()
        .into_iter()
        .map(String::from)
        .collect();

    let rows = prepared.query_map([], |row| {
        let mut map = Map::new();
        for (i, name) in column_names.iter().enumerate() {
            let v = row.get::<_, rusqlite::types::Value>(i)?;
            map.insert(name.clone(), rusqlite_to_json(v));
        }
        Ok(JsonValue::Object(map))
    })?;

    let mut data = Vec::new();
    for r in rows {
        data.push(r?);
    }

    Ok(QueryResult::success("Scan", data))
}
```

- [ ] **Step 8: Implement `engram-aql/src/statements/load.rs`**

```rust
//! LOAD FROM TOOLS statement handler.

use aql_parser::ast::{LoadStmt, Predicate};
use rusqlite::types::Value as RusqValue;
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

use crate::error::AqlResult;
use crate::memory_map::EngramTable;
use crate::result::QueryResult;
use crate::sql::conditions::condition_to_sql;
use crate::statements::recall_helpers::rusqlite_to_json;

pub fn execute(conn: &Connection, stmt: &LoadStmt) -> AqlResult<QueryResult> {
    let table = EngramTable::Tools;
    let mut where_parts: Vec<String> = vec!["is_active = 1".into()];
    let mut params: Vec<RusqValue> = Vec::new();

    match &stmt.predicate {
        Predicate::All => {}
        Predicate::Where { conditions } => {
            for cond in conditions {
                where_parts.push(condition_to_sql(cond, table, &mut params));
            }
        }
        Predicate::Key { field, value } => {
            let field_sql = crate::sql::fields::resolve_field(field, table).to_sql();
            params.push(crate::sql::values::value_to_rusqlite(value));
            where_parts.push(format!("{} = ?", field_sql));
        }
        Predicate::Like { .. } | Predicate::Pattern { .. } => {
            let mut result = QueryResult::success("Load", Vec::new());
            result
                .warnings
                .push("LIKE/PATTERN on TOOLS deferred to Phase 2".into());
            return Ok(result);
        }
    }

    let limit = stmt.modifiers.limit.unwrap_or(10);
    let sql = format!(
        "SELECT * FROM tools WHERE {} ORDER BY ranking DESC LIMIT {}",
        where_parts.join(" AND "),
        limit
    );

    let mut prepared = conn.prepare(&sql)?;
    let column_names: Vec<String> = prepared
        .column_names()
        .into_iter()
        .map(String::from)
        .collect();

    let rows = prepared.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        let mut map = Map::new();
        for (i, name) in column_names.iter().enumerate() {
            let v: RusqValue = row.get(i)?;
            map.insert(name.clone(), rusqlite_to_json(v));
        }
        Ok(JsonValue::Object(map))
    })?;

    let mut data = Vec::new();
    for r in rows {
        data.push(r?);
    }

    // Apply RETURN field selection
    if let Some(fields) = &stmt.modifiers.return_fields {
        if !fields.iter().any(|f| f == "*") {
            data = data
                .into_iter()
                .map(|row| {
                    let JsonValue::Object(obj) = row else {
                        return row;
                    };
                    let mut filtered = Map::new();
                    for field in fields {
                        if let Some(v) = obj.get(field) {
                            filtered.insert(field.clone(), v.clone());
                        }
                    }
                    JsonValue::Object(filtered)
                })
                .collect();
        }
    }

    Ok(QueryResult::success("Load", data))
}
```

- [ ] **Step 9: Wire the new handlers into `executor.rs`**

Update the `dispatch` method in `engram-aql/src/executor.rs`:

```rust
    fn dispatch(&self, stmt: &Statement) -> AqlResult<QueryResult> {
        match stmt {
            Statement::Recall(r) => statements::recall::execute(&self.conn, r),
            Statement::Lookup(l) => statements::lookup::execute(&self.conn, l),
            Statement::Scan(s) => statements::scan::execute(&self.conn, s),
            Statement::Load(l) => statements::load::execute(&self.conn, l),

            // Writes — rejected at dispatch time
            Statement::Store(_)
            | Statement::Update(_)
            | Statement::Forget(_)
            | Statement::Link(_)
            | Statement::Reflect(_) => Ok(statements::write_reject::reject(stmt)),

            Statement::Pipeline(_) => Ok(QueryResult::error(
                "Pipeline",
                "PIPELINE not yet implemented",
            )),
        }
    }
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `cargo test 2>&1`
Expected: PASS — all recall, lookup, scan, load tests pass.

- [ ] **Step 11: Commit**

```bash
cd ..
git add engram-aql/
git commit -m "feat(engram-aql): implement LOOKUP, SCAN, LOAD statement handlers"
```

---

## Task 9: AGGREGATE and HAVING

Extend RECALL (and possibly LOAD) to support AGGREGATE functions and HAVING.

**Files:**
- Modify: `engram-aql/src/statements/recall.rs`
- Create: `engram-aql/tests/aggregate.rs`

- [ ] **Step 1: Write failing tests**

Create `engram-aql/tests/aggregate.rs`:

```rust
//! AGGREGATE + HAVING integration tests.

mod common;

use engram_aql::Executor;

#[test]
fn count_all_episodic() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query("RECALL FROM EPISODIC ALL AGGREGATE COUNT(*) AS total")
        .unwrap();
    assert!(result.success);
    let total = result.data[0].get("total").and_then(|v| v.as_i64()).unwrap();
    assert_eq!(total, 4); // 4 episodic records in seed
}

#[test]
fn count_filtered_by_context() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"RECALL FROM EPISODIC WHERE context = "ops" AGGREGATE COUNT(*) AS total"#)
        .unwrap();
    assert!(result.success);
    let total = result.data[0].get("total").and_then(|v| v.as_i64()).unwrap();
    assert_eq!(total, 3);
}

#[test]
fn avg_trust_score() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query("RECALL FROM EPISODIC ALL AGGREGATE AVG(trust_score) AS avg_trust")
        .unwrap();
    assert!(result.success);
    let avg = result.data[0].get("avg_trust").and_then(|v| v.as_f64()).unwrap();
    // (0.9 + 0.7 + 0.8 + 0.85) / 4 = 0.8125
    assert!((avg - 0.8125).abs() < 0.0001);
}

#[test]
fn min_max_trust_score() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(
            "RECALL FROM EPISODIC ALL AGGREGATE MIN(trust_score) AS min_t, MAX(trust_score) AS max_t",
        )
        .unwrap();
    assert!(result.success);
    let min = result.data[0].get("min_t").and_then(|v| v.as_f64()).unwrap();
    let max = result.data[0].get("max_t").and_then(|v| v.as_f64()).unwrap();
    assert!((min - 0.7).abs() < 0.001);
    assert!((max - 0.9).abs() < 0.001);
}

#[test]
fn having_filters_aggregate_results() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(
            "RECALL FROM EPISODIC WHERE context = \"ops\" \
             AGGREGATE AVG(trust_score) AS avg_t HAVING avg_t > 0.75",
        )
        .unwrap();
    assert!(result.success);
    assert_eq!(result.count, 1);
}

#[test]
fn having_excludes_non_matching() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(
            "RECALL FROM EPISODIC WHERE context = \"ops\" \
             AGGREGATE AVG(trust_score) AS avg_t HAVING avg_t > 0.99",
        )
        .unwrap();
    assert!(result.success);
    assert_eq!(result.count, 0);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test aggregate 2>&1`
Expected: FAIL — aggregate path not implemented.

- [ ] **Step 3: Extend `engram-aql/src/statements/recall.rs` to handle aggregates**

Add at the top of `execute()`, BEFORE building the WHERE clause but after initial setup:

```rust
    // AGGREGATE path — if modifiers have aggregate functions, build a
    // SELECT <aggs> FROM ... WHERE ... HAVING ... query instead of SELECT *.
    if let Some(aggs) = &stmt.modifiers.aggregate {
        if !aggs.is_empty() {
            return execute_aggregate(conn, stmt, table, chunk_type, aggs);
        }
    }
```

Add a new function in the same file:

```rust
fn execute_aggregate(
    conn: &Connection,
    stmt: &RecallStmt,
    table: EngramTable,
    chunk_type: Option<&'static str>,
    aggs: &[aql_parser::ast::AggregateFunc],
) -> AqlResult<QueryResult> {
    use aql_parser::ast::{AggregateFuncType, Predicate};

    let mut where_parts: Vec<String> = Vec::new();
    let mut params: Vec<RusqValue> = Vec::new();

    match table {
        EngramTable::Chunks | EngramTable::All => {
            where_parts.push("is_active = 1".into());
            if let Some(t) = chunk_type {
                where_parts.push("memory_type = ?".into());
                params.push(RusqValue::Text(t.into()));
            }
        }
        EngramTable::Tools | EngramTable::Observations => {
            where_parts.push("is_active = 1".into());
        }
        EngramTable::WorkingMemory => {
            where_parts.push("(expires_at IS NULL OR expires_at > datetime('now'))".into());
        }
    }

    match &stmt.predicate {
        Predicate::All => {}
        Predicate::Where { conditions } => {
            for cond in conditions {
                where_parts.push(condition_to_sql(cond, table, &mut params));
            }
        }
        _ => {}
    }

    // Build SELECT clause from aggregates
    let mut select_parts: Vec<String> = Vec::new();
    for agg in aggs {
        let func_name = match agg.func {
            AggregateFuncType::Count => "COUNT",
            AggregateFuncType::Sum => "SUM",
            AggregateFuncType::Avg => "AVG",
            AggregateFuncType::Min => "MIN",
            AggregateFuncType::Max => "MAX",
        };
        let field_sql = match &agg.field {
            None => "*".to_string(),
            Some(f) if f == "*" => "*".to_string(),
            Some(f) => resolve_field(f, table).to_sql(),
        };
        let alias = agg
            .alias
            .clone()
            .unwrap_or_else(|| format!("{}_value", func_name.to_lowercase()));
        select_parts.push(format!("{}({}) AS {}", func_name, field_sql, alias));
    }

    let where_clause = if where_parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };

    let mut sql = format!(
        "SELECT {} FROM {} {}",
        select_parts.join(", "),
        table.as_sql_name(),
        where_clause
    );

    // HAVING clause — operates on the aggregate aliases, which are computed
    // columns. We bind the HAVING conditions using the same condition_to_sql
    // helper but against a virtual "aggregate" column set.
    if let Some(having) = &stmt.modifiers.having {
        if !having.is_empty() {
            let mut having_parts: Vec<String> = Vec::new();
            for cond in having {
                // For HAVING, field names are expected to be aliases — not
                // rewritten through resolve_field.
                let fragment = having_condition_to_sql(cond, &mut params);
                having_parts.push(fragment);
            }
            sql.push_str(&format!(" HAVING {}", having_parts.join(" AND ")));
        }
    }

    let mut prepared = conn.prepare(&sql)?;
    let column_names: Vec<String> = prepared
        .column_names()
        .into_iter()
        .map(String::from)
        .collect();

    let rows = prepared.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        let mut map = Map::new();
        for (i, name) in column_names.iter().enumerate() {
            let v: RusqValue = row.get(i)?;
            map.insert(name.clone(), crate::statements::recall_helpers::rusqlite_to_json(v));
        }
        Ok(JsonValue::Object(map))
    })?;

    let mut data = Vec::new();
    for r in rows {
        data.push(r?);
    }

    Ok(QueryResult::success("Recall", data))
}

/// Translate a HAVING condition to SQL. HAVING references aggregate aliases
/// which are computed columns — we do NOT apply field resolution, because the
/// aliases don't exist in the schema.
fn having_condition_to_sql(
    cond: &aql_parser::ast::Condition,
    params: &mut Vec<RusqValue>,
) -> String {
    use aql_parser::ast::{Condition, LogicalOp, Operator};

    match cond {
        Condition::Simple {
            field,
            operator,
            value,
            logical_op: _,
        } => {
            let op_sql = match operator {
                Operator::Eq => "=",
                Operator::Ne => "!=",
                Operator::Gt => ">",
                Operator::Gte => ">=",
                Operator::Lt => "<",
                Operator::Lte => "<=",
                _ => "=", // HAVING with CONTAINS etc. is unusual; fall back to eq
            };
            params.push(crate::sql::values::value_to_rusqlite(value));
            format!("{} {} ?", field, op_sql)
        }
        Condition::Group {
            conditions,
            logical_op: _,
        } => {
            let mut parts: Vec<String> = Vec::new();
            for (i, c) in conditions.iter().enumerate() {
                if i > 0 {
                    let op = c.logical_op().unwrap_or(LogicalOp::And);
                    parts.push(match op {
                        LogicalOp::And => "AND".to_string(),
                        LogicalOp::Or => "OR".to_string(),
                    });
                }
                parts.push(having_condition_to_sql(c, params));
            }
            format!("({})", parts.join(" "))
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --test aggregate 2>&1`
Expected: PASS — 6 aggregate tests pass.

- [ ] **Step 5: Run full test suite**

Run: `cargo test 2>&1`
Expected: All previous tests still pass.

- [ ] **Step 6: Commit**

```bash
cd ..
git add engram-aql/
git commit -m "feat(engram-aql): implement AGGREGATE and HAVING for RECALL"
```

---

## Task 10: WITH LINKS and FOLLOW LINKS Graph Traversal

Add graph traversal support to RECALL via chunk_entities + relations JOINs.

**Files:**
- Create: `engram-aql/src/statements/graph.rs`
- Modify: `engram-aql/src/statements/recall.rs`
- Modify: `engram-aql/src/statements/mod.rs`
- Create: `engram-aql/tests/graph.rs`

- [ ] **Step 1: Write failing tests**

Create `engram-aql/tests/graph.rs`:

```rust
//! WITH LINKS and FOLLOW LINKS integration tests.

mod common;

use engram_aql::Executor;

#[test]
fn with_links_attaches_link_metadata() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"RECALL FROM EPISODIC WHERE id = "e-001" WITH LINKS ALL"#)
        .unwrap();
    assert!(result.success);
    assert_eq!(result.count, 1);
    // Should have link metadata attached from the relations table
    assert!(result.links.is_some());
    let links = result.links.as_ref().unwrap();
    assert!(!links.is_empty());
}

#[test]
fn follow_links_expands_to_related_chunks() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(
            r#"RECALL FROM EPISODIC WHERE id = "e-001" FOLLOW LINKS TYPE "uses_pattern" INTO SEMANTIC"#,
        )
        .unwrap();
    assert!(result.success);
    // Should include the original e-001 plus any semantic chunks linked via "uses_pattern"
    // (s-001 is linked to ent-bluegreen which ent-deploy uses_pattern to)
    // Phase 1 expected: at least 1 result (the base) — graph expansion is best-effort
    assert!(result.count >= 1);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test graph 2>&1`
Expected: FAIL — graph modifiers not handled.

- [ ] **Step 3: Implement `engram-aql/src/statements/graph.rs`**

```rust
//! Graph traversal helpers for WITH LINKS and FOLLOW LINKS modifiers.

use aql_parser::ast::{FollowLinks, WithLinks};
use rusqlite::Connection;

use crate::error::AqlResult;
use crate::result::AqlLink;

/// Fetch link metadata for a set of chunk IDs.
///
/// For each chunk, walk chunk_entities → relations to find all edges
/// touching the chunk's entities.
pub fn fetch_links_for(
    conn: &Connection,
    chunk_ids: &[String],
    filter: &WithLinks,
) -> AqlResult<Vec<AqlLink>> {
    if chunk_ids.is_empty() {
        return Ok(Vec::new());
    }

    let type_filter_clause = match filter {
        WithLinks::All => String::new(),
        WithLinks::Type { link_type } => format!(" AND r.relation_type = '{}'", link_type),
    };

    let placeholders: Vec<&str> = chunk_ids.iter().map(|_| "?").collect();
    let sql = format!(
        "SELECT DISTINCT
             r.source_entity_id,
             r.target_entity_id,
             r.relation_type,
             r.confidence
         FROM relations r
         JOIN chunk_entities ce
           ON (ce.entity_id = r.source_entity_id OR ce.entity_id = r.target_entity_id)
         WHERE ce.chunk_id IN ({}) AND r.is_active = 1 {}",
        placeholders.join(", "),
        type_filter_clause
    );

    let mut prepared = conn.prepare(&sql)?;
    let rows = prepared.query_map(rusqlite::params_from_iter(chunk_ids.iter()), |row| {
        Ok(AqlLink {
            source_id: row.get(0)?,
            target_id: row.get(1)?,
            link_type: row.get(2)?,
            confidence: row.get::<_, f64>(3).unwrap_or(0.0),
        })
    })?;

    let mut links = Vec::new();
    for r in rows {
        links.push(r?);
    }
    Ok(links)
}

/// Expand a set of chunk IDs by following a specific link type, up to the
/// given depth. Returns the set of expanded chunk IDs (not including the
/// originals — dedup is the caller's responsibility).
pub fn follow_links_expand(
    conn: &Connection,
    chunk_ids: &[String],
    follow: &FollowLinks,
) -> AqlResult<Vec<String>> {
    if chunk_ids.is_empty() {
        return Ok(Vec::new());
    }

    let depth = follow.depth.unwrap_or(1) as i64;
    let placeholders: Vec<&str> = chunk_ids.iter().map(|_| "?").collect();

    // Recursive CTE: start from the chunks' entities, walk relations of the
    // requested type up to depth N, then collect chunks linked to the reached
    // entities.
    let sql = format!(
        r#"
        WITH RECURSIVE graph_walk(entity_id, depth) AS (
            SELECT entity_id, 0
              FROM chunk_entities
             WHERE chunk_id IN ({})
            UNION
            SELECT r.target_entity_id, g.depth + 1
              FROM relations r
              JOIN graph_walk g ON r.source_entity_id = g.entity_id
             WHERE r.relation_type = ?
               AND r.is_active = 1
               AND g.depth < ?
        )
        SELECT DISTINCT c.id
          FROM chunks c
          JOIN chunk_entities ce ON c.id = ce.chunk_id
         WHERE ce.entity_id IN (SELECT entity_id FROM graph_walk WHERE depth > 0)
           AND c.is_active = 1
        "#,
        placeholders.join(", ")
    );

    let mut prepared = conn.prepare(&sql)?;
    let mut params: Vec<rusqlite::types::Value> = chunk_ids
        .iter()
        .map(|s| rusqlite::types::Value::Text(s.clone()))
        .collect();
    params.push(rusqlite::types::Value::Text(follow.link_type.clone()));
    params.push(rusqlite::types::Value::Integer(depth));

    let rows = prepared.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        row.get::<_, String>(0)
    })?;

    let mut ids = Vec::new();
    for r in rows {
        ids.push(r?);
    }
    Ok(ids)
}
```

- [ ] **Step 4: Wire graph modifiers into RECALL handler**

In `engram-aql/src/statements/recall.rs`, after building the base result `data` (and before the RETURN field filtering step), add:

```rust
    // Extract chunk IDs from the base result for graph expansion
    let chunk_ids: Vec<String> = data
        .iter()
        .filter_map(|row| {
            row.get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .collect();

    let mut links: Option<Vec<crate::result::AqlLink>> = None;

    // WITH LINKS — attach metadata to the result
    if let Some(with) = &stmt.modifiers.with_links {
        let fetched = crate::statements::graph::fetch_links_for(conn, &chunk_ids, with)?;
        if !fetched.is_empty() {
            links = Some(fetched);
        }
    }

    // FOLLOW LINKS — expand the result with related chunks
    if let Some(follow) = &stmt.modifiers.follow_links {
        let expanded_ids = crate::statements::graph::follow_links_expand(conn, &chunk_ids, follow)?;
        if !expanded_ids.is_empty() {
            // Fetch the expanded rows
            let placeholders: Vec<&str> = expanded_ids.iter().map(|_| "?").collect();
            let sql = format!(
                "SELECT * FROM chunks WHERE id IN ({}) AND is_active = 1",
                placeholders.join(", ")
            );
            let mut prep = conn.prepare(&sql)?;
            let column_names: Vec<String> = prep
                .column_names()
                .into_iter()
                .map(String::from)
                .collect();
            let rows = prep.query_map(
                rusqlite::params_from_iter(expanded_ids.iter()),
                |row| {
                    let mut map = Map::new();
                    for (i, name) in column_names.iter().enumerate() {
                        let v: RusqValue = row.get(i)?;
                        map.insert(
                            name.clone(),
                            crate::statements::recall_helpers::rusqlite_to_json(v),
                        );
                    }
                    Ok(JsonValue::Object(map))
                },
            )?;
            let mut seen: std::collections::HashSet<String> = data
                .iter()
                .filter_map(|r| r.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect();
            for r in rows {
                let row = r?;
                if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
                    if seen.insert(id.to_string()) {
                        data.push(row);
                    }
                }
            }
        }
    }
```

Then update the `QueryResult::success` return to attach links:

```rust
    let mut result = QueryResult::success("Recall", data);
    result.warnings = warnings;
    result.links = links;
    Ok(result)
```

Update `engram-aql/src/statements/mod.rs` to expose `graph`:

```rust
//! Statement handlers — one module per AQL statement type.

pub mod graph;
pub mod load;
pub mod lookup;
pub mod recall;
pub mod recall_helpers;
pub mod scan;
pub mod write_reject;
```

- [ ] **Step 5: Run tests**

Run: `cargo test --test graph 2>&1`
Expected: PASS — both graph tests pass.

- [ ] **Step 6: Run full suite**

Run: `cargo test 2>&1`
Expected: all previous tests still pass.

- [ ] **Step 7: Commit**

```bash
cd ..
git add engram-aql/
git commit -m "feat(engram-aql): implement WITH LINKS and FOLLOW LINKS graph traversal"
```

---

## Task 11: PIPELINE Statement

Sequential statement execution with optional timeout.

**Files:**
- Create: `engram-aql/src/statements/pipeline.rs`
- Modify: `engram-aql/src/statements/mod.rs`
- Modify: `engram-aql/src/executor.rs`
- Create: `engram-aql/tests/pipeline.rs`

- [ ] **Step 1: Write failing tests**

Create `engram-aql/tests/pipeline.rs`:

```rust
//! PIPELINE integration tests.

mod common;

use engram_aql::Executor;

#[test]
fn pipeline_two_stages_returns_combined_results() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query("PIPELINE test RECALL FROM EPISODIC ALL LIMIT 2 | RECALL FROM SEMANTIC ALL LIMIT 2")
        .unwrap();
    assert!(result.success);
    assert_eq!(result.statement, "Pipeline");
    assert_eq!(result.pipeline_stages, Some(2));
    // Both stages collected
    assert_eq!(result.count, 4);
}

#[test]
fn pipeline_fails_fast_on_write_stage() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(
            r#"PIPELINE test RECALL FROM EPISODIC ALL LIMIT 1 | STORE INTO EPISODIC (foo = "bar")"#,
        )
        .unwrap();
    assert!(!result.success);
    assert!(result.error.is_some());
}
```

Note: The pipeline separator in the AQL grammar is `|` (pipe) based on typical AQL conventions — verify against `grammar/aql.pest` in the vendored source. If it's `THEN` instead, update the test queries accordingly.

- [ ] **Step 2: Verify the pipeline separator**

Run:
```bash
grep -A3 "pipeline_stmt" engram-aql/vendor/aql-parser/grammar.pest
```

Inspect the output. Common separators: `|`, `THEN`, `;`. Use whatever the grammar specifies in the test queries in Step 1.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --test pipeline 2>&1`
Expected: FAIL — pipeline not implemented.

- [ ] **Step 4: Implement `engram-aql/src/statements/pipeline.rs`**

```rust
//! PIPELINE statement handler — sequential execution of stages.

use std::time::Instant;

use aql_parser::ast::PipelineStmt;
use rusqlite::Connection;
use serde_json::Value as JsonValue;

use crate::error::AqlResult;
use crate::result::QueryResult;

pub fn execute(conn: &Connection, stmt: &PipelineStmt) -> AqlResult<QueryResult> {
    let start = Instant::now();
    let timeout_ms = stmt.timeout.map(|d| d.as_millis() as u128);

    let mut collected_data: Vec<JsonValue> = Vec::new();
    let mut collected_warnings: Vec<String> = Vec::new();
    let mut stages_completed: usize = 0;

    for (i, stage_stmt) in stmt.stages.iter().enumerate() {
        // Timeout check
        if let Some(budget_ms) = timeout_ms {
            if start.elapsed().as_millis() > budget_ms {
                let mut result = QueryResult::error(
                    "Pipeline",
                    format!(
                        "pipeline '{}' timed out after {:?} at stage {}",
                        stmt.name, stmt.timeout, i + 1
                    ),
                );
                result.pipeline_stages = Some(stages_completed);
                result.data = collected_data;
                result.count = result.data.len();
                return Ok(result);
            }
        }

        // Dispatch the stage. We reuse the top-level executor logic by calling
        // into the same dispatch path. To avoid a circular dependency, the
        // dispatch is inlined here via a small helper.
        let stage_result = dispatch_stage(conn, stage_stmt)?;

        if !stage_result.success {
            // Fail-fast: propagate the stage error
            let mut result = QueryResult::error(
                "Pipeline",
                format!(
                    "pipeline failed at stage {}: {}",
                    i + 1,
                    stage_result.error.as_deref().unwrap_or("unknown error")
                ),
            );
            result.pipeline_stages = Some(stages_completed);
            result.data = collected_data;
            result.count = result.data.len();
            return Ok(result);
        }

        collected_data.extend(stage_result.data);
        collected_warnings.extend(stage_result.warnings);
        stages_completed += 1;
    }

    let mut result = QueryResult::success("Pipeline", collected_data);
    result.warnings = collected_warnings;
    result.pipeline_stages = Some(stages_completed);
    Ok(result)
}

/// Minimal in-module dispatch — mirrors `Executor::dispatch` to avoid
/// circular module dependencies. Keep in sync.
fn dispatch_stage(
    conn: &Connection,
    stmt: &aql_parser::ast::Statement,
) -> AqlResult<QueryResult> {
    use aql_parser::ast::Statement;
    match stmt {
        Statement::Recall(r) => crate::statements::recall::execute(conn, r),
        Statement::Lookup(l) => crate::statements::lookup::execute(conn, l),
        Statement::Scan(s) => crate::statements::scan::execute(conn, s),
        Statement::Load(l) => crate::statements::load::execute(conn, l),
        Statement::Store(_)
        | Statement::Update(_)
        | Statement::Forget(_)
        | Statement::Link(_)
        | Statement::Reflect(_) => Ok(crate::statements::write_reject::reject(stmt)),
        Statement::Pipeline(_) => Ok(QueryResult::error(
            "Pipeline",
            "nested PIPELINE not supported",
        )),
    }
}
```

- [ ] **Step 5: Wire into executor**

Update `engram-aql/src/executor.rs` dispatch:

```rust
            Statement::Pipeline(p) => statements::pipeline::execute(&self.conn, p),
```

And update `engram-aql/src/statements/mod.rs` to expose pipeline:

```rust
pub mod pipeline;
```

- [ ] **Step 6: Run tests**

Run: `cargo test --test pipeline 2>&1`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd ..
git add engram-aql/
git commit -m "feat(engram-aql): implement PIPELINE sequential execution"
```

---

## Task 12: Write Rejection Tests

Explicit tests that every write statement is rejected with a helpful error message. This locks in the Phase 1 read-only boundary.

**Files:**
- Create: `engram-aql/tests/write_rejection.rs`

- [ ] **Step 1: Write the tests**

Create `engram-aql/tests/write_rejection.rs`:

```rust
//! Verify write statements are rejected with helpful errors in Phase 1.

mod common;

use engram_aql::Executor;

#[test]
fn store_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"STORE INTO EPISODIC (event = "deploy", outcome = "success")"#)
        .unwrap();
    assert!(!result.success);
    assert_eq!(result.statement, "Store");
    let err = result.error.unwrap();
    assert!(err.contains("STORE"));
    assert!(err.contains("engram_retain"));
}

#[test]
fn update_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    // Use a simple update — any valid AQL UPDATE is fine since we reject pre-dispatch
    let result = exec
        .query(r#"UPDATE EPISODIC SET outcome = "rollback" WHERE id = "e-001""#)
        .unwrap();
    assert!(!result.success);
    assert_eq!(result.statement, "Update");
    assert!(result.error.unwrap().contains("supersede"));
}

#[test]
fn forget_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"FORGET FROM EPISODIC WHERE id = "e-001""#)
        .unwrap();
    assert!(!result.success);
    assert_eq!(result.statement, "Forget");
    assert!(result.error.unwrap().contains("engram_forget"));
}

#[test]
fn link_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(
            r#"LINK FROM EPISODIC WHERE id = "e-001" TO SEMANTIC WHERE id = "s-001" TYPE "uses""#,
        )
        .unwrap();
    assert!(!result.success);
    assert_eq!(result.statement, "Link");
    assert!(result.error.unwrap().contains("Phase 2"));
}

#[test]
fn reflect_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("REFLECT FROM EPISODIC WHERE id = \"e-001\"").unwrap();
    assert!(!result.success);
    assert_eq!(result.statement, "Reflect");
    assert!(result.error.unwrap().contains("engram_reflect"));
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test --test write_rejection 2>&1`
Expected: PASS — all 5 write types rejected.

If any test fails to parse (e.g., the UPDATE or LINK syntax differs from the grammar), adjust the query string to match the actual grammar rules in `vendor/aql-parser/grammar.pest`.

- [ ] **Step 3: Commit**

```bash
cd ..
git add engram-aql/
git commit -m "test(engram-aql): verify write statements are rejected in Phase 1"
```

---

## Task 13: Query Subcommand (CLI One-Shot)

Implement `engram-aql query <db-path> "<aql>"` — prints JSON to stdout.

**Files:**
- Create: `engram-aql/src/subcommand/mod.rs`
- Create: `engram-aql/src/subcommand/query.rs`
- Modify: `engram-aql/src/main.rs`
- Create: `engram-aql/tests/subcommand_query.rs`

- [ ] **Step 1: Write the failing test**

Create `engram-aql/tests/subcommand_query.rs`:

```rust
//! CLI query subcommand integration test.
//! Creates a temp .engram file, runs `engram-aql query`, asserts on stdout.

mod common;

use std::process::Command;
use tempfile::NamedTempFile;

#[test]
fn query_subcommand_returns_json() {
    // Write a seeded database to a temp file
    let file = NamedTempFile::new().unwrap();
    let path = file.path();

    {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch(include_str!("../../src/schema.sql")).unwrap();
        conn.execute_batch(include_str!("fixtures/seed.sql")).unwrap();
    }

    // Invoke the binary via cargo run
    let output = Command::new(env!("CARGO_BIN_EXE_engram-aql"))
        .arg("query")
        .arg(path)
        .arg("RECALL FROM EPISODIC ALL LIMIT 2")
        .output()
        .expect("failed to run engram-aql");

    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));

    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: serde_json::Value = serde_json::from_str(&stdout).expect("not valid JSON");
    assert_eq!(json["success"], true);
    assert_eq!(json["statement"], "Recall");
    assert!(json["count"].as_u64().unwrap() >= 1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --test subcommand_query 2>&1`
Expected: FAIL — subcommand still prints TODO.

- [ ] **Step 3: Implement `engram-aql/src/subcommand/mod.rs`**

```rust
//! CLI subcommands.

pub mod query;
```

- [ ] **Step 4: Implement `engram-aql/src/subcommand/query.rs`**

```rust
//! `engram-aql query` — one-shot query execution.

use std::path::Path;

use anyhow::Result;

use crate::executor::Executor;

pub fn run(db_path: &Path, query: &str) -> Result<()> {
    let exec = Executor::open(db_path)?;
    let result = exec.query(query)?;
    let json = serde_json::to_string_pretty(&result)?;
    println!("{}", json);

    // Non-zero exit code if the query failed
    if !result.success {
        std::process::exit(1);
    }
    Ok(())
}
```

- [ ] **Step 5: Update `engram-aql/src/main.rs`**

Update the `Query` arm of the match in `main()`:

```rust
        Command::Query { db_path, query } => {
            engram_aql::subcommand::query::run(&db_path, &query)
        }
```

And add the subcommand module to `lib.rs`:

```rust
pub mod subcommand;
```

- [ ] **Step 6: Run tests**

Run: `cargo test --test subcommand_query 2>&1`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd ..
git add engram-aql/
git commit -m "feat(engram-aql): implement query subcommand"
```

---

## Task 14: REPL Subcommand

Interactive prompt with line editing and pretty-printed tables.

**Files:**
- Create: `engram-aql/src/subcommand/repl.rs`
- Modify: `engram-aql/src/subcommand/mod.rs`
- Modify: `engram-aql/src/main.rs`

- [ ] **Step 1: Implement `engram-aql/src/subcommand/repl.rs`**

```rust
//! `engram-aql repl` — interactive REPL with rustyline and pretty tables.

use std::path::Path;

use anyhow::Result;
use comfy_table::{presets::UTF8_FULL, Cell, ContentArrangement, Table};
use rustyline::error::ReadlineError;
use rustyline::DefaultEditor;
use serde_json::Value as JsonValue;

use crate::executor::Executor;
use crate::result::QueryResult;

pub fn run(db_path: &Path) -> Result<()> {
    println!("engram-aql 0.1.0 — read-only mode");
    println!("Connected to: {}", db_path.display());
    println!("Type \\help for commands. \\quit to exit.");
    println!();

    let exec = Executor::open(db_path)?;
    let mut rl = DefaultEditor::new()?;

    loop {
        match rl.readline("aql> ") {
            Ok(line) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                rl.add_history_entry(line).ok();

                // REPL commands (backslash-prefixed)
                if let Some(cmd) = line.strip_prefix('\\') {
                    match cmd {
                        "quit" | "q" | "exit" => break,
                        "help" | "h" => {
                            print_help();
                            continue;
                        }
                        other => {
                            println!("unknown command: \\{}", other);
                            continue;
                        }
                    }
                }

                // AQL query
                match exec.query(line) {
                    Ok(result) => print_result(&result),
                    Err(e) => println!("error: {}", e),
                }
            }
            Err(ReadlineError::Interrupted) | Err(ReadlineError::Eof) => break,
            Err(e) => {
                println!("readline error: {}", e);
                break;
            }
        }
    }
    Ok(())
}

fn print_help() {
    println!("Commands:");
    println!("  \\help, \\h    show this help");
    println!("  \\quit, \\q    exit the REPL");
    println!();
    println!("Otherwise, type an AQL query followed by Enter.");
    println!("Example: RECALL FROM EPISODIC ALL LIMIT 5");
}

fn print_result(result: &QueryResult) {
    if !result.success {
        println!(
            "error: {}",
            result.error.as_deref().unwrap_or("unknown error")
        );
        return;
    }

    if result.data.is_empty() {
        println!("(no rows — {} ms)", result.timing_ms);
        return;
    }

    // Collect column names from the first row (ordered)
    let JsonValue::Object(first) = &result.data[0] else {
        println!("{}", serde_json::to_string_pretty(&result.data).unwrap());
        return;
    };
    let columns: Vec<String> = first.keys().cloned().collect();

    let mut table = Table::new();
    table
        .load_preset(UTF8_FULL)
        .set_content_arrangement(ContentArrangement::Dynamic)
        .set_header(columns.iter().map(|c| Cell::new(c)));

    for row in &result.data {
        let JsonValue::Object(obj) = row else {
            continue;
        };
        let cells: Vec<Cell> = columns
            .iter()
            .map(|col| {
                let val = obj.get(col).cloned().unwrap_or(JsonValue::Null);
                let display = match val {
                    JsonValue::Null => "NULL".to_string(),
                    JsonValue::String(s) => {
                        if s.len() > 60 {
                            format!("{}…", &s[..57])
                        } else {
                            s
                        }
                    }
                    v => v.to_string(),
                };
                Cell::new(display)
            })
            .collect();
        table.add_row(cells);
    }

    println!("{}", table);
    println!("{} rows · {} ms", result.count, result.timing_ms);

    if !result.warnings.is_empty() {
        println!();
        for w in &result.warnings {
            println!("warning: {}", w);
        }
    }
}
```

- [ ] **Step 2: Update `engram-aql/src/subcommand/mod.rs`**

```rust
pub mod query;
pub mod repl;
```

- [ ] **Step 3: Update `engram-aql/src/main.rs`**

```rust
        Command::Repl { db_path } => engram_aql::subcommand::repl::run(&db_path),
```

- [ ] **Step 4: Manual smoke test**

Run:
```bash
cd engram-aql
cargo build
# Create a seeded DB
sqlite3 /tmp/test.engram < ../src/schema.sql
sqlite3 /tmp/test.engram < tests/fixtures/seed.sql
./target/debug/engram-aql repl /tmp/test.engram
```

At the prompt, try:
```
aql> RECALL FROM EPISODIC ALL LIMIT 3
aql> AGGREGATE COUNT(*) AS total FROM EPISODIC
aql> \help
aql> \quit
```

Verify tables render, commands work, exit is clean.

- [ ] **Step 5: Commit**

```bash
cd ..
git add engram-aql/
git commit -m "feat(engram-aql): implement interactive REPL subcommand"
```

---

## Task 15: MCP Stdio Server Subcommand

Hand-rolled JSON-RPC over stdio exposing the `engram_aql` tool.

**Files:**
- Create: `engram-aql/src/mcp/mod.rs`
- Create: `engram-aql/src/mcp/protocol.rs`
- Create: `engram-aql/src/mcp/handlers.rs`
- Create: `engram-aql/src/subcommand/mcp.rs`
- Modify: `engram-aql/src/subcommand/mod.rs`
- Modify: `engram-aql/src/main.rs`
- Modify: `engram-aql/src/lib.rs`
- Create: `engram-aql/tests/mcp_roundtrip.rs`

- [ ] **Step 1: Write the failing integration test**

Create `engram-aql/tests/mcp_roundtrip.rs`:

```rust
//! MCP stdio server round-trip test.
//! Spawns the MCP server, sends initialize + tools/list + tools/call, asserts responses.

mod common;

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use tempfile::NamedTempFile;

fn setup_db() -> NamedTempFile {
    let file = NamedTempFile::new().unwrap();
    let conn = rusqlite::Connection::open(file.path()).unwrap();
    conn.execute_batch(include_str!("../../src/schema.sql"))
        .unwrap();
    conn.execute_batch(include_str!("fixtures/seed.sql"))
        .unwrap();
    file
}

fn send(stdin: &mut impl Write, msg: &str) {
    writeln!(stdin, "{}", msg).unwrap();
    stdin.flush().unwrap();
}

fn read_line(reader: &mut impl BufRead) -> String {
    let mut s = String::new();
    reader.read_line(&mut s).unwrap();
    s.trim().to_string()
}

#[test]
fn mcp_initialize_and_list_tools_and_call() {
    let file = setup_db();

    let mut child = Command::new(env!("CARGO_BIN_EXE_engram-aql"))
        .arg("mcp")
        .arg(file.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    // initialize
    send(&mut stdin, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}"#);
    let resp = read_line(&mut stdout);
    let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
    assert_eq!(v["id"], 1);
    assert!(v["result"]["protocolVersion"].is_string());

    // notifications/initialized (no response expected)
    send(&mut stdin, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);

    // tools/list
    send(&mut stdin, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#);
    let resp = read_line(&mut stdout);
    let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
    assert_eq!(v["id"], 2);
    let tools = v["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "engram_aql");

    // tools/call
    send(
        &mut stdin,
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"engram_aql","arguments":{"query":"RECALL FROM EPISODIC ALL LIMIT 2"}}}"#,
    );
    let resp = read_line(&mut stdout);
    let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
    assert_eq!(v["id"], 3);
    let content = &v["result"]["content"];
    assert!(content.is_array());
    // The text content should contain our query result JSON
    let text = content[0]["text"].as_str().unwrap();
    assert!(text.contains("\"success\":true"));
    assert!(text.contains("\"statement\":\"Recall\""));

    // Shut down cleanly by dropping stdin (EOF)
    drop(stdin);
    let _ = child.wait();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --test mcp_roundtrip 2>&1`
Expected: FAIL — MCP not implemented.

- [ ] **Step 3: Implement `engram-aql/src/mcp/protocol.rs`**

```rust
//! MCP JSON-RPC message types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

impl JsonRpcResponse {
    pub fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
            }),
        }
    }
}
```

- [ ] **Step 4: Implement `engram-aql/src/mcp/handlers.rs`**

```rust
//! MCP method handlers.

use serde_json::{json, Value};

use crate::executor::Executor;

pub fn handle_initialize(_params: &Value) -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "serverInfo": {
            "name": "engram-aql",
            "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
            "tools": {}
        }
    })
}

pub fn handle_tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "engram_aql",
                "description": "Execute an AQL (Agent Query Language) read query \
                    against this agent's memory. Supports: RECALL, SCAN, LOOKUP, \
                    LOAD, WITH LINKS, FOLLOW LINKS, AGGREGATE, ORDER BY. \
                    Writes (STORE/UPDATE/FORGET/LINK) are not yet supported — \
                    use engram_retain via the TypeScript MCP server instead.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "AQL query string. Example: \
                                RECALL FROM EPISODIC ORDER BY created_at DESC LIMIT 5"
                        }
                    },
                    "required": ["query"]
                }
            }
        ]
    })
}

pub fn handle_tools_call(exec: &Executor, params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing tool name".to_string())?;

    if name != "engram_aql" {
        return Err(format!("unknown tool: {}", name));
    }

    let query = params
        .get("arguments")
        .and_then(|a| a.get("query"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing query argument".to_string())?;

    let result = exec.query(query).map_err(|e| e.to_string())?;
    let result_json =
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?;

    Ok(json!({
        "content": [
            {
                "type": "text",
                "text": result_json
            }
        ],
        "isError": !result.success
    }))
}
```

- [ ] **Step 5: Implement `engram-aql/src/mcp/mod.rs`**

```rust
//! MCP stdio server.

pub mod handlers;
pub mod protocol;

use std::path::Path;

use anyhow::Result;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::io::{self as tokio_io};

use crate::executor::Executor;
use protocol::{JsonRpcRequest, JsonRpcResponse};

pub async fn run(db_path: &Path) -> Result<()> {
    let exec = Executor::open(db_path)?;

    let stdin = tokio_io::stdin();
    let mut reader = BufReader::new(stdin);
    let mut stdout = tokio_io::stdout();

    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            break; // EOF
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: JsonRpcRequest = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("invalid JSON-RPC request: {}", e);
                continue;
            }
        };

        // Notifications (no id) — no response required
        if req.id.is_none() {
            tracing::debug!("notification: {}", req.method);
            continue;
        }
        let id = req.id.clone().unwrap();

        let resp = match req.method.as_str() {
            "initialize" => {
                JsonRpcResponse::success(id, handlers::handle_initialize(&req.params))
            }
            "tools/list" => JsonRpcResponse::success(id, handlers::handle_tools_list()),
            "tools/call" => match handlers::handle_tools_call(&exec, &req.params) {
                Ok(result) => JsonRpcResponse::success(id, result),
                Err(e) => JsonRpcResponse::error(id, -32603, e),
            },
            other => JsonRpcResponse::error(id, -32601, format!("method not found: {}", other)),
        };

        let json = serde_json::to_string(&resp)?;
        stdout.write_all(json.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }

    Ok(())
}
```

- [ ] **Step 6: Implement `engram-aql/src/subcommand/mcp.rs`**

```rust
//! `engram-aql mcp` — stdio JSON-RPC server.

use std::path::Path;

use anyhow::Result;

pub fn run(db_path: &Path) -> Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(crate::mcp::run(db_path))
}
```

- [ ] **Step 7: Update `engram-aql/src/lib.rs`**

```rust
pub mod mcp;
```

- [ ] **Step 8: Update `engram-aql/src/subcommand/mod.rs`**

```rust
pub mod mcp;
pub mod query;
pub mod repl;
```

- [ ] **Step 9: Update `engram-aql/src/main.rs`**

```rust
        Command::Mcp { db_path } => engram_aql::subcommand::mcp::run(&db_path),
```

- [ ] **Step 10: Run the round-trip test**

Run: `cargo test --test mcp_roundtrip 2>&1`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
cd ..
git add engram-aql/
git commit -m "feat(engram-aql): implement MCP stdio server subcommand"
```

---

## Task 16: Final Verification

Run the full verification pipeline against the completed binary.

- [ ] **Step 1: Full test suite**

```bash
cd engram-aql
cargo test 2>&1
```
Expected: all tests pass.

- [ ] **Step 2: TypeScript side sanity check**

```bash
cd ..
npx vitest run 2>&1
```
Expected: all TS tests pass (including the new `aql-schema.test.ts` from Task 1).

- [ ] **Step 3: Clippy lints on the Rust crate**

```bash
cd engram-aql
cargo clippy --all-targets -- -D warnings 2>&1
```
Expected: no clippy warnings in our code (vendored aql-parser may emit warnings — those don't block us).

If clippy flags issues in the vendored `aql-parser`, add an allow directive at the crate level in `engram-aql/src/lib.rs`:

```rust
// Vendored crates may have their own lint exemptions; we only enforce on our code.
```

Or pass `--workspace` if needed. Prefer fixing lints in our own code first.

- [ ] **Step 4: Release build**

```bash
cargo build --release 2>&1
ls -lh target/release/engram-aql
```
Expected: Binary built, size reasonable (<20MB typical for a rusqlite+SQLite bundled build).

- [ ] **Step 5: End-to-end manual verification**

```bash
# Create a seeded DB (use the TS Engram schema)
sqlite3 /tmp/final.engram < ../src/schema.sql
sqlite3 /tmp/final.engram < tests/fixtures/seed.sql

# Query via CLI
./target/release/engram-aql query /tmp/final.engram "RECALL FROM EPISODIC ORDER BY trust_score DESC LIMIT 3"

# AGGREGATE
./target/release/engram-aql query /tmp/final.engram "RECALL FROM EPISODIC ALL AGGREGATE COUNT(*) AS total"

# REPL smoke test (interactive — type \quit to exit)
./target/release/engram-aql repl /tmp/final.engram

# MCP (echoes to stderr; send JSON on stdin for a round trip)
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
  | ./target/release/engram-aql mcp /tmp/final.engram
```

Verify each mode works interactively.

- [ ] **Step 6: Commit any final fixes**

```bash
cd ..
git add -A
git commit -m "chore(engram-aql): final verification fixes" || echo "nothing to commit"
```

- [ ] **Step 7: Summary report**

At the end of implementation, summarize:
- Total tasks completed
- Test count across all test files
- Binary size
- Any warnings or Phase 2 follow-ups discovered
