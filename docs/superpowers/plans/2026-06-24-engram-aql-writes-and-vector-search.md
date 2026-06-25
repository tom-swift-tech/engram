# engram-aql Phase 2 — Writes & Vector Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `engram-aql` two capabilities deferred from Phase 1 — **query-side vector similarity** (`LIKE`/`PATTERN`) and **write statements** (`STORE`/`UPDATE`/`FORGET`/`REFLECT`) — without the Rust process ever writing to the `.engram` file or reproducing the TS embedding pipeline.

**Architecture:** Rust keeps its `SQLITE_OPEN_READ_ONLY` connection. Vector *distance* is computed in-process via a native `vec_distance_cosine` scalar function registered on the Rust connection (no `sqlite-vec` dependency). The one thing Rust cannot do itself — produce a model-compatible *query embedding*, and perform *writes* — is delegated to a lazily-spawned, warm `engram-mcp` (TypeScript) child over line-delimited JSON-RPC on stdio. This preserves the Phase 1 invariant: **TS owns every write and every embedding.**

**Tech Stack:** Rust 2021, existing crate deps + `tokio` `process` feature (child spawn) — **no new HTTP crate**. TS side: one additive MCP tool (`engram_embed`) in the existing `mcp-tools.ts` / `mcp-server.ts`.

**Spec:** `docs/superpowers/specs/2026-06-24-engram-aql-writes-and-vector-search-design.md`
**Extends:** `docs/superpowers/plans/2026-04-12-engram-aql-rust-binary.md` (Phase 1)

---

## Design decisions resolved in this plan (beyond the spec)

The spec is decided at the architecture level. Three lower-level decisions surfaced while reading the code; they are settled here so the tasks are unambiguous.

1. **`LIKE $var` / `PATTERN $var` bind to a *variable*, not inline text.** The AQL AST is `Predicate::Like { variable }` / `Predicate::Pattern { variable, threshold }` (`vendor/aql-parser/src/ast.rs:206-212`). `Executor::query(&self, aql: &str)` has no binding channel today. **Decision:** add a variables map (`BTreeMap<String, serde_json::Value>`) threaded executor → dispatch → handlers. Determinism matters in the SQL we emit, so `BTreeMap` (per project convention), not `HashMap`.

