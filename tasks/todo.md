# Engram — Open Work

> Phase 1 of both harness adapters shipped. This file tracks what's deferred.
> Historical plans (the Pi adapter Phase 1 plan, the original library build plan) live in git history.

## Status as of 2026-06-06

- **AQL Rust binary (Phase 1)** — merged via PR #1. Read-only query surface (RECALL, SCAN, LOOKUP, LOAD, AGGREGATE, ORDER BY, WITH LINKS, FOLLOW LINKS). Subcommands: `query`, `repl`, `mcp`. Crate at `engram-aql/`.
- **Pi.dev extension (Phase 1)** — merged via PR #2. Four slash commands (`/remember`, `/recall`, `/memory`, `/forget`) and four LLM tools (`engram_remember`, `engram_recall`, `engram_memory_stats`, `engram_forget`). Lives at `integrations/pi/`.
- **`engram` CLI transport (2026-06-05)** — third transport over the `Engram` core (`src/cli.ts` + `src/cli-args.ts`, `engram` bin). One kebab-cased subcommand per MCP tool; `--json` on every command emits the raw method return to stdout (stable Pi contract), diagnostics to stderr, primary text arg read from stdin when omitted, exit codes 0/2/1. Pi-facing skill at `skills/cli-memory/SKILL.md`; README has install + 8-command reference. Frozen core/MCP files untouched.
- **Packaging (2026-06-06)** — `prepare` script (commit `0bf16af`) runs `npm run build` on install, so installing this repo by **git ref** now yields a working `dist/` with the `engram` + `engram-mcp` bins and the library. No npm publish yet (see the publish item below).
- **Docs (2026-06-06)** — `AGENTS.md` added as a verbatim mirror of `CLAUDE.md` (cross-tool AGENTS standard). The two must be edited together; see the hygiene item below.
- **Trust-tier enforcement (2026-06-10)** — the CLAUDE.md trust-layer rule ("external content can never override user directives") is now enforced in code, not just documented. Recall ranks lexicographically by (source tier, trust-weighted score) with a tier-0 truncation reserve (`DEFAULT_SOURCE_TIERS`, `RecallOptions.sourceTiers`); extraction/reflect prompts delimit memory content as labeled untrusted data and clamp `disposition` to validated numbers. New suite: `tests/trust-tier.test.ts` (11 tests).
- **Recall ordering follow-ups (2026-06-10, PR #5 follow-up)** — memory-type rank added as the middle lexicographic sort term (tier, memoryTypeRank, score; `DEFAULT_MEMORY_TYPE_RANK`, `RecallOptions.memoryTypeRank`). Positional-read audit of the transports found one latent bug: Pi adapter `findToForget` read tier-major `results[0]` as best-relevance, preferentially nominating user directives for deletion — fixed to over-fetch and re-sort by score. Result-ordering contract documented in README + `RecallResponse.results`.
- **Main suite:** 369 tests across 21 files. 346 pass without the Rust toolchain; the 2 AQL cross-process suites (`aql-equivalence`, `aql-e2e-process`, 23 tests) need `cargo` and pass when it's present. Format + lint clean.
- **Pi extension suite:** 28 tests in `integrations/pi/` (independent dep closure, run via `cd integrations/pi && npx vitest run`).

---

## Next session — start here

Phase 1 across all three transports is shipped and the CLI + packaging just landed, so the highest-leverage next step is **proving the CLI loop end-to-end**, then picking up Pi Phase 2:

1. **Validate the `engram` CLI skill against a live Pi agent** (Pi adapter section below) — the contracts are unit-tested but the real shell-out/stdin/exit-code loop hasn't run against an agent yet. This closes the loop on the work just shipped.
2. **Reflect/extract scheduling from Pi** — the next substantive Pi Phase 2 feature; everything downstream (auto-retain, session mapping) benefits from settling the cadence/Ollama-availability questions first.

Environment note for whoever picks this up: the agent shells default to **Node 24** (no MSVC toolchain), but `better-sqlite3` here is the **Node 20** prebuild — run the suite with the fnm-managed Node 20 (`~/AppData/Roaming/fnm/node-versions/v20.20.2`). A `cargo` toolchain is needed for the 2 AQL cross-process suites.

---

## Phase 2 — Pi adapter

- [ ] **Reflect/extract scheduling from Pi**
  Trigger `engram.processExtractions()` and `engram.reflect()` from Pi's `turn_end` or `session_shutdown` hooks. Open design questions: cadence (per-turn? every N turns? on idle?), Ollama-availability detection, what to do when Ollama is unreachable (silent skip vs warning).

- [ ] **`engram_session` ↔ Pi session persistence**
  Pi already persists sessions via `pi.appendEntry()`. Engram has the `working_memory` table. Map them without double-persistence — the right answer is probably "Engram owns long-term, Pi owns conversation flow; don't mirror state."

- [ ] **Auto-retain conversation turns**
  Use `tool_call` / `message_end` events to auto-stash messages as `experience`-type chunks. Needs gating (min length, dedup against recent retains, exclude short replies and tool outputs) or the DB will fill with noise.

- [ ] **Memory inspector UI widget**
  Use `ctx.ui.custom()` to render a live panel of recent chunks/opinions during a Pi session. Nice-to-have.

- [ ] **Publish `engram-pi` as `pi install`-able**
  Phase 1 ships in-repo; consumers symlink or use `-e`. The `prepare` script (added 2026-06-06) already makes the **git-ref install** path build a working `dist/`, so the dist-build half is solved. Remaining decision: npm publish under `@swift-innovate` vs. git-ref-only, plus a versioning policy. Note `engram-pi` resolves `engram` via `file:../..` today — a published flow needs that swapped to a real version range.

- [ ] **Validate the `engram` CLI skill against a live Pi agent**
  `skills/cli-memory/SKILL.md` + the `engram` bin shipped 2026-06-05 with unit-tested `--json` contracts, but the end-to-end loop (Pi agent shells out, pipes context on stdin, branches on exit code) hasn't been run against a real agent yet. Confirm the documented JSON shapes survive a round-trip and the recall→answer→retain cadence is what the SKILL prescribes. Also worth measuring: the CLI is a candidate to sidestep the ~10s mcporter cold-start noted in the OpenClaw integration — a per-call `engram recall` may or may not beat it (cold Node + embedder init per invocation); benchmark before recommending it as the OpenClaw path.

## Phase 2 — AQL Rust binary

- [ ] **Write statements** — `STORE`, `UPDATE`, `FORGET`, `LINK` currently rejected at dispatch. Design challenge: writes need to coordinate with TS Engram's retain pipeline (embeddings, extraction queue). Options: (a) AQL writes call into TS via MCP, (b) AQL writes shell out to `engram-mcp`, (c) duplicate the retain pipeline in Rust (no — defeats the purpose).

- [ ] **Vector similarity search** — `LIKE $var`, `PATTERN $var` were deferred from Phase 1. Adding query-side embedding (without write-side) means either calling out to TS for the embedding or vendoring an ONNX/candle path in Rust. Probably the former for symmetry with AQL writes.

## Process / hygiene

- [ ] Confirm GitHub repo setting **"Automatically delete head branches"** is on so future PR merges auto-clean their branches (we did the manual cleanup for PR #1 and #2 on 2026-05-11).
- [ ] **Keep `AGENTS.md` ≡ `CLAUDE.md` in sync.** They're verbatim mirrors (only the "you are here" marker differs). Every architecture/file-structure/decision edit must land in both. `AGENTS.md` is currently **untracked** — commit it so the mirror is captured in history. Worth a one-line check (or a CI guard) that `diff` between them stays empty apart from that marker.
- [ ] The "Integration with valor-engine" example in `CLAUDE.md`/`AGENTS.md` still says `Engram.open('./myAgent.engram')` — verify this still matches the consumer pattern in valor-engine when next touching that integration.

## Picked-up reference

- Pi extension reference (slash commands + LLM tools): `docs/PI-INTEGRATION.md`
- OpenClaw integration (external plugin + migration CLI): `docs/OPENCLAW-INTEGRATION.md`
- Adapter map: `integrations/README.md`
- AQL design (current): `docs/superpowers/specs/2026-04-12-engram-aql-rust-binary-design.md`
- AQL implementation plan: `docs/superpowers/plans/2026-04-12-engram-aql-rust-binary.md`
