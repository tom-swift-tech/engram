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

**Reads, vector search, and delegated writes.** `STORE`/`UPDATE`/`FORGET`/
`REFLECT` are delegated to the TypeScript retain pipeline over the bridge —
Rust never writes the file itself (see [Writes](#writes) below). Only `LINK`
is rejected (no canonical TS manual-relation surface yet). Semantic search is
covered under [Vector search](#vector-search-like--pattern).

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

## Vector search (LIKE / PATTERN)

`RECALL` supports semantic search over chunk embeddings:

```bash
# Query text — embedded server-side, ranked by cosine distance (nearest first)
engram-aql query ./agent.engram 'RECALL FROM SEMANTIC LIKE $q' --var q='deployment rollback'

# Similarity floor: PATTERN ... THRESHOLD t keeps rows with similarity >= t
engram-aql query ./agent.engram 'RECALL FROM SEMANTIC PATTERN $q THRESHOLD 0.7' --var q='wal mode'

# Precomputed embedding — bound as a number array, used directly (no embed step)
engram-aql query ./agent.engram 'RECALL FROM SEMANTIC LIKE $q' --var q='[0.12, -0.03, ...]'
```

Results are ordered by `distance ASC` (a `distance` column is added to each row)
and compose with `WHERE`-free modifiers like `MIN_CONFIDENCE`, `WITH LINKS`,
`FOLLOW LINKS`, `RETURN`, and `LIMIT`. `LIKE`/`PATTERN` apply only to
chunks-backed memory (`SEMANTIC`/`EPISODIC`); on `PROCEDURAL`/`WORKING`/`TOOLS`
they return a warning (those tables store no embeddings).

Over MCP, bind variables with the `variables` argument:

```json
{ "name": "engram_aql",
  "arguments": { "query": "RECALL FROM SEMANTIC LIKE $q", "variables": { "q": "deployment rollback" } } }
```

### How embedding works (string variables)

A string variable must be embedded with the **same model** as the stored
vectors (`nomic-embed-text-v1.5`, with the `search_query:` prefix), or rankings
are meaningless. `engram-aql` does not embed in-process; it lazily spawns a warm
`engram-mcp` (TypeScript) child and calls its `engram_embed` tool. The child is
started **only** on the first string-variable query (a precomputed-array probe
or a pure read never spawns it).

`engram-mcp` is discovered in order:

1. `--engram-mcp-cmd <cmd>` flag
2. `ENGRAM_MCP_CMD` env var (may include args, e.g. `node /abs/path/dist/mcp-server.js`)
3. `engram-mcp` on `PATH`

The first string-variable query pays a one-time cold start (~3–5 s) while Node
loads the embedding model; subsequent queries in the same process reuse the warm
child. A native `vec_distance_cosine` scalar function (no `sqlite-vec`
dependency) does the ranking in Rust over the shared file.

## Writes

`STORE`/`UPDATE`/`FORGET`/`REFLECT` mutate memory, but `engram-aql` keeps its
own SQLite connection read-only. Each write is translated into a call to the
canonical TypeScript retain pipeline over the same `engram-mcp` bridge used for
embedding, so the full pipeline (dedup, embedding, FTS, extraction) runs exactly
as a direct `engram_retain` would. The Rust process never writes the file
itself; writes therefore need `engram-mcp` discoverable (see discovery order
above).

```bash
# STORE → engram_retain. Payload fields map to retain options; unspecified
# sourceType/trustScore inherit retain's defaults (inferred / 0.5).
engram-aql query ./agent.engram \
  'STORE INTO SEMANTIC (text = "Terraform manages cloud infra", source = "notes", trust_score = 0.9)'

# UPDATE → engram_supersede (old chunk soft-deleted, replaced by new text)
engram-aql query ./agent.engram \
  'UPDATE INTO SEMANTIC WHERE id = "<chunk-id>" (text = "corrected fact")'

# FORGET → engram_forget (soft-delete matched chunks)
engram-aql query ./agent.engram 'FORGET FROM SEMANTIC WHERE id = "<chunk-id>"'

# REFLECT → engram_reflect (global reflection cycle)
engram-aql query ./agent.engram 'REFLECT FROM EPISODIC ALL'
```

Notes:

- Writes target **chunk-backed memory only** (`SEMANTIC` → world, `EPISODIC` →
  experience). `PROCEDURAL`/`WORKING`/`TOOLS` are rejected.
- `UPDATE`/`FORGET` resolve their target ids with a read-only query first, then
  delegate per id; matching zero rows succeeds with a warning.
- `REFLECT` runs a global cycle — `source` filters and `THEN` clauses are not
  yet honored (warns when present).
- `LINK` is still rejected: relations are extraction-derived and there is no
  canonical TS surface for authoring them manually.
- After a delegated write, a subsequent `RECALL` on the same process sees the
  change immediately (cross-process SQLite WAL visibility).

## Architecture

Phase 1 (read surface): `../docs/superpowers/specs/2026-04-12-engram-aql-rust-binary-design.md`.
Phase 2 (writes + vector search): `../docs/superpowers/specs/2026-06-24-engram-aql-writes-and-vector-search-design.md`.
