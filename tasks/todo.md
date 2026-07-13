# Task: Eliminate silent model-fallback in engram

Branch `fix/model-resolver-preflight` off `cfc5493`. Class-of-bug fix:
no silent fallback to an unvalidated default model name anywhere in the
library. Wiring + validation only — no schema, no reflect/extract algorithm
change. Surface-parity (13 MCP tools, CLI↔MCP 1:1) must stay green.

## Enumeration — every model-selection site found (grep-confirmed at cfc5493)

Deployment files named in the brief (`engram.sh`, `scripts/engram-integration.mjs`)
**do not exist in this repo** — they're deployment wrappers, out of scope per
the user's clarification. No `llama3.1:8b` literal exists outside src/. The
in-repo silent-default sites:

| # | Site | What | Class |
|---|------|------|-------|
| 1 | `src/generation.ts:50` | `OllamaGeneration` `model ?? 'llama3.1:8b'` | **the culprit** |
| 2 | `src/generation.ts:171` | `AnthropicGeneration` `model ?? 'claude-haiku-4-5-...'` | peer silent default |
| 3 | `src/generation.ts:110` | `OpenAICompatibleGeneration` — model required positionally | already correct |
| 4 | `src/engram.ts:223` | `Engram.init` `reflectModel = 'llama3.1:8b'` | silent default |
| 5 | `src/engram.ts:441-443` | generator cascade `else → new OllamaGeneration(default)` | silent default (eager) |
| 6 | `src/reflect.ts:513` | `reflect()` `reflectModel = 'llama3.1:8b'` | silent default |
| 7 | `src/reflect.ts:1018` | reflect CLI entry `process.env.REFLECT_MODEL \|\| 'llama3.1:8b'` | silent default (cron entrypoint) |
| 8 | `src/cli-args.ts:197` | `buildEngramOptions` `?? 'llama3.1:8b'` | silent default |
| 9 | `src/mcp-server.ts:67` | `getArg('--reflect-model') ?? 'llama3.1:8b'` | silent default |
| 10 | `integrations/pi/src/index.ts:251,314` | `Engram.open(path)` — no model, relies on #5 | integration entrypoint |

`recall` uses the embedder, not the LLM generator — there is **no** recall
generation model role in this library. `extract` + `reflect` share ONE
generator built at `Engram.open`. So the honest in-repo generation roles are
`reflect`, `extract`, `integration`.

## Design decisions

- **Un-runnable, not quietly-runnable, but retain/recall stay zero-config.**
  The generator is only used by `reflect()`/`processExtractions()`. Making
  `Engram.open` throw eagerly would break ~60 retain/recall-only tests + Pi
  (which opens with no model and never generates in most sessions). Instead:
  a new **`UnconfiguredGeneration` sentinel** replaces the eager Ollama default
  when no model/generator is configured. It carries no model and its
  `generate()` throws a loud, actionable error. Result: retain/recall work
  with zero config; the first reflect/extract call on an unconfigured engram
  fails loudly (== that job's startup); NO silent `llama3.1` anywhere. This is
  the opposite of a silent fallback — a fail-loud placeholder.
- **Single resolver `src/model-resolver.ts`** is the only place model
  selection *from config/env* happens. `resolveModelSpec()` throws if
  unconfigured; `resolveModelSpecOrNull()` returns null (for "pass-through if
  configured" at Engram.open plumbing — null → sentinel, still loud on use).
  Returns `{ host, model, isRemote }`; flags `:cloud`/non-LAN hosts.
- **Preflight** (`preflightModel`) hits `${host}/api/tags`, confirms the model
  is served, returns the served list on failure. Wired into the entrypoints
  that *run generation*: reflect CLI entry, `engram` CLI reflect/
  process-extractions, and Pi (once, before background consolidation). Exit
  non-zero on the batch entrypoints; loud once-warning on long-lived Pi.

## Steps

- [ ] `src/model-resolver.ts` — resolver + preflight + types + tests
- [ ] `src/generation.ts` — Ollama/Anthropic require model (throw on empty);
      add `UnconfiguredGeneration`; fix doc example
- [ ] `src/engram.ts` — drop reflectModel default; cascade → sentinel when
      unconfigured; require `anthropicGeneration.model`; JSDoc
- [ ] `src/reflect.ts` — drop default in `reflect()`; CLI entry resolver+preflight
- [ ] `src/cli-args.ts` — buildEngramOptions via resolver (no literal default)
- [ ] `src/cli.ts` — reflect + process-extractions: resolve+preflight, exit≠0
- [ ] `src/mcp-server.ts` — resolver (or-null) + startup preflight warning
- [ ] `integrations/pi` — resolve+pass model; preflight once; loud once-warn
- [ ] Tests: new resolver/preflight suites; fix engram.test.ts:165 + any
      reflect/extract-without-generator tests to pass an explicit model
      (NEVER re-introduce a default); generation.test.ts required-model tests
- [ ] examples/basic-usage.ts — pass explicit reflectModel
- [ ] Verification: root vitest + pi ext + openclaw-import (baseline 664),
      typecheck/lint/format, surface-parity green. Cargo out of scope.
