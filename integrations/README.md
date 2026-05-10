# Engram Integrations

Engram is a SQLite-backed memory substrate. Agent harnesses (the runtimes that host LLM agents) consume Engram through different integration models. This directory is the index of where each adapter's code lives.

## Adapters

| Harness | Consumption model | Code location | Docs |
|---------|-------------------|---------------|------|
| **OpenClaw** | External plugin in the OpenClaw workspace, spawns Engram's MCP stdio server via mcporter subprocess | `tools/openclaw-import/` (one-shot migration CLI). The runtime plugin lives in the OpenClaw workspace, not this repo. | `docs/OPENCLAW-INTEGRATION.md` |
| **Pi.dev** (`pi-mono` coding agent) | In-process Node.js extension auto-discovered by Pi from `.pi/extensions/` or installed via `pi install` | `integrations/pi/` | `docs/PI-INTEGRATION.md` |

## Why the asymmetry?

Engram's core is harness-agnostic. The shape of each adapter is dictated by how the host harness loads code:

- **OpenClaw** runs Engram out-of-process via stdio. The OpenClaw-side plugin is owned by the OpenClaw workspace and isn't a build artifact of this repo. Engram only ships a migration CLI for users who want to bulk-import their existing OpenClaw markdown memory.
- **Pi.dev** runs TypeScript extensions in-process via `jiti`. That means the Pi adapter can `import { Engram } from 'engram'` directly and call native methods (~ms latency vs OpenClaw's ~10s mcporter cold-start). It's a real Pi-installable package and lives here.

If a future harness uses a similar model to one of these, it should sit alongside in this directory.
