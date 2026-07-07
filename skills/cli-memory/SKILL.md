---
name: cli-memory
description: Persistent agent memory via the `engram` CLI. Recall before answering anything that depends on prior context (who/what/preferences/decisions/history); retain after a fact, decision, or preference is established; supersede on correction; run session once per incoming message. Every command takes `--json` for a machine-readable contract and signals not-found with exit code 2.
---

# Engram CLI Memory

You have a persistent memory file (an `.engram` SQLite database). The `engram`
command is your only interface to it. This skill is the contract for **deciding
whether and how to call it** — not a man page.

## When to reach for memory (read this first)

- **Before answering anything context-dependent → `recall`.** If the user
  references a person, project, preference, past decision, or "what we did", you
  do not know the answer from the prompt alone. Recall first, then answer. A
  recall that returns nothing is cheap; answering from a stale guess is not.
- **After a fact, decision, or preference is established → `retain`.** The user
  states a preference ("I use Pulumi now"), you make a design decision, a
  constraint is confirmed. Store it so the next session knows. Do **not** retain
  small talk, acknowledgements, or things already in the repo/git history.
- **On a correction → `supersede`.** The user contradicts something you recalled
  ("no, it's Kubernetes not Docker"). Supersede the old chunk with the new text
  so the wrong fact stops surfacing.
- **Once per incoming user message → `session`.** Call it at the top of a turn to
  resume or open the working-memory session and pull related long-term context
  in one shot. Use the returned `relatedContext` to ground your reply.
- `reflect` / `process-extractions` are background maintenance (need an LLM).
  Run occasionally, not per turn. `queue-stats` tells you if the graph is behind;
  `requeue-failed` re-drives items stranded by an outage (see its section below).

## Setup

Point the CLI at a database via `--db <path>` on each call, or set it once:

```bash
export ENGRAM_DB=./agent.engram
```

`--db` wins over `ENGRAM_DB`. If neither is set the command exits 1.

## Exit codes (branch on these)

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `2`  | Not found — `forget`/`supersede` target chunk does not exist |
| `1`  | Error — bad/missing argument, no DB path, or operation failure |

`--json` puts the raw method return on **stdout** and nothing else; all
diagnostics go to **stderr**. Parse stdout, branch on the exit code.

## Commands

### `recall <query>` — search memory

```bash
engram recall "Terraform IaC provider" --json
echo "long pasted context" | engram recall --json    # query from stdin if omitted
```

Use keywords and proper nouns, not full questions ("Tom role background", not
"Who is Tom?"). Temporal phrases auto-activate date filtering ("last week",
"March 2026"). Options: `--top-k <n>`, `--strategies semantic,keyword,graph,temporal`,
`--memory-types world,experience,observation,opinion`, `--min-trust <0..1>`,
`--after <iso>`, `--before <iso>`, `--no-opinions`, `--no-observations`.

`--json` shape:
```json
{
  "results": [
    { "id": "chk-…", "text": "…", "memoryType": "world", "source": "…",
      "trustScore": 0.9, "sourceType": "user_stated", "eventTime": null,
      "score": 0.83, "strategies": ["semantic", "keyword"] }
  ],
  "opinions": [{ "belief": "…", "confidence": 0.7, "domain": "…" }],
  "observations": [{ "summary": "…", "domain": "…", "topic": "…" }],
  "totalCandidates": 12,
  "strategiesUsed": ["semantic", "keyword", "graph"]
}
```

### `retain <text>` — store a fact

```bash
engram retain "Tom prefers Pulumi over Terraform" \
  --memory-type world --source-type user_stated --trust-score 0.9 --json
echo "fact text" | engram retain --json                # text from stdin if omitted
```

Options: `--memory-type <world|experience|observation|opinion>`,
`--source-type <user_stated|inferred|external_doc|tool_result|agent_generated>`,
`--trust-score <0..1>`, `--source <id>`, `--context <tag>`,
`--event-time <iso>`, `--temporal-label <text>`. Trust guidance:
user_stated ≈ 0.85–0.9, agent_generated ≈ 0.6, inferred ≈ 0.5.

`--json` shape: `{ "chunkId": "chk-…", "queued": true, "deduplicated"?: false, "tier1"?: { "entitiesLinked": 0, "relationsCreated": 0 } }`

### `supersede <oldChunkId> <newText>` — correct a fact

```bash
engram supersede chk-abc123 "Tom switched to Kubernetes" --json
echo "new text" | engram supersede chk-abc123 --json    # newText from stdin if omitted
```

Takes the same write options as `retain`. Soft-deletes the old chunk and links
it to the new one. **Exit 2** if `oldChunkId` doesn't exist (and no new chunk is
created in that case). `--json` shape is the same as `retain`.

### `forget <chunkId>` — soft-delete

```bash
engram forget chk-abc123 --json
```

`--json` shape: `{ "forgotten": true }`. Exit `0` if it existed, **`2`** if not
(the JSON still reports `{ "forgotten": false }`).

### `session <message>` — working-memory session (once per turn)

```bash
engram session "Help me plan the deployment" --json
echo "user message" | engram session --json             # message from stdin if omitted
```

Options: `--max-active <n>` (default 5), `--threshold <0..1>` (default 0.55).
`--json` shape:
```json
{
  "session": { "id": "wm-…", "goal": "…", "updated_at": "…" },
  "relatedContext": "formatted long-term context for your prompt",
  "confidence": 0.82,
  "diagnostics": { "sessionId": "wm-…", "reason": "match", "candidatesEvaluated": 3 }
}
```
`reason` is `"new"` for a fresh session, `"match"` when resuming one.

### `queue-stats` — extraction queue health

```bash
engram queue-stats --json
```

`--json` shape: `{ "pending": 3, "processing": 0, "completed": 12, "failed": 2, "oldest_pending": "2026-06-05T12:00:00Z", "failed_reasons": [{ "error": "fetch failed", "count": 2 }] }`.
A growing `pending` means the knowledge graph is behind — run `process-extractions`.
A non-zero `failed` with a transient-looking reason (host down, model missing) means
those items need an explicit re-drive once the cause is fixed — run `requeue-failed`.

### `requeue-failed` — re-drive failed extractions

```bash
engram requeue-failed --json
engram requeue-failed --error-like "fetch failed" --json
```

Failed is terminal (3 attempts exhausted) — items never retry on their own. This
resets them to pending with a fresh attempt counter. `--error-like <substring>`
targets one failure class from the `failed_reasons` breakdown.
`--json` shape: `{ "requeued": 11 }`.

### `reflect` — synthesize observations/opinions (needs an LLM)

```bash
engram reflect --json
```

`--json` shape: `{ "logId": "…", "factsProcessed": 8, "observationsCreated": 2, "observationsUpdated": 1, "opinionsFormed": 1, "opinionsReinforced": 2, "opinionsChallenged": 0, "status": "completed", "durationMs": 1430 }`.

### `process-extractions` — build the knowledge graph (needs an LLM)

```bash
engram process-extractions --batch-size 10 --json
```

`--json` shape: `{ "processed": 7, "failed": 0 }`.

## Turn loop (typical)

```bash
# 1. open/resume the session and pull context
engram session "$USER_MESSAGE" --json

# 2. recall anything the message depends on before answering
engram recall "relevant keywords" --top-k 5 --json

# 3. … answer the user …

# 4. retain new facts/decisions; supersede on correction
engram retain "decision just made" --memory-type world --trust-score 0.8 --json
```
