# Engram — Open Work

> Phase 1 of both harness adapters shipped. This file tracks what's deferred.
> Historical plans (the Pi adapter Phase 1 plan, the original library build plan) live in git history.

## Status as of 2026-05-11

- **AQL Rust binary (Phase 1)** — merged via PR #1. Read-only query surface (RECALL, SCAN, LOOKUP, LOAD, AGGREGATE, ORDER BY, WITH LINKS, FOLLOW LINKS). Subcommands: `query`, `repl`, `mcp`. Crate at `engram-aql/`.
- **Pi.dev extension (Phase 1)** — merged via PR #2. Four slash commands (`/remember`, `/recall`, `/memory`, `/forget`) and four LLM tools (`engram_remember`, `engram_recall`, `engram_memory_stats`, `engram_forget`). Lives at `integrations/pi/`.
- **Pi.dev extension — working-memory bridge** — shipped on this branch. Adds `/session` slash command, three LLM tools (`engram_session_resume`, `engram_session_update`, `engram_session_snapshot`), and a `before_agent_start` system-prompt addendum nudging the agent toward Engram. Spec: `docs/superpowers/specs/2026-05-13-engram-pi-session-bridge-design.md`.
- **Main suite:** all green. Format + lint clean.
- **Pi extension suite:** all green (run via `cd integrations/pi && npx vitest run`).

---

## Phase 2 — Pi adapter

- [ ] **Reflect/extract scheduling from Pi**
  Trigger `engram.processExtractions()` and `engram.reflect()` from Pi's `turn_end` or `session_shutdown` hooks. Open design questions: cadence (per-turn? every N turns? on idle?), Ollama-availability detection, what to do when Ollama is unreachable (silent skip vs warning).

- [ ] **Auto-retain conversation turns**
  Use `tool_call` / `message_end` events to auto-stash messages as `experience`-type chunks. Needs gating (min length, dedup against recent retains, exclude short replies and tool outputs) or the DB will fill with noise.

- [ ] **Memory inspector UI widget**
  Use `ctx.ui.custom()` to render a live panel of recent chunks/opinions during a Pi session. Nice-to-have.

- [ ] **Publish `engram-pi` as `pi install`-able**
  Phase 1 ships in-repo; consumers symlink or use `-e`. To enable `pi install <source>`, decide: npm publish under `@swift-innovate`? git-installable from this repo? Versioning policy needs settling first.

## Phase 2 — AQL Rust binary

- [ ] **Write statements** — `STORE`, `UPDATE`, `FORGET`, `LINK` currently rejected at dispatch. Design challenge: writes need to coordinate with TS Engram's retain pipeline (embeddings, extraction queue). Options: (a) AQL writes call into TS via MCP, (b) AQL writes shell out to `engram-mcp`, (c) duplicate the retain pipeline in Rust (no — defeats the purpose).

- [ ] **Vector similarity search** — `LIKE $var`, `PATTERN $var` were deferred from Phase 1. Adding query-side embedding (without write-side) means either calling out to TS for the embedding or vendoring an ONNX/candle path in Rust. Probably the former for symmetry with AQL writes.

## Process / hygiene

- [ ] Confirm GitHub repo setting **"Automatically delete head branches"** is on so future PR merges auto-clean their branches (we did the manual cleanup for PR #1 and #2 on 2026-05-11).
- [ ] CLAUDE.md's "Integration with valor-engine" example still says `Engram.open('./myAgent.engram')` — verify this still matches the consumer pattern in valor-engine when next touching that integration.

## Picked-up reference

- Pi extension reference (slash commands + LLM tools): `docs/PI-INTEGRATION.md`
- OpenClaw integration (external plugin + migration CLI): `docs/OPENCLAW-INTEGRATION.md`
- Adapter map: `integrations/README.md`
- AQL design (current): `docs/superpowers/specs/2026-04-12-engram-aql-rust-binary-design.md`
- AQL implementation plan: `docs/superpowers/plans/2026-04-12-engram-aql-rust-binary.md`