2. **What a bound variable resolves to.** **Decision: dispatch on the bound JSON value's type** —
   - **string** → send to the bridge `engram_embed` (mode `query`), get `[f32; dim]` back, use as the probe vector. (The spec's assumed path.)
   - **array of numbers** → use directly as a pre-computed probe vector, **skipping the Node bridge entirely** (no cold-start for callers who already embedded).
   This is a strict superset of the spec and gives a bridge-free read fast-path. A non-string/non-array binding (or a missing variable) is a user-facing `InvalidQuery` surfaced via `result.error`.

3. **The native cosine fn computes the full formula** (`1 - (a·b)/(‖a‖·‖b‖)`), not a unit-norm shortcut — bit-compatible with `sqlite-vec`'s `vec_distance_cosine` even for any non-normalized row, and it reads the vector dimension from the BLOB length / `bank_config`, never hard-coding 768 (spec Open Q3).

A worked sub-decision for **STORE field mapping** (AQL `STORE` AST → `engram_retain` options) is left as a contribution point in Task 8 — see the callout there.

---

## File Structure

New/modified files. Rust paths under `engram-aql/` unless noted.

| File | Action | Responsibility |
|------|--------|---------------|
| `src/mcp-tools.ts` | Modify | Add `engram_embed` tool definition + handler (text+mode → vector) |
| `src/mcp-server.ts` | Modify | Register `engram_embed` in the served tool list |
| `src/engram.ts` | Modify | Public `embedForMode(text, mode)` the tool can call (wraps embedder) |
| `src/retain.ts` | Modify (maybe) | Add `embedQuery` to the `EmbeddingProvider` interface if absent |
| `tests/mcp-server.test.ts` | Modify | `engram_embed` round-trip: query vs document prefix, dimensions |
| `src/bridge/mod.rs` | Create | Bridge module root |
| `src/bridge/client.rs` | Create | JSON-RPC stdio client (request/response framing, mirrors `mcp/mod.rs`) |
| `src/bridge/child.rs` | Create | `engram-mcp` child lifecycle: discovery, lazy spawn, respawn-on-crash |
| `src/bridge/embed.rs` | Create | `embed_query(text) -> Vec<f32>` over the bridge |
| `src/vector/mod.rs` | Create | Vector module root |
| `src/vector/codec.rs` | Create | LE-f32 BLOB ↔ `Vec<f32>` codec (dimension-agnostic) |
| `src/vector/cosine.rs` | Create | `register_vec_distance_cosine(&Connection)` scalar fn |
| `src/executor.rs` | Modify | Register cosine fn on open; add `query_with_vars`; hold an optional bridge handle |
| `src/statements/mod.rs` | Modify | Thread `vars` + bridge through `dispatch`; route writes to delegation (2b) |
| `src/statements/recall.rs` | Modify | Replace `VectorSearchDeferred` with the vector-search path |
| `src/statements/load.rs` | Modify | Same Like/Pattern wiring for `LOAD FROM TOOLS` |
| `src/statements/write_delegate.rs` | Create (2b) | AST → `engram_retain`/`_supersede`/`_forget`/`_reflect` over the bridge |
| `src/statements/write_reject.rs` | Modify (2b) | Keep only `LINK` rejection; remove the delegated arms |
| `src/mcp/handlers.rs` | Modify | `engram_aql` tool gains optional `variables` arg |
| `src/subcommand/query.rs` | Modify | `query` subcommand gains `--var name=value` (repeatable) |
| `Cargo.toml` | Modify | Add `process` feature to `tokio` |
| `tests/vector_cosine.rs` | Create | Native cosine fn unit tests vs known vectors |
| `tests/bridge_embed.rs` | Create | Bridge spawn + embed round-trip (gated on `engram-mcp` present) |
| `tests/vector_search.rs` | Create | `RECALL … LIKE`/`PATTERN` integration (gated on bridge) |
| `tests/write_delegate.rs` | Create (2b) | STORE/UPDATE/FORGET/REFLECT round-trips |
| `tests/aql-vector-equivalence.test.ts` (root) | Create | L2: TS `recall` vs AQL `RECALL … LIKE` identical ordering/ids |

---

# Phase 2a — Vector search (reads)

Recommended first: higher value, no writes, proves the bridge end-to-end.

## Task 1: TS — `engram_embed` MCP tool

Expose the bank's configured embedder over MCP so Rust can get a model-compatible query vector. Additive; no existing tool changes shape.

**Files:** Modify `src/engram.ts`, `src/mcp-tools.ts`, `src/mcp-server.ts`, possibly `src/retain.ts`. Test `tests/mcp-server.test.ts`.

- [ ] **Step 1: Confirm the embedder surface.** Read `src/retain.ts`'s `EmbeddingProvider` interface. `LocalEmbedder` already has `embed` (document) and `embedQuery` (query) (`src/local-embedder.ts:163-176`), but `OllamaEmbeddings` and the interface may only guarantee `embed`. If `embedQuery` is not on the interface, add it (default impl may fall back to `embed`). Record which embedders implement it.

- [ ] **Step 2: Add a public mode-aware embed method to `Engram`.** `Engram` holds `private readonly embedder` (`src/engram.ts:175`) and only exposes document-mode `embedText` (`:698`). Add:

  ```typescript
  /** Embed text for a given retrieval mode. `query` uses the query prefix
   *  (better recall for asymmetric models like nomic); `document` matches retain(). */
  async embedForMode(text: string, mode: 'query' | 'document'): Promise<Float32Array> {
    const e = this.embedder as { embedQuery?: (t: string) => Promise<Float32Array> };
    if (mode === 'query' && typeof e.embedQuery === 'function') {
      return e.embedQuery(text);
    }
    return this.embedder.embed(text);
  }
  ```
  (Read `engram.ts` around `:698` first and match the surrounding style; fix the placeholder identifier above.)

- [ ] **Step 3: Write the failing test** in `tests/mcp-server.test.ts` — call the `engram_embed` handler with `{ text: 'deploy pipeline', mode: 'query' }` and assert: `dimensions` equals the bank's embedder dim (768 for default nomic), `embedding.length === dimensions`, all finite numbers, and that `mode: 'query'` vs `mode: 'document'` produce **different** vectors for a prefix-using model (proves the prefix is applied). Run: `npx vitest run tests/mcp-server.test.ts` → FAIL (tool absent).

- [ ] **Step 4: Add the tool definition + handler in `src/mcp-tools.ts`.** Mirror the existing `engram_recall` entry (`:87`). Shape:

  ```typescript
  {
    name: 'engram_embed' as const,
    description:
      'Embed text into the bank\'s native vector space. mode="query" applies the query prefix (for similarity search); mode="document" matches how retain() stores text. Used by engram-aql for AQL LIKE/PATTERN vector search.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to embed' },
        mode: { type: 'string', enum: ['query', 'document'], description: 'query | document (default query)' },
      },
      required: ['text'],
    },
  }
  ```
  Handler:
  ```typescript
  // engram_embed
  const mode = (args.mode === 'document' ? 'document' : 'query') as 'query' | 'document';
  const vec = await engram.embedForMode(String(args.text ?? ''), mode);
  return { embedding: Array.from(vec), dimensions: vec.length };
  ```
  Match the file's existing arg-validation/clamp helpers. Register the name in `src/mcp-server.ts`'s served list exactly as the other tools are.

- [ ] **Step 5:** Run the test → PASS. Then `npx vitest run` (full suite) → no regressions (`engram_embed` is additive).

- [ ] **Step 6: Commit** — `feat(mcp): add engram_embed tool for AQL query-side vector search`.

---

## Task 2: Rust — vector codec + native cosine scalar fn

Pure, dependency-free, fully unit-testable without the bridge. Do this before the bridge so the SQL path is provable in isolation.

**Files:** Create `src/vector/mod.rs`, `src/vector/codec.rs`, `src/vector/cosine.rs`; modify `src/lib.rs`, `src/executor.rs`. Test `tests/vector_cosine.rs`.

- [ ] **Step 1: Write the failing test** `tests/vector_cosine.rs`:
  - `codec` round-trips a `Vec<f32>` through `encode_f32_le` / `decode_f32_le` (assert equality, and that a 768-vec yields a 3072-byte BLOB).
  - On an in-memory `Connection` with `register_vec_distance_cosine` installed: `SELECT vec_distance_cosine(?, ?)` returns **0.0** for identical vectors, **1.0** for orthogonal, **2.0** for antiparallel (within `1e-6`), for both normalized and **non-normalized** inputs (proves full-formula correctness).
  - A length-mismatch (768 vs 384) returns a SQLite error, not a panic.

  Run: `cargo test --test vector_cosine` → FAIL (module absent).

- [ ] **Step 2: Implement `src/vector/codec.rs`** — dimension-agnostic:
  ```rust
  //! LE-f32 BLOB codec. Matches the TS storage format
  //! (`Buffer.from(Float32Array.buffer)` — little-endian f32, no header).

  pub fn encode_f32_le(v: &[f32]) -> Vec<u8> {
      let mut out = Vec::with_capacity(v.len() * 4);
      for x in v { out.extend_from_slice(&x.to_le_bytes()); }
      out
  }

  /// Decode a LE-f32 BLOB. Returns None if the byte length isn't a multiple of 4.
  pub fn decode_f32_le(bytes: &[u8]) -> Option<Vec<f32>> {
      if bytes.len() % 4 != 0 { return None; }
      Some(bytes.chunks_exact(4)
          .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
          .collect())
  }
  ```

- [ ] **Step 3: Implement `src/vector/cosine.rs`**:
  ```rust
  //! Native `vec_distance_cosine(a_blob, b_blob)` — cosine DISTANCE in [0, 2].
  //! No sqlite-vec dependency; bit-compatible with sqlite-vec for any input.

  use rusqlite::functions::FunctionFlags;
  use rusqlite::{Connection, Error, Result};

  use crate::vector::codec::decode_f32_le;

  pub fn register_vec_distance_cosine(conn: &Connection) -> Result<()> {
      conn.create_scalar_function(
          "vec_distance_cosine",
          2,
          FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
          |ctx| {
              let a = ctx.get_raw(0).as_blob().map_err(|e| Error::UserFunctionError(Box::new(e)))?;
              let b = ctx.get_raw(1).as_blob().map_err(|e| Error::UserFunctionError(Box::new(e)))?;
              let av = decode_f32_le(a).ok_or_else(|| Error::UserFunctionError("operand a is not a LE-f32 blob".into()))?;
              let bv = decode_f32_le(b).ok_or_else(|| Error::UserFunctionError("operand b is not a LE-f32 blob".into()))?;
              if av.len() != bv.len() {
                  return Err(Error::UserFunctionError(
                      format!("vector dim mismatch: {} vs {}", av.len(), bv.len()).into()));
              }
              let (mut dot, mut na, mut nb) = (0f64, 0f64, 0f64);
              for i in 0..av.len() {
                  let (x, y) = (av[i] as f64, bv[i] as f64);
                  dot += x * y; na += x * x; nb += y * y;
              }
              if na == 0.0 || nb == 0.0 { return Ok(1.0); } // zero vector → max-ish distance
              Ok(1.0 - dot / (na.sqrt() * nb.sqrt()))
          },
      )
  }
  ```
  Create `src/vector/mod.rs` (`pub mod codec; pub mod cosine;`) and export from `lib.rs`.

  > **`create_scalar_function` on a READ_ONLY connection is allowed** — scalar functions don't mutate the database; they only run during query evaluation. This keeps the Phase 1 write-discipline intact.

- [ ] **Step 4: Register the fn on open.** In `src/executor.rs::open`, after `Connection::open_with_flags(...)` and `busy_timeout(...)`, before `from_connection`, call `crate::vector::cosine::register_vec_distance_cosine(&conn)?;`. Also register it in `from_connection` so in-memory test connections get it (move the call into `from_connection`, before `verify_schema`, so both paths share it).

- [ ] **Step 5:** `cargo test --test vector_cosine` → PASS. `cargo test` → no regressions.

- [ ] **Step 6: Commit** — `feat(engram-aql): native vec_distance_cosine scalar fn + LE-f32 codec`.

---

## Task 3: Rust — the embed/write bridge (JSON-RPC stdio client)

A persistent `engram-mcp` child + a JSON-RPC client that mirrors the existing server loop (`src/mcp/mod.rs`: line-delimited JSON, `\n` framing). Lazy: spawned only on first vector query (string-bound) or first write.

**Files:** Create `src/bridge/{mod,client,child,embed}.rs`; modify `Cargo.toml`, `src/lib.rs`. Test `tests/bridge_embed.rs`.

- [ ] **Step 1: Cargo.** Add the `process` feature to `tokio` (already a dep): `features = ["macros", "rt-multi-thread", "io-std", "io-util", "sync", "process"]`. No HTTP crate.

- [ ] **Step 2: Child lifecycle (`src/bridge/child.rs`).**
  - **Discovery** in order: (1) `--engram-mcp-cmd <path>` flag (plumb later), (2) `ENGRAM_MCP_CMD` env, (3) `engram-mcp` on `PATH`. Fail with an actionable message naming all three when absent (mirror Phase-1 schema-error UX).
  - **Spawn** via `tokio::process::Command` with the same `<db>` path, `stdin`/`stdout` = `piped()`, `stderr` = `inherit()` (TS diagnostics flow to the user). Send the MCP `initialize` request, await the response.
  - **Respawn:** on a broken pipe / EOF, surface a clear error and allow **one** respawn before giving up.

- [ ] **Step 3: Client (`src/bridge/client.rs`).** Reuse `crate::mcp::protocol::{JsonRpcRequest, JsonRpcResponse}`. A monotonic request-id counter; `call(method, params) -> Result<Value>`: serialize request + `\n`, flush to child stdin, `read_line` from child stdout, parse `JsonRpcResponse`, return `result` or map `error` to an `AqlError`. Single-threaded sequential use (matches the server's own model) — no need for response multiplexing.

- [ ] **Step 4: Embed helper (`src/bridge/embed.rs`).** `embed_query(client, text) -> AqlResult<Vec<f32>>`: `tools/call` with `{ name: "engram_embed", arguments: { text, mode: "query" } }`, parse the returned tool content (the TS handler returns `{ embedding: number[], dimensions }`; note `engram-mcp`'s `tools/call` wraps it as `content:[{type:"text", text:<json>}]` — parse that inner JSON), map `embedding` → `Vec<f32>`.

- [ ] **Step 5: Write the gated round-trip test** `tests/bridge_embed.rs`: skip with an explanatory `eprintln!` + early return if `engram-mcp` is not discoverable (CI without the built TS bin must stay green — same gating philosophy as the L3 cross-process suite). When present: build a temp `.engram` via the TS path is out of scope here, so point the bridge at a fixture DB and assert `embed_query(client, "deploy")` returns a 768-len vec of finite f32. Run `cargo test --test bridge_embed`.

- [ ] **Step 6: Commit** — `feat(engram-aql): warm engram-mcp bridge (JSON-RPC stdio client + lazy child)`.

> **Cold-start note for docs:** first string-bound vector query spawns Node + loads the embedder (~3–5 s, one-time per `engram-aql` process; amortized in `mcp`/`repl`, unavoidable for one-shot `query`). Array-bound probes skip this entirely (decision 2).

---

## Task 4: Rust — thread variables + bridge through the executor

Add the binding channel decision-1 requires, without breaking the existing `query(&self, aql)` callers.

**Files:** Modify `src/executor.rs`, `src/statements/mod.rs`.

- [ ] **Step 1:** Add an execution context the handlers receive. Rather than widen every handler signature ad hoc, introduce a small `ExecCtx<'a> { conn: &'a Connection, vars: &'a BTreeMap<String, serde_json::Value>, bridge: &'a BridgeHandle }` and pass `&ExecCtx` to `dispatch`. `BridgeHandle` wraps a lazily-initialized `Option<Client>` behind interior mutability (`std::cell::RefCell`, single-threaded) with a `fn embed_query(&self, text) -> AqlResult<Vec<f32>>` that spawns-on-first-use.

- [ ] **Step 2:** `Executor` keeps the bridge handle + the `engram-mcp` command resolution. Add `query_with_vars(&self, aql, vars: BTreeMap<String, Value>)`; make the existing `query(&self, aql)` delegate with an empty map (back-compat — all current tests/subcommands keep working). Update `statements::dispatch` to take `&ExecCtx` and pass it down; read-only handlers that ignore vars/bridge just don't touch them.

- [ ] **Step 3:** `cargo test` → existing suite still green (no behavior change yet; pure plumbing).

- [ ] **Step 4: Commit** — `refactor(engram-aql): thread variables + bridge handle through dispatch (ExecCtx)`.

---

## Task 5: Rust — wire `LIKE`/`PATTERN` in RECALL

Replace the `WhereResult::VectorSearchDeferred` seam (`src/statements/recall.rs:18-21, 64-66, 100-108, 311-318`) with the real path.

**Files:** Modify `src/statements/recall.rs`. Test `tests/vector_search.rs`.

- [ ] **Step 1:** Change the enum to carry the bound probe: `VectorSearch { probe: Vec<f32>, threshold: Option<f32> }`. In `build_where_clause`, the `Like { variable } | Pattern { variable, threshold }` arm:
  1. look up `variable` in `ctx.vars` → `InvalidQuery` if missing;
  2. **string** value → `ctx.bridge.embed_query(s)?`; **array** of numbers → map to `Vec<f32>` directly; else `InvalidQuery`;
  3. return `VectorSearch { probe, threshold }` (Pattern carries its threshold; Like → `None`).

- [ ] **Step 2:** In `execute`, the `VectorSearch` branch builds the same SQL the TS side uses — bind the probe BLOB (`encode_f32_le`) and add a distance column + ordering:
  ```sql
  SELECT *, vec_distance_cosine(embedding, ?) AS distance
  FROM chunks
  WHERE is_active = 1 [AND memory_type = ?] [AND <other WHERE parts>]
  [AND vec_distance_cosine(embedding, ?) <= ?]   -- only when THRESHOLD present: distance = 1 - similarity
  ORDER BY distance ASC
  LIMIT <n>
  ```
  The probe binds **twice** when a threshold is present (SELECT column + WHERE filter) — push it to `params` accordingly. Threshold semantics: AQL `THRESHOLD 0.7` is a *similarity* floor, so filter `distance <= 1 - 0.7`. Compose with any structured `WHERE`/`ORDER`/`LIMIT`/`WITH LINKS` already supported — **this composition is the actual value-add over calling TS `engram_recall`.** Note: an explicit `ORDER BY` in the query should override distance ordering only if the user gave one; default to `distance ASC`.

- [ ] **Step 3: Write `tests/vector_search.rs`** (gated on bridge present, like Task 3): seed chunks with **real** embeddings (obtained via the bridge `engram_embed` mode=document, so they're model-compatible), then run `RECALL FROM SEMANTIC LIKE $q` with `vars = {"q": "<text>"}` and assert the nearest chunk ranks first. Add an **array-bound** case: pass `vars = {"q": [<768 floats>]}` and assert it returns without spawning the bridge (probe used directly). Add a `PATTERN $q THRESHOLD 0.9` case asserting low-similarity rows are filtered out.

- [ ] **Step 4:** `cargo test --test vector_search` → PASS (when bridge present). `cargo test` → green.

- [ ] **Step 5: Commit** — `feat(engram-aql): wire LIKE/PATTERN vector search in RECALL`.

---

## Task 6: Rust — wire `LIKE`/`PATTERN` in LOAD; expose vars in MCP + CLI

**Files:** Modify `src/statements/load.rs` (`:33-39`), `src/mcp/handlers.rs`, `src/subcommand/query.rs`.

- [ ] **Step 1: LOAD.** Apply the same probe-resolution + distance-ordering to `LOAD FROM TOOLS` (tools embeddings only exist if the bank stores them; if `tools.embedding` is absent/NULL, return a clear warning rather than garbage — check the `tools` schema first and gate on an embedding column existing). Replace the deferral at `:33-39`.

- [ ] **Step 2: MCP tool arg.** In `src/mcp/handlers.rs`, `engram_aql`'s `inputSchema` gains an optional `variables` object (`{ "type": "object", "additionalProperties": true }`); `handle_tools_call` parses it into a `BTreeMap<String, Value>` and calls `exec.query_with_vars`. Update the tool description to mention `LIKE $var` / `PATTERN $var` with `variables`.

- [ ] **Step 3: CLI.** `engram-aql query <db> <aql>` gains a repeatable `--var name=value` (value parsed as JSON, falling back to a string literal). Build the map, call `query_with_vars`.

- [ ] **Step 4:** Update `tests/mcp_roundtrip.rs` (or add a case) for a `variables`-carrying `tools/call`. `cargo test` → green.

- [ ] **Step 5: Commit** — `feat(engram-aql): LIKE/PATTERN for LOAD + variables in MCP/CLI`.

---

## Task 7: L2 cross-process equivalence + docs (closes 2a)

**Files:** Create `tests/aql-vector-equivalence.test.ts` (root TS). Modify `README.md`, the Phase-1 spec status line, `tasks/todo.md`, `CLAUDE.md` + `AGENTS.md`.

- [ ] **Step 1:** Extend the L2 suite (the `tests/aql-*.test.ts` family, gated on `cargo`): TS `retain`s several chunks into a temp `.engram`, then for a fixed query asserts **identical ordering and ids** between TS `engram.recall(q)` (semantic strategy) and AQL `RECALL FROM SEMANTIC LIKE $q WITH variables {q}` run through the Rust binary. This is the embedding-equivalence guard the spec calls out (native cosine must match `sqlite-vec`).

- [ ] **Step 2: Docs.** README: document `LIKE`/`PATTERN`, the `variables` arg, the `engram-mcp` discovery order, and the cold-start cost. Flip the Phase-1 spec's "Phase 2 deferred" note for vector search. Update `tasks/todo.md` (check off 2a). Update **both** `CLAUDE.md` and `AGENTS.md` together (the engram-aql section + dependency notes) — they are verbatim mirrors; CI diffs them.

- [ ] **Step 3:** Full gate: `npm test` (root), `cd integrations/pi && npx vitest run`, `cargo test` (engram-aql), `cargo fmt --check`, `cargo clippy`. All green.

- [ ] **Step 4: Commit** — `feat(engram-aql): Phase 2a vector search — equivalence tests + docs`. Open/refresh the PR.

---

# Phase 2b — Write statements

Reuses the Task 3 bridge. `LINK` stays rejected (no canonical TS surface — spec Open Q1).

## Task 8: Write delegation handlers

**Files:** Create `src/statements/write_delegate.rs`; modify `src/statements/mod.rs`, `src/statements/write_reject.rs`. Test `tests/write_delegate.rs`.

- [ ] **Step 1:** `write_delegate.rs` translates each write AST → a bridge `tools/call`:

  | AQL | TS tool | Mapping notes |
  |-----|---------|---------------|
  | `STORE` | `engram_retain` | text, memory_type, source, source_type, trust, context |
  | `UPDATE` | `engram_supersede` | target id + new text |
  | `FORGET` (by id) | `engram_forget` | id |
  | `FORGET WHERE …` | RO read → ids → per-id `engram_forget` | resolve ids on the RO conn first |
  | `REFLECT` | `engram_reflect` | LLM cycle stays TS-side |

  > **★ Contribution point — STORE field mapping.** The AQL `STORE` AST → `engram_retain` options mapping has real choices: which AQL field supplies `memoryType`, what `sourceType`/`trustScore` defaults a Rust-originated write should carry (a write arriving via AQL has different provenance than a user-stated retain — arguably `agent_generated`/lower trust), and how to surface unmapped fields. Implement `store_to_retain_args(stmt: &StoreStmt) -> serde_json::Value` (~8–12 lines) and document the provenance default you chose and why. Read `src/mcp-tools.ts`'s `engram_retain` schema first for the exact option names.

- [ ] **Step 2:** In `src/statements/mod.rs::dispatch`, route `Store/Update/Forget/Reflect` to `write_delegate` (passing `&ExecCtx`); leave only `Link` on `write_reject::reject`. Trim `write_reject.rs` to the `Link` arm.

- [ ] **Step 3: Write `tests/write_delegate.rs`** (gated on bridge): `STORE` via AQL, then assert a TS `recall`/AQL `RECALL` sees the new chunk **fully embedded and FTS-indexed** (proves the full retain pipeline ran TS-side, not a bare insert). `FORGET` an id and assert it drops from active results. **WAL-visibility check** (spec Open Q2): after a delegated write, a subsequent Rust read on the same `Executor` must see the committed row — assert this; if the RO snapshot lags, refresh the connection after a delegated write.

- [ ] **Step 4:** `cargo test` green; `cargo fmt --check`; `cargo clippy`.

- [ ] **Step 5: Commit** — `feat(engram-aql): Phase 2b write delegation (STORE/UPDATE/FORGET/REFLECT)`.

## Task 9: Docs + close-out

- [ ] Update README (writes now supported, `LINK` still deferred + why), Phase-1 spec status, `tasks/todo.md`, and **both** `CLAUDE.md`/`AGENTS.md`. Note the `LINK` open question and the transactional-`PIPELINE` caveat (spec Open Q2) as remaining work. Commit — `docs: engram-aql Phase 2b writes`.

---

## Risks & gates (carried from the spec)

- **Embedding-equivalence drift** — Task 7's L2 vector-equivalence test is the guard; it must stay green on every change to the codec or cosine fn.
- **Bridge coupling** — discovery (flag/env/PATH) with an actionable failure message; bridge tests gate on `engram-mcp` presence so CI without the built TS bin stays green (same model as the existing L3 suite).
- **Cold-start** — documented; array-bound probes and `mcp`/`repl` sessions amortize it.
- **`LINK` gap** — keep rejecting with a pointer until a canonical TS manual-relation surface exists (separate spec if pursued).
- **WAL visibility after writes** — explicitly tested in Task 8; refresh the RO snapshot if a lag shows up.

## Verification pipeline (every task)

`cargo test` (engram-aql) + `cargo fmt --check` + `cargo clippy` for Rust tasks; `npx vitest run` (root) and `cd integrations/pi && npx vitest run` for TS tasks. No task is "done" until its tests pass and the relevant suite is green. Never mark complete without showing the run.
