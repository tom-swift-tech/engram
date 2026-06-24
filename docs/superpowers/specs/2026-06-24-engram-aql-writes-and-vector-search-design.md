# engram-aql Phase 2 — Writes & Vector Search — Design

**Date:** 2026-06-24
**Status:** Decided (design pass; implementation deferred to a plan)
**Repo:** swift-innovate/engram
**Extends:** `2026-04-12-engram-aql-rust-binary-design.md` (Phase 1, read-only) — specifically its "Open Questions (Phase 2 Scope)" items 1 (writes), 2 (vector search), and 3 (REFLECT trigger).

## Summary

Phase 1 ships `engram-aql` as a **read-only** Rust binary sharing the `.engram` file with TypeScript Engram over WAL. Phase 2 adds the two deferred capabilities — **query-side vector similarity** (`LIKE`/`PATTERN`) and **write statements** (`STORE`/`UPDATE`/`FORGET`/`LINK`/`REFLECT`).

Both reduce to one question: *how does the Rust process reach the TypeScript embedding + retain pipeline?* The decision:

1. **Rust keeps its DB connection `SQLITE_OPEN_READ_ONLY` and never writes.** Writes are *delegated* to the canonical TS retain pipeline.
2. **Vector search runs entirely in Rust** using a **native `vec_distance_cosine` scalar function** (no `sqlite-vec` extension, no vendored ONNX) — Rust needs only the *query embedding* from TS.
3. The single TS↔Rust dependency is a **warm embed/write channel**: `engram-aql` lazily spawns a persistent `engram-mcp` (TS) child and speaks MCP/JSON-RPC to it for (a) a new `engram_embed` tool and (b) the existing `engram_retain`/`engram_supersede`/`engram_forget` write tools.

This preserves the Phase 1 invariant — **TS owns every write** — even for AQL writes, with zero duplication of the retain pipeline and no risk of Rust corrupting the shared file.

## The decisive constraint: embedding compatibility

A chunk is only semantically recallable if `chunks.embedding` holds a vector **produced by the same model as every other vector in the file** — `nomic-embed-text-v1.5`, mean-pooled, L2-normalized, with the asymmetric prefix (`search_document:` for stored text, `search_query:` for queries). A query embedded by any other model/impl/prefix returns garbage rankings.

This single fact decides everything:

- It kills **"Rust writes directly, skipping embedding"** — the chunk would have a NULL/foreign vector and be invisible to semantic recall. Silent data corruption.
- It kills **"embed natively in Rust" (candle/ONNX)** — not on effort grounds but compatibility: reproducing `@huggingface/transformers`' exact output byte-for-byte is a maintenance trap, and any drift silently degrades recall.
- It forces **every write and every vector query through the TS embedder** — which is exactly what the bridge provides.

