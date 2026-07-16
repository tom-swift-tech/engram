# Decision: Freeze engram-aql at Phase 2

Date: 2026-07-14 · Decided by: Director · Status: **Frozen**

## Decision

`engram-aql` is **frozen at Phase 2**. No Phase 3. Keep it compiling and
CI-green; invest nothing further until the thaw trigger below fires.

## Context

Step 6 audit (read-only) found engram-aql has **zero in-repo consumers** beyond
its own tests — the Pi adapter and OpenClaw import call neither it nor
ContextStore (every "context" hit in `integrations/` was the English word). Its
carrying cost is **high**: a whole Rust crate, its own MCP server, cargo-gated
CI, ~862 refs. It is a second-language reimplementation of read semantics the
TypeScript side already has.

Its entire justification was one inbound question from one person (a "30,000
agents in restaurants" use case) against an **open-source** repo. That is the
weakest possible demand signal: OSS inbound questions are free to send and
routinely carry zero intent. The crate was built ahead of confirmed demand; the
demand never confirmed.

## Rationale

- **MCP already serves every agent consumer.** Agents — including that inbound
  user's, real or not — reach engram through the MCP surface. AQL only earns its
  keep for a **Rust process wanting in-process, sub-MCP query access**, and no
  such consumer exists (internal or external). AQL is a second door nobody asked
  to walk through.
- **Open source means we don't need to host his use case.** If the inbound user
  is real, the crate exists, builds, and is clonable today. Freezing it costs him
  nothing. Maintaining it hot in mainline costs *us* on every toolchain bump —
  an asymmetry that runs entirely against keeping it warm on speculation.
- **Freeze, not cut** — preserves reversibility. Cutting to a submodule is
  high-friction to reverse under exactly the conditions (a Rust consumer appears)
  where we'd regret ejecting it. Freeze stops cost from compounding without
  foreclosing the future.
- **Freeze, not keep-and-invest** — Phase 3 would compound the bet: more Rust
  surface, more CI gate, more mirror docs, all still justified by one unanswered
  question. The line is drawn where the evidence stops.

## Thaw trigger (falsifiable)

engram-aql thaws — Phase 3 reconsidered — when **a Rust consumer produces a
concrete artifact**, i.e. any of:

- a PR or issue against the crate from the external user (converts "question"
  into "consumer"), OR
- a **named internal consumer** on our own fleet wanting in-process engram
  reads in Rust (e.g. Substrate, Cradel/Mira-core, or Herd) — in which case the
  justification is *ours*, we own it, and the restaurant story is dropped
  entirely from the rationale.

**One more inbound question does not count.** The signal is someone *doing*, not
*asking*.

## Scope while frozen

- Keep it building; keep CI green. Frozen ≠ rotting.
- **Watch the build tax.** Freeze assumes keeping-green is cheap. If engram-aql
  becomes the thing that breaks CI on Rust toolchain bumps, revisit — a
  freeze that costs real maintenance on a zero-consumer crate converts the
  decision toward **cut**.
- No new AQL surface, no Phase 3 features, no docs expansion.

## Also settled by the Step 6 audit (not this decision, recorded for closure)

- **Git premise: already solved.** `*.engram`/`*.db`/`*.sqlite` are gitignored,
  zero DB files tracked, `.git` is ~13 MB. The large snapshot numbers were a
  live consumer store (operator data), never this repo. The
  single-file-git-committable pillar holds for its real intent (small portable
  engrams); runtime stores are correctly excluded. The 3.8 GB working tree is
  `engram-aql/target/` Rust debug artifacts — gitignored, `cargo clean`
  reclaims anytime.
- **ContextStore: keep.** Low cost (1 file, 1 column, no deps) and load-bearing
  for the grounding layer (`taskContext` → `queryContext`). Near-automatic keep.
