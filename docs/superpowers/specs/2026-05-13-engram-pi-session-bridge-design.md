# Engram ↔ Pi Working-Memory Session Bridge — Design

**Date:** 2026-05-13
**Status:** Draft (awaiting review)
**Repo:** swift-innovate/engram
**Phase:** Pi adapter Phase 2 — first deliverable
**Related:** `integrations/pi/` (Phase 1 — slash commands + 4 LLM tools)

## Summary

Phase 2 of the Pi.dev adapter exposes Engram's working-memory surface to the Pi
coding agent. The LLM gains three new tools — `engram_session_resume`,
`engram_session_update`, `engram_session_snapshot` — wrapping Engram's
`inferWorkingSession` / `updateWorkingSession` / `snapshotWorkingSession`
operations. A short system-prompt addendum, appended via `before_agent_start`,
tells the agent when to reach for them. A user-facing `/session` slash command
lists active sessions and highlights the current one.

The design's central invariant is **Engram is the only stateful party.** Pi
does not persist any session-bridge state to its session file. The Pi
extension keeps one transient in-memory pointer (`currentSessionId`) purely so
the `/session` slash command can answer "what are you working on right now?";
that pointer is lost on reload and reconstructed implicitly the next time the
LLM calls `engram_session_resume`. Engram's embedding-similarity matching
re-attaches the agent to the right working session whenever the topic of the
next prompt aligns with an existing session.

## Why This Architecture

Pi already owns conversation flow: session files, the `AgentMessage` stream,
`pi.appendEntry` for ephemeral state, and context compaction. Engram's
`working_memory` table does something subtly different — it clusters work by
**topic** rather than by Pi-session boundary. One Pi session can touch
multiple working sessions; one working session can span multiple Pi sessions
when a user returns days later to the same topic.

Mirroring Pi's session identity into Engram, or persisting Engram's
`sessionId` into Pi's session file, would mean two places to keep in sync and
two reconciliation paths to debug. The alternative — letting Engram own all
working-memory state and re-attaching via embedding similarity on each
`resume` call — has no synchronisation problem at all, because there is no
duplicated state to drift.

The cost is one extra tool call per "topic boundary" inside the agent's
context window, and re-running embedding match on prompts that the agent
could in principle remember. Both are cheap: an embedding match against five
active sessions is sub-millisecond once the model is warm, and the tool call
itself is just JSON.

## Goals

1. Give the Pi agent a persistent working-memory surface across Pi sessions
   without changing Pi's own session model.
2. Match the Phase 1 adapter's purity contract: `adapter.ts` knows only Engram
   types; `index.ts` handles Pi types, registration, and lifecycle.
3. Promote Engram from "available tool" to "first-class memory layer" via a
   short system-prompt addendum — *instruction*, not auto-injected data.
