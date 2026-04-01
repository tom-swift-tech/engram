# Engram Memory Skill

## Description

Engram is a local-first semantic memory system for AI agents. Store, search, and manage persistent memory across sessions using four retrieval strategies (semantic vector, keyword FTS, knowledge graph, temporal).

## MCP Server

Engram connects as an MCP server via mcporter. All tool parameters use **camelCase**.

## Tool Reference

### Store a fact — `engram_retain`

```bash
npx mcporter call engram.engram_retain text="Your fact here" memoryType=world sourceType=user_stated trustScore=0.9
```

| Parameter | Required | Values |
|-----------|----------|--------|
| `text` | yes | The memory content to store |
| `memoryType` | no | `world` (facts), `experience` (agent actions), `observation` (synthesized), `opinion` (beliefs) |
| `sourceType` | no | `user_stated`, `inferred`, `external_doc`, `tool_result`, `agent_generated` |
| `trustScore` | no | 0.0–1.0. Recommended: user_stated=0.85, agent_generated=0.6, inferred=0.5 |
| `source` | no | Identifier (e.g. `conversation:session-123`, `file:config.yaml`) |
| `context` | no | Freeform tag (e.g. `infrastructure`, `project:valor`) |
| `eventTime` | no | ISO 8601 timestamp for when the event occurred |

### Search memory — `engram_recall`

```bash
npx mcporter call engram.engram_recall query="Your search query" topK=5
```

| Parameter | Required | Values |
|-----------|----------|--------|
| `query` | yes | Natural language query. Temporal expressions are auto-parsed — "last week", "yesterday", "March 15th", "past 30 days", "Q1 2026" all activate the temporal strategy automatically. |
| `topK` | no | Max results (default: 10) |
| `strategies` | no | Array: `semantic`, `keyword`, `graph`, `temporal` |
| `memoryTypes` | no | Filter: `world`, `experience`, `observation`, `opinion` |
| `minTrust` | no | Minimum trust score 0.0–1.0 |
| `after` | no | ISO date — only facts after this date. Overrides auto-parsed dates. |
| `before` | no | ISO date — only facts before this date. Overrides auto-parsed dates. |

Returns: `results[]` (ranked chunks), `opinions[]` (beliefs with confidence), `observations[]` (synthesized knowledge).

**Temporal query examples:**

```bash
npx mcporter call engram.engram_recall query="what happened last week"
npx mcporter call engram.engram_recall query="decisions yesterday"
npx mcporter call engram.engram_recall query="March 2026 deployments"
npx mcporter call engram.engram_recall query="progress past 30 days"
```

No need to pass `after`/`before` manually — the temporal strategy activates from the query text.

### Working memory session — `engram_session`

```bash
npx mcporter call engram.engram_session message="Current user message"
```

Returns session state + related long-term context. Auto-matches to existing sessions by topic similarity or creates new ones.

| Parameter | Required | Values |
|-----------|----------|--------|
| `message` | yes | The incoming user message |
| `maxActive` | no | Max active sessions before oldest is snapshotted (default: 5) |
| `threshold` | no | Cosine similarity threshold for matching (default: 0.55) |

### Build knowledge graph — `engram_process_extractions`

```bash
npx mcporter call engram.engram_process_extractions batchSize=10
```

Requires Ollama. Processes queued chunks to extract entities and relationships.

### Run reflection — `engram_reflect`

```bash
npx mcporter call engram.engram_reflect
```

Requires Ollama. Synthesizes observations and forms/updates opinions from accumulated facts.

### Forget a memory — `engram_forget`

```bash
npx mcporter call engram.engram_forget chunkId=chk-xxx
```

Soft-deletes a chunk. Excluded from recall but retained for audit.

### Replace outdated fact — `engram_supersede`

```bash
npx mcporter call engram.engram_supersede oldChunkId=chk-xxx newText="Updated fact"
```

Soft-deletes the old chunk, stores the new one, and links them via `superseded_by`.

## Usage Patterns

### Before answering a user question

```
1. engram_recall query="<relevant query>" topK=5
2. Read results, opinions, observations
3. Incorporate into response
```

### After learning something new

```
1. Evaluate if worth storing (is it a fact, decision, or preference?)
2. engram_retain text="<the fact>" memoryType=world sourceType=user_stated trustScore=0.85
```

### Starting a conversation turn

```
1. engram_session message="<user's message>"
2. Use returned session.goal and relatedContext for prompt context
3. After responding, update session progress if applicable
```

## Common Mistakes

- Parameters are **camelCase** not snake_case: `memoryType` not `memory_type`, `trustScore` not `trust_score`
- Use `key=value` syntax with mcporter, not JSON bodies
- Tool names are prefixed with the server name: `engram.engram_retain` not just `engram_retain`
- Don't retain trivial messages ("ok", "thanks", "got it") — they add noise
- Don't forget to run `engram_process_extractions` periodically to build the knowledge graph

## Configuration

The Engram MCP server is configured in your mcporter config file (typically `config/mcporter.json`):

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": [
        "/path/to/engram/dist/mcp-server.js",
        "/path/to/agent.engram"
      ],
      "transport": "stdio"
    }
  }
}
```

Add `--use-ollama-embeddings --ollama-url <url>` to args for Ollama-based embeddings. Default uses local Transformers.js (no external dependency).