(If a bank is configured with `useOllamaEmbeddings: true`, the embedder is Ollama's HTTP `/api/embed`. Rust *could* call Ollama directly in that case — see "Optimization" below — but the universal path is the TS bridge, because `engram-mcp` always uses whatever embedder the bank was built with.)

## What the investigations established

**TS pipeline (`retain.ts`, `recall.ts`, `engram.ts`, `local-embedder.ts`):**
- Ordered write side-effects: text_hash dedup → `embedder.embed(text)` (Float32Array) → INSERT `chunks` (embedding stored as `Buffer.from(fa.buffer)`, a 768×4 = 3072-byte LE-f32 BLOB) → FTS5 trigger `chunks_ai` (automatic) → Tier-1 CPU entity extraction (sync, in-txn) → `extraction_queue` enqueue → commit.
- **No `vec0` virtual table.** Semantic recall is `SELECT …, vec_distance_cosine(c.embedding, ?) AS distance FROM chunks WHERE … ORDER BY distance ASC LIMIT ?`. `vec_distance_cosine` is a scalar registered by `sqlite-vec`'s `mod.load(db)`.
- Query vectors use `embedQuery()` → `search_query:` prefix; document vectors use `search_document:`.
- Minimum for recall: the embedding BLOB (semantic) + the FTS trigger (automatic). Graph is optional, queue-driven.

**Rust side (`engram-aql/`):**
- Connection is `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX` (`executor.rs:34`); a stray write fails at the SQLite layer.
- `rusqlite` 0.31 (`bundled`, `chrono`, `serde_json`) — **no `sqlite-vec`**, no vector code beyond stubs.
- `LIKE`/`PATTERN` already parse and return `WhereResult::VectorSearchDeferred` (`statements/recall.rs:64-66`; same in `load.rs`) — the seam is pre-cut.
- Writes reject at `dispatch()` (`statements/mod.rs:31-35` → `write_reject::reject()`).
- **No outbound capability today:** no `reqwest`/`hyper`, no `std::process::Command`, no MCP *client* — only an MCP *server*. `tokio` is present (used for the MCP stdio loop); `query`/`repl` are sync.

## Architecture

```
 engram-aql (Rust, RO connection)              engram-mcp (TS child, RW connection)
 ┌───────────────────────────────┐            ┌──────────────────────────────────┐
 │ reads: RECALL/SCAN/LOOKUP/...  │            │ canonical writer — full retain    │
 │   → SQL on RO conn             │            │ pipeline (dedup, embed, FTS,      │
 │                                │            │ Tier-1 extract, queue)            │
 │ vector search:                 │            │                                   │
 │   native vec_distance_cosine   │            │ engram_retain / _supersede /      │
 │   scalar fn (pure Rust) +      │            │   _forget   (existing)            │
 │   query embedding ───────────────MCP/JSON-RPC──▶ engram_embed (NEW: text+mode  │
 │                                │  (stdio)   │                → [f32;768])       │
 │ writes: translate AQL AST ───────────────────▶ engram_reflect (existing)       │
 │   → MCP tool call              │            │                                   │
 │                                │            │ opens the SAME .engram (RW)       │
 │ lazy-spawns + keeps child warm │◀───────────┘ writes land via WAL; Rust reads  │
 └───────────────────────────────┘              them on its RO snapshot            │
            shares .engram file (WAL: one writer, many readers)
```

### Component 1 — Vector search (reads)

1. Register a native scalar function on the Rust connection:
   `conn.create_scalar_function("vec_distance_cosine", 2, …, |a_blob, b_blob| { … })`.
   Decode each BLOB as `&[u8]` → `Vec<f32>` (`f32::from_le_bytes` over 4-byte chunks); return cosine **distance** `1 - (a·b)/(‖a‖·‖b‖)`. Computing the full formula (not assuming unit norm) makes it bit-compatible with `sqlite-vec` even for non-normalized rows.
2. On a `LIKE $q` / `PATTERN $q` predicate, fetch the query embedding for `$q` from the bridge (`engram_embed`, mode `query`), encode the returned `[f32;768]` to a LE-f32 BLOB, bind it as the parameter, and emit the same recall SQL the TS side uses (`… vec_distance_cosine(c.embedding, ?) AS distance … ORDER BY distance ASC LIMIT ?`).
3. Replace the `WhereResult::VectorSearchDeferred` branch in `recall.rs`/`load.rs` with this path. AQL's structured `WHERE`/`ORDER`/`LIMIT`/`WITH LINKS` compose with the distance ordering in one query — the actual value-add over calling TS `engram_recall`.

**No `sqlite-vec` dependency, no extension binary to ship.** The only new input is the query embedding.

### Component 2 — Write delegation

Rust parses the write AST, then calls the canonical TS tool over the bridge — it never touches the DB:

| AQL statement | Delegated TS MCP tool | Notes |
|---------------|----------------------|-------|
| `STORE` | `engram_retain` | Map AQL fields → retain options (text, memory_type, source, trust). Full pipeline runs TS-side. |
| `UPDATE` | `engram_supersede` | Supersede semantics (new chunk + `superseded_by` link). |
| `FORGET` | `engram_forget` | Soft-delete by id. AQL `FORGET WHERE …` resolves ids via a Rust read first, then forgets each. |
| `REFLECT` | `engram_reflect` | LLM cycle stays TS-side. |
| `LINK` | — (deferred) | No canonical TS tool: entities/relations are extraction-derived, not user-authored. Manual `LINK` needs its own TS surface; see Open Questions. |

The read-only connection stays read-only; the SQLite-layer guard from Phase 1 remains a backstop.

### The bridge

- **Transport:** `engram-aql` spawns `engram-mcp <db>` as a child via `tokio::process::Command`, piping stdin/stdout, and speaks the same JSON-RPC it already implements as a server (so the wire format is known). Persistent for the process lifetime → the embedder loads once and stays warm.
- **Lazy + lifecycle:** spawned on first write or first vector query only (a pure-read session never pays for it, preserving Phase-1 behavior and startup cost). On child crash, surface a clear error and allow one respawn.
- **Binary discovery:** resolve `engram-mcp` from (1) `--engram-mcp-cmd <path>` flag, (2) `ENGRAM_MCP_CMD` env, (3) `engram-mcp` on `PATH`. Fail with an actionable message if absent (the same UX as Phase-1 schema errors).
- **New Rust deps:** add the `process` feature to the existing `tokio`; reuse `serde_json`. **No HTTP crate.** A small JSON-RPC *client* loop mirrors the existing server loop.
- **New TS surface:** add an `engram_embed` tool to `mcp-tools.ts` — input `{ text: string, mode: 'query' | 'document' }`, output `{ embedding: number[], dimensions: number }`. It calls the bank's configured embedder with the correct prefix. ~30 lines, additive, no breaking change.

## Phasing

- **Phase 2a — Vector search (reads).** Build the bridge + `engram_embed` + native cosine fn + wire `LIKE`/`PATTERN` in `recall.rs`/`load.rs`. Higher value (semantic AQL is the compelling feature), lower risk (no writes), and it proves the bridge end-to-end. **Recommended first.**
- **Phase 2b — Writes.** Reuse the same bridge: `STORE`/`UPDATE`/`FORGET`/`REFLECT` delegate to TS tools; remove their `write_reject` arms. `LINK` and any manual-graph editing tracked separately.

## Risks & mitigations

- **Cold-start latency.** First vector query / first write spawns Node + loads the embedder (~3–5 s, one-time per `engram-aql` process). Amortized for `mcp`/`repl`; unavoidable for one-shot `query`. Document it; lazy-spawn keeps pure-read paths free.
- **Embedding-equivalence drift.** The native cosine fn must match `sqlite-vec`. Extend the existing L2 TS↔Rust equivalence suite (`tests/aql-*.test.ts`) with a vector-query case: store a chunk via TS, run the same semantic query through TS `recall` and AQL `RECALL … LIKE`, assert identical ordering/ids.
- **Binary coupling.** `engram-aql` must locate `engram-mcp`. Handled via flag/env/PATH discovery with a clear failure message.
- **`LINK` gap.** Deferred deliberately — no canonical TS write path for manual relations. Keep rejecting `LINK` with a pointer until a TS surface exists.
- **Double-open / WAL.** Two processes open the file (TS RW child + Rust RO). This is the Phase-1 cross-process model; WAL guarantees one writer / many readers. No new concurrency surface.

## Optimization (post-2a, optional)

When `bank_config` indicates Ollama embeddings, Rust can call Ollama's `/api/embed` directly (add `reqwest`), skipping the Node child for vector queries. Writes still go through TS (the retain pipeline is more than embedding). Treat as a latency optimization, not core scope — the TS bridge is universal because `engram-mcp` always uses the bank's own embedder.

## Task decomposition (for the implementation plan)

**Phase 2a**
1. TS: add `engram_embed` to `mcp-tools.ts` + `mcp-server.ts`; unit-test prefix/mode handling.
2. Rust: JSON-RPC client + `tokio::process` child manager (spawn, framing, lazy init, respawn-on-crash, binary discovery).
3. Rust: native `vec_distance_cosine` scalar fn + LE-f32 BLOB codec; unit-test against known vectors.
4. Rust: wire `LIKE`/`PATTERN` in `recall.rs` + `load.rs` (replace `VectorSearchDeferred`); compose with WHERE/ORDER/LIMIT.
5. Tests: extend `tests/aql-*.test.ts` L2 suite with vector-query equivalence (TS recall vs AQL RECALL).
6. Docs: README + the Phase-1 spec's status; note the embedder warm-up cost.

**Phase 2b**
7. Rust: write-statement handlers translating AST → `engram_retain`/`_supersede`/`_forget`/`_reflect` calls; remove their `write_reject` arms.
8. Rust: `FORGET WHERE …` → resolve ids via RO read, then per-id forget.
9. Tests: write round-trips (AQL STORE → TS recall sees it, fully embedded + FTS-indexed).
10. Decide `LINK` (manual-relation TS surface) — separate spec if pursued.

## Open questions (beyond Phase 2)

1. **`LINK` semantics** — does manual entity/relation authoring belong in Engram at all, given the extraction pipeline owns the graph? If yes, it needs a TS tool first.
2. **Transactional AQL `PIPELINE` mixing reads + writes** — a pipeline that writes then reads its own write must account for WAL visibility lag between the TS child's commit and the Rust RO snapshot. Likely: re-open/refresh the RO snapshot after a delegated write.
3. **Embedding dimension drift** — `bank_config.embed_dimensions` may differ from 768 (MiniLM is 384). The BLOB codec and native cosine fn must read the dimension from `bank_config`, not hard-code 768.
