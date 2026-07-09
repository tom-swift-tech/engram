# Engram Session Management Skill

## Description

Working memory session management for multi-topic conversations. Sessions auto-match incoming messages to active topics via embedding similarity, allowing seamless topic switching without explicit session tracking.

## When to Use `engram_session` vs `engram_recall`

| Scenario | Tool |
|----------|------|
| Starting a conversation turn | `engram_session` — sets up session context + loads related memories |
| Ad-hoc knowledge lookup mid-turn | `engram_recall` — quick search without session overhead |
| User switches topics | `engram_session` — auto-detects topic change, resumes or creates session |
| Background memory retrieval | `engram_recall` — no session state needed |

**Rule of thumb:** Use `engram_session` once at the start of each user turn. Use `engram_recall` for additional targeted queries within the turn.

## Session Lifecycle

```
User message arrives
    │
    ▼
engram_session(message="...")
    │
    ├─ Embeds message
    ├─ Cosine-matches against active sessions
    │
    ├─ Score >= threshold (default 0.55)
    │   └─ RESUME existing session
    │       └─ Returns: session state + related long-term context
    │
    └─ Score < threshold
        └─ CREATE new session
            ├─ If maxActive reached: snapshot oldest session to long-term memory
            └─ Returns: new session state + related long-term context
```

## Parameters

```bash
npx mcporter call engram.engram_session message="plan the deployment" threshold=0.55 maxActive=5
```

| Parameter | Default | Effect |
|-----------|---------|--------|
| `message` | (required) | The user message to match |
| `threshold` | 0.55 | Cosine similarity threshold. Lower = more aggressive matching (fewer new sessions). Higher = more new sessions. |
| `maxActive` | 5 | Max concurrent sessions. When exceeded, the oldest untouched session is snapshotted to long-term episodic memory and expired. |

## Response Shape

```json
{
  "session": {
    "id": "wm-abc123",
    "goal": "Plan the production deployment",
    "progress": "Identified 3 migrations pending...",
    "updated_at": "2026-07-09T12:00:00Z"
  },
  "relatedContext": "## Relevant Memory Context\n- Tom prefers blue/green deployments...",
  "confidence": 0.82,
  "diagnostics": {
    "sessionId": "wm-abc123",
    "reason": "match",
    "candidatesEvaluated": 3
  }
}
```

- `confidence: 1.0` = new session was created
- `confidence: < 1.0` = existing session was resumed (value = cosine similarity)
- `relatedContext` is pre-formatted for injection into system prompts
- `session.goal` seeds the `recall()` query for context loading

## Updating Session Progress

`engram_session` takes an `action` field: `resume` (default — omit `action`
entirely for the original, backward-compatible behavior above), `update`, and
`snapshot`. `update`/`snapshot` require `sessionId` (the id returned by a prior
resume).

After the agent responds, update the session with what was accomplished:

```bash
npx mcporter call engram.engram_session action=update sessionId=wm-abc123 \
  progress="Queried prod — v2.3.1. Found 3 pending migrations. Drafted rollback plan."
```

`extensions` (an object) merges agent-defined fields into the session state
alongside or instead of `progress`:

```bash
npx mcporter call engram.engram_session action=update sessionId=wm-abc123 \
  extensions='{"blockedOn": "waiting on staging approval"}'
```

Returns the full updated session state (id, goal, progress, updated_at, plus
any extension fields). Errors (isError, "not found") if `sessionId` doesn't
resolve to an active session.

This wraps the same `engram.updateWorkingSession()` method the direct API and
the Pi adapter use — no behavior difference between them.

## Tuning the Threshold

| Threshold | Behavior | Best for |
|-----------|----------|----------|
| 0.4 | Aggressively matches — almost always resumes | Single-topic agents |
| 0.55 | Balanced (default) — handles topic drift | Multi-topic conversations |
| 0.72 | Conservative — creates new sessions often | Agents handling unrelated requests |

## Cleanup Patterns

### Snapshot and close a session

When work on a topic is complete, snapshot the session to long-term memory:

```bash
npx mcporter call engram.engram_session action=snapshot sessionId=wm-abc123
# Returns { sessionId, chunkId, queued, ... } — goal + progress are retained
# as an 'experience' chunk (chunkId) and the session is then expired.
```

Or via the direct API:

```typescript
await engram.snapshotWorkingSession(sessionId);
// Goal + progress are retained as an 'experience' chunk
// Session is then expired
```

### Expire stale sessions

Run periodically (e.g. hourly) to clean up abandoned sessions:

```typescript
const expired = await engram.expireStaleWorkingSessions(48); // hours
// Returns count of sessions expired (without snapshot)
```

### Clear without snapshot

When a session should be discarded (e.g. test/debug sessions):

```typescript
await engram.clearWorkingSession(sessionId);
```

## Integration Pattern

```typescript
async function handleMessage(userInput: string) {
  // 1. Infer/resume session + get related long-term context
  const { session, relatedContext } = await engram.inferWorkingSession(userInput);

  // 2. Build prompt
  const systemPrompt = `${basePrompt}

## Current Task
Goal: ${session.goal}
${session.progress ? `Progress: ${session.progress}` : ''}

## Memory Context
${relatedContext}`;

  // 3. Call LLM
  const response = await callLLM(userInput, systemPrompt);

  // 4. Update session progress
  await engram.updateWorkingSession(session.id, {
    progress: extractProgress(response),
  });

  return response;
}

// Background maintenance
setInterval(() => engram.expireStaleWorkingSessions(48), 60 * 60 * 1000);
```

## Using the Pi adapter

When the engram-pi extension is loaded in a Pi session, the working-memory
surface is exposed as three LLM-callable tools:

| Tool | Use it when |
|------|-------------|
| `engram_session_resume` | Starting a multi-turn task. Pass the user's request as `message`. Returns the session id, prior progress (if matched), and pre-formatted long-term context. |
| `engram_session_update` | Before a turn boundary you want preserved across sessions. Pass `sessionId` from resume + a free-form `progress` string. |
| `engram_session_snapshot` | When a piece of work is complete. Collapses the session to long-term memory and ends it. |

The Pi extension also exposes a `/session` slash command that lists active
sessions and highlights the one most recently touched in the current Pi run.

### Worked example

```
turn 1 (user): "let's refactor the auth middleware"
  ↓ agent: engram_session_resume({ message: "refactor the auth middleware" })
  ← { sessionId: "wm-abc", reason: "new", goal: "...", relatedContext: "..." }

turn 3 (agent, before responding): engram_session_update({
    sessionId: "wm-abc",
    progress: "Extracted JWT decoder into auth/jwt.ts"
  })
  ← { sessionId: "wm-abc", updated_at: "..." }

turn 6 (agent, work done): engram_session_snapshot({ sessionId: "wm-abc" })
  ← { sessionId: "wm-abc", chunkId: "chk-xyz" }
```

When the user returns three days later with `"keep working on the auth refactor"`,
the agent calls `engram_session_resume` again. Engram's embedding match against
the (now-expired) `wm-abc` fails, but the long-term episodic chunk `chk-xyz`
surfaces in `relatedContext`, so the agent picks up with full prior progress
visible.