4. Land in a single PR with full test coverage against a real in-memory
   Engram (mirrors Phase 1's testing pattern).
5. Leave Pi's session persistence, compaction, and conversation flow
   unchanged.

## Non-Goals

- Auto-inject Engram context into the system prompt or conversation messages
  (this is the "magic" mode explicitly rejected in brainstorming Q1).
- Auto-call `engram_session_resume` from `before_agent_start` (rejected for
  the same reason — agent invocation must be explicit).
- Hook into Pi's compaction (`session_before_compact`) — Engram is not a
  compaction target in this phase.
- Persist any bridge state to Pi's session file (no `appendEntry` calls).
- Expose `listWorkingSessions` or `getWorkingSession` as LLM tools (admin/
  internal; the slash command covers the human-facing inspection need).
- Add reflection or auto-retain hooks — those are separate Phase 2 items in
  `tasks/todo.md`.

## Architecture

```
                                Pi coding agent
                                       │
                                       │ (before_agent_start)
                                       ▼
                         ┌───────────────────────────────┐
                         │  engram-pi extension          │
                         │                               │
                         │   addendum injected into      │
                         │   system prompt every turn    │
                         │                               │
                         │   LLM tool surface:           │
                         │     engram_session_resume     │
                         │     engram_session_update     │
                         │     engram_session_snapshot   │
                         │                               │
                         │   /session slash command      │
                         │                               │
                         │   in-memory:                  │
                         │     currentSessionId ─────────┐
                         └───────────────┬───────────────┘
                                         │                │
                                         ▼                │
                              ┌─────────────────────┐     │
                              │   adapter.ts        │     │
                              │  (pure functions)   │     │
                              │                     │     │
                              │  resumeSession      │     │
                              │  updateSession      │     │
                              │  snapshotSession    │     │
                              └──────────┬──────────┘     │
                                         │                │
                                         ▼                │
                              ┌─────────────────────┐     │
                              │      Engram         │     │
                              │                     │     │
                              │  inferWorkingSession│◄────┘
                              │  updateWorkingSession    only Engram
                              │  snapshotWorkingSession  has persistent
                              │                     │    state
                              │  .engram/pi.db      │
                              └─────────────────────┘
```

## Components

### Adapter — `integrations/pi/src/adapter.ts`

Three new pure functions added alongside the existing Phase 1 functions
(`remember`, `recall`, `memoryStats`, `forgetById`, `findToForget`). Each
takes an `Engram` and a plain input object, returns a plain result object,
and knows nothing about Pi types.

```typescript
export interface ResumeSessionInput {
  message: string;
  threshold?: number;          // cosine match threshold; default per Engram
  maxActive?: number;          // active-session cap; default per Engram
}

export interface ResumeSessionOutput {
  sessionId: string;
  goal: string;
  progress?: string;
  relatedContext: string;      // formatted long-term context (formatForPrompt)
  confidence: number;          // 1.0 = brand-new session
  reason: 'match' | 'new' | 'forced';
}

export async function resumeSession(
  engram: Engram,
  input: ResumeSessionInput,
): Promise<ResumeSessionOutput>;

export interface UpdateSessionInput {
  sessionId: string;
  progress?: string;
  extensions?: Record<string, unknown>;  // arbitrary agent-defined state
}

export interface UpdateSessionOutput {
  sessionId: string;
  updated_at: string;
}

export async function updateSession(
  engram: Engram,
  input: UpdateSessionInput,
): Promise<UpdateSessionOutput>;

export interface SnapshotSessionInput {
  sessionId: string;
}

export interface SnapshotSessionOutput {
  sessionId: string;
  chunkId: string;             // long-term episodic chunk created by snapshot
}

export async function snapshotSession(
  engram: Engram,
  input: SnapshotSessionInput,
): Promise<SnapshotSessionOutput>;
```

Error handling: `updateSession` and `snapshotSession` re-throw Engram errors
(unknown sessionId, expired session) so the binding layer can convert them to
`isError: true` tool results without losing the original message. The pure
adapter does not need to know about MCP/tool-result conventions.

### Binding — `integrations/pi/src/index.ts`

Additions to the existing factory:

1. **Three `pi.registerTool(...)` calls** with TypeBox schemas defined in
   `types.ts` alongside the Phase 1 schemas. Each tool's `execute`:
   - Calls `getEngram()` (existing lazy opener).
   - Calls the matching adapter function.
   - On success: updates module-level `currentSessionId` (set on resume/
     update; cleared on snapshot).
   - On error: returns `{ content: [{ type: 'text', text: <error msg> }],
     isError: true }`. Schema-level validation handles malformed args.
2. **One `pi.on('before_agent_start', ...)` handler** that returns
   `{ systemPrompt: event.systemPrompt + '\n\n' + SESSION_ADDENDUM }`.
   Deterministic suffix; Pi's prompt-caching handles the cost.
3. **One `pi.registerCommand('session', ...)`** that lists active sessions
   newest-first, marking the row matching `currentSessionId` as
   "(current)". When `currentSessionId` is `null`, the command says
   "No active session in this run — call engram_session_resume to start
   one." No subcommands in this PR.

### Module-level state

```typescript
let currentSessionId: string | null = null;
```

Set by the three tools' success paths. Cleared by `snapshotSession`. Read by
the `/session` slash command. Not persisted anywhere. Both Phase 1 test
helpers (`_setEngineFactoryForTesting`, `_resetEngineFactoryForTesting`) are
extended to also clear this pointer so test isolation stays intact.

### System-prompt addendum

```
You have access to persistent working memory across sessions via Engram:
- engram_session_resume — call early when starting substantive work; returns prior context if this topic has been worked on before
- engram_session_update — call before turn boundaries to record progress notes
- engram_session_snapshot — call when a piece of work is complete; collapses the session to long-term memory
Use these for multi-turn tasks; prefer engram_recall for one-off lookups.
```

Stored as `SESSION_ADDENDUM` constant in `index.ts`. Single canonical
location; appended every turn via the `before_agent_start` handler.

### Skill update — `skills/engram-session.md`

The existing skill (which documents the MCP `engram_session` tool) gains a
"Using the Pi adapter" section pointing to the three new tool names and a
worked example showing the resume → update → snapshot loop in a Pi session.

## Data Flow

A typical multi-turn Pi session:

```
turn 1 (user): "help me refactor the auth middleware"
  ├── before_agent_start adds addendum to system prompt
  ├── agent calls engram_session_resume({ message: "..." })
  │   → Engram: no match (confidence 1.0); creates wm-abc
  │   → currentSessionId = 'wm-abc'
  │   → returns { sessionId, goal: "...", relatedContext: "...", reason: 'new' }
  └── agent works on the task using returned context

turn 3 (agent, end of turn):
  ├── agent calls engram_session_update({ sessionId: 'wm-abc',
  │                                       progress: "Extracted JWT decoder..." })
  │   → Engram updates working_memory row, re-embeds seed query
  │   → currentSessionId already 'wm-abc'

(user runs /session)
  └── extension prints: "Current: wm-abc — refactor the auth middleware
      Progress: Extracted JWT decoder..."

turn 6 (agent, work complete):
  ├── agent calls engram_session_snapshot({ sessionId: 'wm-abc' })
  │   → Engram collapses state to a 'experience' chunk (chk-xyz),
  │     marks wm-abc expired
  │   → currentSessionId = null
  │   → returns { sessionId, chunkId: 'chk-xyz' }

(Pi session ends, user returns three days later in a fresh Pi session)

turn 1 (user): "let's keep working on the auth middleware refactor"
  ├── agent calls engram_session_resume
  ├── Engram: embedding match against wm-abc fails (expired/snapshotted)
  │           but semantic recall surfaces chk-xyz in relatedContext
  ├── Engram: creates wm-def as a new session, with chk-xyz in returned context
  └── agent picks up with full prior progress visible in relatedContext
```

## Error Handling

| Path | Failure mode | Behavior |
|------|--------------|----------|
| `engram_session_resume` | Engram open/embed failure | Tool returns `isError: true` with message; `currentSessionId` unchanged |
| `engram_session_update` | Unknown / expired `sessionId` | Tool returns `isError: true`; pointer unchanged |
| `engram_session_snapshot` | Unknown / expired `sessionId` | Tool returns `isError: true`; pointer unchanged |
| `before_agent_start` handler throws | Pi treats extension error as non-fatal | No addendum appended this turn; agent still has tools available |
| `/session` runs before any tool call | `currentSessionId === null` | Print "No active session in this run" + list active sessions from Engram |

The `before_agent_start` handler must be defensive: a thrown error should not
break the turn. Wrap the addendum append in a try/catch that logs to stderr
and returns nothing (Pi treats no-result as "no change").

## Testing

Mirrors Phase 1's `integrations/pi/tests/` structure. All tests run against a
real Engram with an in-memory SQLite (`:memory:`) and the deterministic test
embedder injected via `_setEngineFactoryForTesting`.

**Adapter unit tests** (`adapter.test.ts` additions):
- `resumeSession` on a fresh DB → new session (`reason: 'new'`, confidence 1.0)
- `resumeSession` with a follow-up message similar to the seed → match
  (`reason: 'match'`, confidence > threshold)
- `resumeSession` with an unrelated follow-up → new session
- `updateSession` merges `progress` into stored state; subsequent `get`
  returns merged state
- `updateSession` with `extensions` preserves agent-defined keys
- `updateSession` with unknown sessionId → throws Engram error
- `snapshotSession` returns chunkId; session no longer appears in
  `listWorkingSessions`; subsequent `resume` on same topic creates a new
  session
- `snapshotSession` with unknown sessionId → throws Engram error

**Binding tests** (new `session-bridge.test.ts`):
- All three tools register with Pi's fake API
- `before_agent_start` handler returns `systemPrompt` containing the
  addendum
- After `engram_session_resume`, `currentSessionId` is set; after
  `engram_session_snapshot`, it's cleared
- `/session` slash command output includes the current session line when
  `currentSessionId` is set; lists "No active session" otherwise
- Tool errors (unknown sessionId) return `isError: true` without throwing
  past the binding boundary

**Skill consumer test** (lightweight — read-only assertion):
- `skills/engram-session.md` mentions all three tool names (regex sanity
  check, not full content validation)

## Backwards Compatibility

Adds tools and a slash command; removes nothing. Phase 1 tool surface
(`engram_remember`, `engram_recall`, `engram_memory_stats`, `engram_forget`)
is unchanged. The `before_agent_start` handler is additive; chains correctly
with any other extension's handlers per Pi's documented behavior ("If
multiple extensions return this, they are chained.").

## File Manifest

| Path | Change |
|------|--------|
| `integrations/pi/src/adapter.ts` | Add `resumeSession`, `updateSession`, `snapshotSession` + their I/O types |
| `integrations/pi/src/types.ts` | Add TypeBox schemas for the three new tools |
| `integrations/pi/src/index.ts` | Register tools, add `before_agent_start` handler, add `/session` command, add module-level `currentSessionId` |
| `integrations/pi/tests/adapter.test.ts` | Extend with session-bridge cases |
| `integrations/pi/tests/session-bridge.test.ts` | New file — binding + lifecycle tests |
| `skills/engram-session.md` | Add "Using the Pi adapter" section |
| `docs/PI-INTEGRATION.md` | Document the three new tools, the addendum, the `/session` command; move from "deferred" to "shipped" |
| `tasks/todo.md` | Move `engram_session ↔ Pi persistence` from open to done; update status block |

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Addendum bloat over Pi's other extensions chaining handlers | Keep addendum to 5 lines; benchmark token cost in a Pi session with no other extensions vs with all four Engram extensions active |
| LLM calls `update` constantly, polluting `working_memory.seed_query` and skewing embedding match | Phase 2 doesn't gate this; we observe in practice. If it becomes a problem, add a debounce in the adapter (`updateSession` only re-embeds when `progress` changes substantially) |
| `currentSessionId` going stale when LLM works across multiple sessions in one Pi run | Acceptable — `/session` is best-effort UX; the LLM's own context is authoritative. Each tool call updates the pointer to whatever was most recently touched |
| Addendum encourages LLM to call `resume` on trivial prompts | The wording ("substantive work", "multi-turn tasks") biases against this. We can tighten in a follow-up if needed |
| Snapshot called accidentally by LLM | Snapshot's only effect is collapsing state to a long-term chunk and expiring the session — both reversible in the sense that data is not lost. Worst case is a slightly fragmented working-session history |

## Phase 3 (not in scope)

Items intentionally deferred:

- `engram_session_list` LLM tool (admin surface)
- `/session snapshot <id>` / `/session resume <id>` subcommands
- Auto-snapshot on `session_shutdown` (would require Pi-side state to know
  which session to snapshot)
- Auto-update on `turn_end` with the agent's last message as progress
- Cross-extension event for "working session changed" so other extensions
  can react

## Open Questions

None blocking implementation. The addendum wording is the highest-confidence
guess; we may want to tune it after observing actual agent behavior in real
Pi sessions.
