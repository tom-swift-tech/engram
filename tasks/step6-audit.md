# Step 6 Audit — Consolidate Before Expanding (findings, 2026-07-14)

Read-only audit. No code changed. Answers the two Step-6 questions with
filesystem evidence so the keep/cut/defer calls can be made from fact.

## Q1 — The "single-file, git-committable `.engram`" premise

**Verdict: already resolved in this repo. No action needed.**

| Check | Result |
|-------|--------|
| `.engram` / `.db` / `.sqlite` files tracked in git | **0** |
| `.gitignore` coverage | `*.engram`, `*.engram-wal`, `*.engram-shm`, `*.db*`, `*.sqlite*`, `.engram/` dir — all ignored |
| `.git` directory size | **13 MB** (healthy — no DB blobs ever committed) |
| Largest packed git blobs | ~220 KB (source/docs) — no multi-MB binaries |

The "329 MB live + 897 MB snapshots" figures in the handoff describe a **live
consumer store** (operator-owned runtime data), **not this repository**. This
repo never committed a `.engram`; the `.gitignore` already treats runtime
engrams as state, not source. The "single-file, git-committable" pillar remains
true for its actual intent — a *small* portable engram a user may choose to
commit — while runtime stores are correctly excluded. **Nothing to fix here.**

### Incidental find: 3.8 GB working tree is all Rust build cruft
- `engram-aql/target/` = **3.8 GB** (debug binaries + `.pdb` + `.rlib`).
- Correctly gitignored (nested `engram-aql/.gitignore` has `target/`), **0
  tracked**. Purely local. `cargo clean` reclaims it anytime — not a git or
  repo-hygiene concern, just disk.
- Minor: `target/` lives only in the nested ignore, not root. Fine as-is.

## Q2 — Have ContextStore and engram-aql earned their keep?

Method: grep for real API symbols (not the common word "context") across
`integrations/` (Pi, the live production adapter) and `tools/` (OpenClaw import).

### In-repo consumer reality

| Subsystem | Built surface | In-repo consumers **beyond its own tests** |
|-----------|--------------|--------------------------------------------|
| **ContextStore** | core + RRF wiring + 3 MCP tools + 3 CLI cmds; 42 refs in `context-store.test.ts` | **NONE.** Pi adapter: 0. OpenClaw import: 0. (All `integrations/` "context" hits were the English word — session/startup context.) |
| **engram-aql** | entire Rust crate, own MCP server, write-delegation, vector search; **862** refs | **NONE.** No TS/integration path invokes the binary in a live flow. The L2/L3 `aql-*.test.ts` *spawn* it, but that's self-testing, not consumption. Also cargo-gated → least-exercised in CI. |

**Both are reachable-but-unconsumed inside this repo.** Their justification is
entirely *external*: an MCP/CLI agent (ContextStore) or a Rust/cross-process
consumer (engram-aql) that lives outside this tree. Whether that external
consumer exists is deployment knowledge the repo cannot answer.

### Cost asymmetry (this drives the recommendation)

- **ContextStore** is *cheap* surface: one source file, one `scope` column,
  no new deps, and it's load-bearing for the grounding layer (`taskContext()`
  is a passthrough to `queryContext()`). Cutting it would also dent the
  grounding story. **Low carrying cost → keep.**
- **engram-aql** is *expensive* surface: a whole second-language implementation
  that re-derives TS recall semantics, needs `cargo` in CI, is blocked by
  Windows App Control in some paths, and carries the 3.8 GB local build. It is
  the single largest speculative bet in the project and has **no proven
  consumer**. **High carrying cost + unproven → the real decision.**

## Recommendation

1. **Q1 (git premise): close it — already solved.** Optionally add one line to
   `CLAUDE.md`'s SQLite decision noting the `.gitignore` policy so the "bad git
   citizen" worry doesn't resurface. No behavioral change.
2. **ContextStore: keep.** Cheap, and it underpins the grounding layer. If you
   want, add a one-line "no in-repo consumer yet; external MCP/CLI only" note so
   its status is honest.
3. **engram-aql: make an explicit keep-or-freeze call.** It hasn't earned its
   keep *inside this repo*, but it may be a deliberate strategic bet on a future
   Rust consumer. Options:
   - **Keep + declare intent:** name the intended consumer/timeline in
     `CLAUDE.md`, accept the carrying cost.
   - **Freeze:** stop expanding it (no Phase 3), keep it building, revisit when a
     real consumer appears.
   - **Cut:** move it to its own repo behind a git submodule/ref if the
     cross-language read surface isn't near-term.
   This is the one genuine human call left — the others are near-automatic.

## Bottom line

Step 6's premise was partly stale: the git-bloat worry doesn't apply to *this
repo* (only to live stores, which are already ignored). The real consolidation
question is narrower than framed — it's specifically **whether engram-aql's
large, unconsumed surface is a strategic bet worth its carrying cost.**
Everything else is keep-as-is.
