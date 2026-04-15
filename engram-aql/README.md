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

Opens an interactive prompt for running AQL queries and inspecting results.

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
