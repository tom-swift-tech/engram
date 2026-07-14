# Plan: Node-Origin Provenance Groundwork

Base tree: `main@c0e90f7` (post-#31-merge). Branch: `feat/node-origin-provenance`.

**Scope resolution (user-confirmed 2026-07-14, on `go`):** stamp `node_origin`
on **`chunks`, `opinions`, AND `observations`** — all three durable reflect/retain
outputs. This resolves the Step-2/Step-3 inconsistency in the original draft
(Step 2 listed only chunks+opinions; Step 3's `insertObs` implied observations):
including observations completes the "nothing has to be backfilled" goal, since
observations are reflect-authored durable knowledge just like opinions.

Scoping decisions (user-confirmed 2026-07-14):

1. **Groundwork only, not distribution.** This sprint makes every chunk and
   opinion record *which Engram instance authored it*. It is the minimum schema
   + write-path change that must land **before** a portable/second instance
   exists, so that when sync arrives later (dumb `.engram` merge first, a
   message bus much later) provenance is already present and nothing has to be
   backfilled onto un-tagged memories.
2. **Additive columns + write-path stamping. Nothing else.** No merge/union,
   no conflict resolution, no opinion-model change, no new MCP tools, no
   transport. Those are downstream sprints whose cost is only justified by an
   actual merge needing them.

Non-goals reaffirmed:

- **Opinion mutability model is untouched.** Opinions stay in-place-mutable
  (reinforce/challenge/decay `UPDATE` the live row). Converting opinions to
  append+supersede is real surgery on `reflect.ts` and belongs to the *sync*
  sprint, where a merge actually needs it — not here.
- **No merge/conflict logic.** This sprint only *stamps* origin; it never reads
  two origins and reconciles them.
- **No tool-count change.** `surface-parity.test.ts` count stays as-is — this is
  a library/schema change with zero MCP surface.

---

## Build order (dependency-ordered)

### Step 1 — `node_origin` bank config  ·  the instance's identity

**`src/engram.ts` — in `init()`, after schema bootstrap + existing migrations:**

- Ensure a stable per-instance origin exists in `bank_config` under key
  `node_origin`. Generate **once**, on first open of a bank that lacks it:
  format `node-${hostnameSlug}-${shortUuid}` (hostname slug = lowercased,
  non-alphanumerics collapsed to `-`; short uuid = first 8 of `randomUUID()`).
- `INSERT ... ON CONFLICT(key) DO NOTHING` semantics — **never regenerate** if
  the key already exists. The value must survive restarts; a second open reads
  the same origin, never mints a new one.
- Read the value back once in `init()` and hold it on the `Engram` instance
  (`private readonly nodeOrigin: string`), so the write paths don't re-query
  `bank_config` per retain.

**Why `bank_config`, not a generated column or file sidecar:** origin is
per-bank durable state, exactly what `bank_config` is for (mirrors how
`embed_dimensions` / `entity_id_v2_migrated` already live there). One `.engram`
= one origin, written at birth.

---

### Step 2 — Schema additions  ·  additive, guarded, no backfill

**`src/schema.sql`** (fresh installs get the columns inline):

- `chunks`: add `node_origin TEXT` (place after `text_hash`, before Lifecycle).
- `opinions`: add `node_origin TEXT`.
- **Do NOT add the `node_origin` indexes in `schema.sql`.** Same reason the file
  already documents for the scope columns: on a pre-existing `.engram` the
  column doesn't exist yet when `schema.sql` is exec'd wholesale, and
  `CREATE INDEX IF NOT EXISTS` on a missing column fails hard. Indexes are
  created in `engram.ts` *after* the column guards (below).

**`src/engram.ts` — guarded migrations in `init()`, mirroring the existing
ContextStore scope-column block exactly:**

```
const chunkCols = db.pragma('table_info(chunks)') as Array<{ name: string }>;
if (!chunkCols.some(c => c.name === 'node_origin')) {
  db.exec('ALTER TABLE chunks ADD COLUMN node_origin TEXT');
}
const opinionCols = db.pragma('table_info(opinions)') as Array<{ name: string }>;
if (!opinionCols.some(c => c.name === 'node_origin')) {
  db.exec('ALTER TABLE opinions ADD COLUMN node_origin TEXT');
}
// indexes created unconditionally AFTER the guards — columns now exist either way
db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_node_origin ON chunks(node_origin) WHERE node_origin IS NOT NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_opinions_node_origin ON opinions(node_origin) WHERE node_origin IS NOT NULL');
```

- **No backfill.** Pre-migration rows stay `NULL`. `NULL` means "provenance
  unknown / pre-distribution" — truthful. Backfilling existing rows to the
  current node would falsely claim this instance authored memories that predate
  origin tracking; a future merge treats `NULL` as "local-legacy, trust as
  home."

---

### Step 3 — Stamp on write  ·  first author wins

**`src/retain.ts`:**

- The fresh chunk `INSERT` gains the `node_origin` column, valued from the
  instance's configured origin (threaded in from `engram.ts`'s `retain` wrapper,
  which already holds `this.nodeOrigin`).
- The **dedup UPDATE path does not touch `node_origin`.** A dedup hit returns the
  existing chunk; its original author stands. First author wins — re-retaining
  the same fact on a second node must not rewrite who first recorded it.

**`src/reflect.ts`:**

- `reflect()` opens its own `new Database(dbPath)`, so it has no `Engram`
  instance to read `nodeOrigin` from. Read it once at the top of `reflect()`:
  `SELECT value FROM bank_config WHERE key = 'node_origin'` → thread into the
  apply-transaction closure.
- `insertOpinion` and `insertObs` stamp `node_origin` on the new row.
- **Reinforce / challenge / decay leave `node_origin` untouched.** Mutating an
  opinion's confidence doesn't change who *formed* it. (This is precisely the
  seam where append-structured opinions will later matter — but not this sprint.)

---

### Step 4 — Tests

**New: `tests/node-origin.test.ts`** (reuse `tests/helpers.ts`
`MockEmbedder`/mock generator — no Ollama/network):

- Fresh bank: `node_origin` present in `bank_config`; reopen the same file and
  assert the value is **identical** (stable across restart, never regenerated).
- A new chunk written via `retain` carries the instance's `node_origin`.
- A new opinion written via a reflect cycle carries the instance's
  `node_origin` (mock generator emits a `new` opinion; assert the row's origin).
- **Pre-migration simulation:** create a bank, drop the `node_origin` column (or
  build rows on a schema without it), reopen → existing rows are `NULL`, the
  open does not crash, and subsequent writes stamp origin. Proves the guarded
  ALTER upgrades an old `.engram` cleanly with no false origin claims.
- **Dedup does not rewrite origin:** retain a fact, then retain the same
  normalized text again (dedup hit) — assert the chunk's `node_origin` is
  unchanged.
- `surface-parity.test.ts` still passes unchanged (no tools added).

---

### Step 5 — Docs (mirror-locked)

- **`CLAUDE.md` + `AGENTS.md`** (edit **both** — CI mirror filter): one line under
  Decisions/Schema noting `node_origin` on `chunks`/`opinions`, stamped on write,
  `NULL` = pre-distribution, first-author-wins on dedup.
- **`README.md`**: no change required (no new public API surface; origin is
  internal provenance).
- Skills / CLI: **no change** — no new MCP tool or CLI subcommand. Confirm
  surface-parity still green.

---

## Verification pipeline (per verification-loop skill)

`npm run build` → typecheck → lint → `npm test` (existing suite + new
`node-origin` tests all green; surface-parity unchanged). Prettier: touched
`.ts` only; do not reformat markdown. Commit on `feat/node-origin-provenance`
with conventional-commit messages.

## Migration safety

Follows the existing guarded-`ALTER TABLE ADD COLUMN` pattern already proven for
`text_hash`, `next_retry_after`, and the ContextStore scope columns. Every
existing `.engram` (home bank and any copies) upgrades on next open with no data
loss and no false origin claims — pre-existing rows keep `NULL` origin.

## Deferred (explicitly downstream, not this sprint)

- **Append-structured opinions** (opinion → append+supersede like chunks) —
  belongs to the sync sprint, where a merge needs mergeable opinions. Requires
  rewriting reflect's reinforce/challenge/decay + `findMatchingOpinion` dedup.
- **Merge / union function** over two `.engram` files (union chunks by
  `text_hash`, preserve `superseded_by` chains, reconcile opinions).
- **Transport / message bus** for concurrent live instances.

## Effort estimate

~half a day. Steps 1–3 are small and localized (one config key, two guarded
ALTERs, a handful of INSERT sites); Step 4 is the bulk. Single builder, one
worktree, base = `main@<FILL-IN-HEAD-SHA>`.
