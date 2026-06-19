# Engram ↔ Pi Session Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three LLM tools (`engram_session_resume` / `_update` / `_snapshot`), a `before_agent_start` system-prompt addendum, and a `/session` slash command to the Pi extension at `integrations/pi/`. Pure-adapter Phase 1 pattern preserved; Engram remains the only stateful party.

**Architecture:** New pure functions in `adapter.ts` wrap Engram's `inferWorkingSession` / `updateWorkingSession` / `snapshotWorkingSession`. Binding layer (`index.ts`) registers three Pi tools, one event handler, one slash command, and keeps a single transient module-level `currentSessionId` pointer. Tests use the existing in-memory Engram + deterministic embedder pattern from Phase 1.

**Tech Stack:** TypeScript, TypeBox (Pi tool schemas), Vitest, `@earendil-works/pi-coding-agent` ≥ 0.74.0, Engram (workspace dep via `file:../..`).

**Spec:** `docs/superpowers/specs/2026-05-13-engram-pi-session-bridge-design.md` (commit `a937f7c`).

---

## Task 0: Set up the feature branch

**Files:** none — git only

- [ ] **Step 1: Confirm working tree is clean and on main**

Run:
```bash
git status --short
git rev-parse --abbrev-ref HEAD
```
Expected: empty output for status; `main` for branch.

- [ ] **Step 2: Create the feature branch**

Run:
```bash
git checkout -b feat/pi-session-bridge
```
Expected: `Switched to a new branch 'feat/pi-session-bridge'`.

- [ ] **Step 3: Confirm the spec is reachable**

Run:
```bash
ls docs/superpowers/specs/2026-05-13-engram-pi-session-bridge-design.md
```
Expected: file path echoed.

---

## Task 1: Adapter — `resumeSession`

**Files:**
- Modify: `integrations/pi/src/adapter.ts` (add types + function)
- Modify: `integrations/pi/tests/adapter.test.ts` (add `describe('resumeSession', ...)` block)

- [ ] **Step 1: Write the failing test**

Add to `integrations/pi/tests/adapter.test.ts` (top imports first):

```typescript
import {
  remember,
  recall,
  memoryStats,
  findToForget,
  forgetById,
  looksLikeChunkId,
  resumeSession,        // new
  updateSession,        // new
  snapshotSession,      // new
} from '../src/adapter.js';
```

Then append a new describe block at the bottom of the file (after the existing `findToForget + forgetById` block, still inside the outer `describe('Pi adapter', ...)`):

```typescript
  describe('resumeSession', () => {
    it('creates a new session on a fresh DB (reason "new", confidence 1.0)', async () => {
      const result = await resumeSession(engram, {
        message: 'help me refactor the auth middleware',
      });
      expect(result.sessionId).toMatch(/^wm-/);
      expect(result.reason).toBe('new');
      expect(result.confidence).toBe(1.0);
      expect(result.goal).toContain('auth middleware');
    });

    it('matches an existing session on a similar follow-up message', async () => {
      const first = await resumeSession(engram, {
        message: 'help me refactor the auth middleware',
      });
      const second = await resumeSession(engram, {
        message: 'help me refactor the auth middleware some more',
      });
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.reason).toBe('match');
      expect(second.confidence).toBeLessThan(1.0);
    });

    it('creates a fresh session for an unrelated topic', async () => {
      const first = await resumeSession(engram, {
        message: 'plan the deployment to staging',
      });
      const second = await resumeSession(engram, {
        message: 'compare the cost of two cloud providers',
      });
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(second.reason).toBe('new');
    });

    it('honors a custom threshold', async () => {
      // High threshold should reject the match and create a new session
      const first = await resumeSession(engram, {
        message: 'plan the deployment',
      });
      const second = await resumeSession(engram, {
        message: 'plan the deployment',
        threshold: 0.999,
      });
      expect(second.sessionId).not.toBe(first.sessionId);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd integrations/pi && npx vitest run tests/adapter.test.ts
```
Expected: TypeScript error — `resumeSession is not exported from '../src/adapter.js'` (the imports themselves will fail).

- [ ] **Step 3: Implement `resumeSession` in `adapter.ts`**

Append to `integrations/pi/src/adapter.ts` (after `forgetById`, before end-of-file):

```typescript
// =============================================================================
// Working memory session bridge — Phase 2
//
// Wraps Engram's inferWorkingSession / updateWorkingSession /
// snapshotWorkingSession operations as pure functions over plain types.
// The binding layer (index.ts) carries the LLM-tool surface and one
// transient module-level currentSessionId pointer for the /session command.
// =============================================================================

export interface ResumeSessionInput {
  message: string;
  /** Cosine similarity threshold; defaults to Engram's default (0.55) */
  threshold?: number;
  /** Max active sessions before oldest is snapshotted; defaults to Engram's default (5) */
  maxActive?: number;
}

export interface ResumeSessionOutput {
  sessionId: string;
  goal: string;
  progress?: string;
  relatedContext: string;
  confidence: number;
  reason: 'match' | 'new' | 'forced';
}

export async function resumeSession(
  engram: Engram,
  input: ResumeSessionInput,
): Promise<ResumeSessionOutput> {
  const result = await engram.inferWorkingSession(input.message, {
    threshold: input.threshold,
    maxActive: input.maxActive,
  });
  return {
    sessionId: result.session.id,
    goal: result.session.goal,
    progress:
      typeof result.session.progress === 'string'
        ? result.session.progress
        : undefined,
    relatedContext: result.relatedContext,
    confidence: result.confidence,
    reason: result.diagnostics.reason,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd integrations/pi && npx vitest run tests/adapter.test.ts -t resumeSession
```
Expected: 4 tests pass under the `resumeSession` describe block.

- [ ] **Step 5: Commit**

```bash
git add integrations/pi/src/adapter.ts integrations/pi/tests/adapter.test.ts
git commit -m "feat(pi): adapter resumeSession wraps inferWorkingSession

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Adapter — `updateSession`

**Files:**
- Modify: `integrations/pi/src/adapter.ts` (add types + function)
- Modify: `integrations/pi/tests/adapter.test.ts` (add describe block)

- [ ] **Step 1: Write the failing test**

Append to `integrations/pi/tests/adapter.test.ts` inside the outer `describe('Pi adapter', ...)`:

```typescript
  describe('updateSession', () => {
    it('merges progress into the stored session state', async () => {
      const resumed = await resumeSession(engram, {
        message: 'refactor the auth middleware',
      });
      const updated = await updateSession(engram, {
        sessionId: resumed.sessionId,
        progress: 'Extracted JWT decoder into its own file',
      });
      expect(updated.sessionId).toBe(resumed.sessionId);
      expect(typeof updated.updated_at).toBe('string');

      // Re-resume the same topic — Engram should return the updated progress
      const reloaded = await resumeSession(engram, {
        message: 'refactor the auth middleware',
      });
      expect(reloaded.sessionId).toBe(resumed.sessionId);
      expect(reloaded.progress).toBe('Extracted JWT decoder into its own file');
    });

    it('preserves agent-defined extension keys', async () => {
      const resumed = await resumeSession(engram, {
        message: 'plan the migration',
      });
      await updateSession(engram, {
        sessionId: resumed.sessionId,
        extensions: { ticketIds: ['ENG-42', 'ENG-43'] },
      });

      // Read back via Engram's getWorkingSession (allowed via cast in this test)
      const state = engram.getWorkingSession(resumed.sessionId);
      expect(state).not.toBeNull();
      expect((state as Record<string, unknown>).ticketIds).toEqual([
        'ENG-42',
        'ENG-43',
      ]);
    });

    it('throws when the sessionId is unknown', async () => {
      await expect(
        updateSession(engram, {
          sessionId: 'wm-does-not-exist',
          progress: 'this should fail',
        }),
      ).rejects.toThrow(/not found|expired/i);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd integrations/pi && npx vitest run tests/adapter.test.ts -t updateSession
```
Expected: tests fail because `updateSession` is not yet implemented.

- [ ] **Step 3: Implement `updateSession` in `adapter.ts`**

Append to `integrations/pi/src/adapter.ts` (after `resumeSession`):

```typescript
export interface UpdateSessionInput {
  sessionId: string;
  /** Free-form progress note merged into session state */
  progress?: string;
  /** Agent-defined extension keys merged into session state */
  extensions?: Record<string, unknown>;
}

export interface UpdateSessionOutput {
  sessionId: string;
  updated_at: string;
}

export async function updateSession(
  engram: Engram,
  input: UpdateSessionInput,
): Promise<UpdateSessionOutput> {
  const updates: Record<string, unknown> = { ...(input.extensions ?? {}) };
  if (input.progress !== undefined) {
    updates.progress = input.progress;
  }
  await engram.updateWorkingSession(input.sessionId, updates);
  const reloaded = engram.getWorkingSession(input.sessionId);
  if (!reloaded) {
    throw new Error(
      `Working memory session ${input.sessionId} not found after update`,
    );
  }
  return {
    sessionId: reloaded.id,
    updated_at: reloaded.updated_at,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd integrations/pi && npx vitest run tests/adapter.test.ts -t updateSession
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add integrations/pi/src/adapter.ts integrations/pi/tests/adapter.test.ts
git commit -m "feat(pi): adapter updateSession wraps updateWorkingSession

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Adapter — `snapshotSession`

**Files:**
- Modify: `integrations/pi/src/adapter.ts` (add types + function)
- Modify: `integrations/pi/tests/adapter.test.ts` (add describe block)

- [ ] **Step 1: Write the failing test**

Append to `integrations/pi/tests/adapter.test.ts`:

```typescript
  describe('snapshotSession', () => {
    it('returns the new long-term chunkId and expires the session', async () => {
      const resumed = await resumeSession(engram, {
        message: 'plan the production rollout',
      });
      await updateSession(engram, {
        sessionId: resumed.sessionId,
        progress: 'Drafted the rollback plan; coordinated with SRE',
      });

      const result = await snapshotSession(engram, {
        sessionId: resumed.sessionId,
      });
      expect(result.sessionId).toBe(resumed.sessionId);
      expect(result.chunkId).toMatch(/^chk-/);

      // Session no longer active
      const active = engram.listWorkingSessions();
      expect(active.find((s) => s.id === resumed.sessionId)).toBeUndefined();

      // Re-resume on the same topic creates a NEW session
      const reresumed = await resumeSession(engram, {
        message: 'plan the production rollout',
      });
      expect(reresumed.sessionId).not.toBe(resumed.sessionId);
      expect(reresumed.reason).toBe('new');
    });

    it('throws when the sessionId is unknown', async () => {
      await expect(
        snapshotSession(engram, { sessionId: 'wm-does-not-exist' }),
      ).rejects.toThrow();
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd integrations/pi && npx vitest run tests/adapter.test.ts -t snapshotSession
```
Expected: tests fail — `snapshotSession is not a function`.

- [ ] **Step 3: Implement `snapshotSession` in `adapter.ts`**

Append to `integrations/pi/src/adapter.ts`:

```typescript
export interface SnapshotSessionInput {
  sessionId: string;
}

export interface SnapshotSessionOutput {
  sessionId: string;
  chunkId: string;
}

export async function snapshotSession(
  engram: Engram,
  input: SnapshotSessionInput,
): Promise<SnapshotSessionOutput> {
  const result = await engram.snapshotWorkingSession(input.sessionId);
  return {
    sessionId: input.sessionId,
    chunkId: result.chunkId,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd integrations/pi && npx vitest run tests/adapter.test.ts -t snapshotSession
```
Expected: 2 tests pass.

- [ ] **Step 5: Run all adapter tests to confirm no regression**

Run:
```bash
cd integrations/pi && npx vitest run tests/adapter.test.ts
```
Expected: the full adapter suite (Phase 1 + 3 new describe blocks) passes.

- [ ] **Step 6: Commit**

```bash
git add integrations/pi/src/adapter.ts integrations/pi/tests/adapter.test.ts
git commit -m "feat(pi): adapter snapshotSession wraps snapshotWorkingSession

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: TypeBox schemas for the three new tools

**Files:**
- Modify: `integrations/pi/src/types.ts`

- [ ] **Step 1: Append the schemas**

Append to `integrations/pi/src/types.ts`:

```typescript
// =============================================================================
// Working memory session bridge (Phase 2)
// =============================================================================

export const SessionResumeParams = Type.Object({
  message: Type.String({
    description:
      'The current user message or task description. Used to match an existing working session via embedding similarity, or create a new one.',
  }),
  threshold: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description:
        'Cosine similarity threshold for matching an existing session (default 0.55). Lower = aggressive match; higher = create new sessions more often.',
    }),
  ),
  maxActive: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description:
        'Max concurrent active sessions (default 5). When exceeded, the oldest is snapshotted to long-term memory.',
    }),
  ),
});

export type SessionResumeToolParams = Static<typeof SessionResumeParams>;

export const SessionUpdateParams = Type.Object({
  sessionId: Type.String({
    description:
      'Working memory session id (format: wm-xxx) returned by engram_session_resume.',
    pattern: '^wm-',
  }),
  progress: Type.Optional(
    Type.String({
      description:
        'Free-form progress note. Replaces any previous progress on this session.',
    }),
  ),
  extensions: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'Optional agent-defined keys merged into the session state (e.g. ticket ids, checklist).',
    }),
  ),
});

export type SessionUpdateToolParams = Static<typeof SessionUpdateParams>;

export const SessionSnapshotParams = Type.Object({
  sessionId: Type.String({
    description:
      'Working memory session id to snapshot. The session is collapsed to a long-term episodic chunk and expired.',
    pattern: '^wm-',
  }),
});

export type SessionSnapshotToolParams = Static<typeof SessionSnapshotParams>;
```

- [ ] **Step 2: Verify TypeScript compiles**

Run:
```bash
cd integrations/pi && npx tsc --noEmit
```
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add integrations/pi/src/types.ts
git commit -m "feat(pi): typebox schemas for session bridge tools

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Module-level `currentSessionId` + test-helper updates

**Files:**
- Modify: `integrations/pi/src/index.ts`

This task introduces the single in-memory pointer and threads it through the existing test helpers so test isolation stays intact. The pointer is set by the tools (added in Tasks 6–8). On its own, this task just establishes the variable and the reset wiring.

- [ ] **Step 1: Add `currentSessionId` and exported test helper**

In `integrations/pi/src/index.ts`, locate the existing `let cachedDbPath: string | null = null;` line. Add directly below it:

```typescript
// Module-level transient pointer set by engram_session_* tools so the
// /session slash command can answer "what are you currently working on?"
// Never persisted; lost on reload. Engram remains the only stateful party.
let currentSessionId: string | null = null;
```

- [ ] **Step 2: Update `_setEngineFactoryForTesting` and `_resetEngineFactoryForTesting` to clear the pointer**

In `integrations/pi/src/index.ts`, find:

```typescript
export function _setEngineFactoryForTesting(factory: EngineFactory): void {
  enginePromise = null;
  cachedDbPath = null;
  engineFactory = factory;
}

export function _resetEngineFactoryForTesting(): void {
  enginePromise = null;
  cachedDbPath = null;
  engineFactory = (path) => Engram.open(path);
}
```

Replace with:

```typescript
export function _setEngineFactoryForTesting(factory: EngineFactory): void {
  enginePromise = null;
  cachedDbPath = null;
  currentSessionId = null;
  engineFactory = factory;
}

export function _resetEngineFactoryForTesting(): void {
  enginePromise = null;
  cachedDbPath = null;
  currentSessionId = null;
  engineFactory = (path) => Engram.open(path);
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run:
```bash
cd integrations/pi && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add integrations/pi/src/index.ts
git commit -m "feat(pi): add transient currentSessionId pointer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Register `engram_session_resume` LLM tool

**Files:**
- Modify: `integrations/pi/src/index.ts`

- [ ] **Step 1: Extend the adapter import**

In `integrations/pi/src/index.ts`, find the existing adapter import and replace it:

```typescript
import {
  remember,
  recall,
  memoryStats,
  findToForget,
  forgetById,
  looksLikeChunkId,
  resumeSession,
  updateSession,
  snapshotSession,
} from './adapter.js';
```

- [ ] **Step 2: Extend the types import**

Replace the existing types import with:

```typescript
import {
  RememberParams,
  RecallParams,
  MemoryStatsParams,
  ForgetParams,
  SessionResumeParams,
  SessionUpdateParams,
  SessionSnapshotParams,
  type RememberToolParams,
  type RecallToolParams,
  type ForgetToolParams,
  type SessionResumeToolParams,
  type SessionUpdateToolParams,
  type SessionSnapshotToolParams,
} from './types.js';
```

- [ ] **Step 3: Register the resume tool**

In `integrations/pi/src/index.ts`, find the line after the existing four `pi.registerTool(...)` calls (just before the closing `}` of `engramPiExtension`). Insert:

```typescript
  pi.registerTool({
    name: 'engram_session_resume',
    label: 'Session Resume',
    description:
      'Resume or create a working memory session for the current task. Call early when starting substantive multi-turn work. Returns the session id, goal, prior progress (if any), and related long-term context. Pass the session id to engram_session_update / engram_session_snapshot.',
    parameters: SessionResumeParams,
    async execute(_id, params: SessionResumeToolParams) {
      const engram = await getEngram();
      const result = await resumeSession(engram, {
        message: params.message,
        threshold: params.threshold,
        maxActive: params.maxActive,
      });
      currentSessionId = result.sessionId;
      const summary = [
        `${result.reason === 'new' ? 'New' : 'Resumed'} session ${result.sessionId}`,
        `Goal: ${result.goal}`,
        result.progress ? `Progress: ${result.progress}` : null,
        result.relatedContext ? `\n${result.relatedContext}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        content: [{ type: 'text', text: summary }],
        details: result,
      };
    },
  });
```

- [ ] **Step 4: Verify TypeScript compiles**

Run:
```bash
cd integrations/pi && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add integrations/pi/src/index.ts
git commit -m "feat(pi): register engram_session_resume LLM tool

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Register `engram_session_update` LLM tool

**Files:**
- Modify: `integrations/pi/src/index.ts`

- [ ] **Step 1: Append the update tool**

In `integrations/pi/src/index.ts`, immediately after the `engram_session_resume` tool registration, insert:

```typescript
  pi.registerTool({
    name: 'engram_session_update',
    label: 'Session Update',
    description:
      'Update progress on an active working memory session. Call before turn boundaries you want preserved across sessions. Provide the sessionId from engram_session_resume.',
    parameters: SessionUpdateParams,
    async execute(_id, params: SessionUpdateToolParams) {
      const engram = await getEngram();
      try {
        const result = await updateSession(engram, {
          sessionId: params.sessionId,
          progress: params.progress,
          extensions: params.extensions as
            | Record<string, unknown>
            | undefined,
        });
        currentSessionId = result.sessionId;
        return {
          content: [
            {
              type: 'text',
              text: `Updated ${result.sessionId} (updated_at ${result.updated_at})`,
            },
          ],
          details: result,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Update failed: ${msg}` }],
          isError: true,
          details: { sessionId: params.sessionId, error: msg },
        };
      }
    },
  });
```

- [ ] **Step 2: Verify TypeScript compiles**

Run:
```bash
cd integrations/pi && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add integrations/pi/src/index.ts
git commit -m "feat(pi): register engram_session_update LLM tool

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Register `engram_session_snapshot` LLM tool

**Files:**
- Modify: `integrations/pi/src/index.ts`

- [ ] **Step 1: Append the snapshot tool**

In `integrations/pi/src/index.ts`, immediately after the `engram_session_update` tool registration, insert:

```typescript
  pi.registerTool({
    name: 'engram_session_snapshot',
    label: 'Session Snapshot',
    description:
      'Snapshot a completed working memory session to long-term memory and end it. The session goal + progress are retained as a chunk; the session is then expired. Use when the agent considers a piece of work complete.',
    parameters: SessionSnapshotParams,
    async execute(_id, params: SessionSnapshotToolParams) {
      const engram = await getEngram();
      try {
        const result = await snapshotSession(engram, {
          sessionId: params.sessionId,
        });
        if (currentSessionId === params.sessionId) {
          currentSessionId = null;
        }
        return {
          content: [
            {
              type: 'text',
              text: `Snapshotted ${result.sessionId} → ${result.chunkId}`,
            },
          ],
          details: result,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Snapshot failed: ${msg}` }],
          isError: true,
          details: { sessionId: params.sessionId, error: msg },
        };
      }
    },
  });
```

- [ ] **Step 2: Verify TypeScript compiles**

Run:
```bash
cd integrations/pi && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add integrations/pi/src/index.ts
git commit -m "feat(pi): register engram_session_snapshot LLM tool

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `before_agent_start` system-prompt addendum

**Files:**
- Modify: `integrations/pi/src/index.ts`

- [ ] **Step 1: Add the addendum constant**

In `integrations/pi/src/index.ts`, find the existing `const DEFAULT_DB_RELATIVE = '.engram/pi.db';` line. Add directly below it:

```typescript
const SESSION_ADDENDUM = [
  '',
  'You have access to persistent working memory across sessions via Engram:',
  '- engram_session_resume — call early when starting substantive work; returns prior context if this topic has been worked on before',
  '- engram_session_update — call before turn boundaries to record progress notes',
  '- engram_session_snapshot — call when a piece of work is complete; collapses the session to long-term memory',
  'Use these for multi-turn tasks; prefer engram_recall for one-off lookups.',
].join('\n');
```

- [ ] **Step 2: Register the `before_agent_start` handler**

Inside `engramPiExtension`, immediately after the existing `pi.on('session_shutdown', ...)` block, add:

```typescript
  pi.on('before_agent_start', (event) => {
    try {
      return {
        systemPrompt: `${event.systemPrompt}\n${SESSION_ADDENDUM}`,
      };
    } catch (err) {
      // Never break a turn over the addendum — return nothing so Pi keeps
      // the existing system prompt.
      // eslint-disable-next-line no-console
      console.error(
        'engram-pi: failed to append session addendum:',
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  });
```

- [ ] **Step 3: Verify TypeScript compiles**

Run:
```bash
cd integrations/pi && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add integrations/pi/src/index.ts
git commit -m "feat(pi): append session addendum on before_agent_start

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: `/session` slash command

**Files:**
- Modify: `integrations/pi/src/index.ts`

- [ ] **Step 1: Register the command**

In `integrations/pi/src/index.ts`, after the existing `pi.registerCommand('forget', ...)` block (and before the LLM-tool registrations), insert:

```typescript
  pi.registerCommand('session', {
    description: 'Show the current working session and list active sessions',
    handler: async (_args, ctx) => {
      const engram = await getEngram();
      const active = engram.listWorkingSessions();
      const lines: string[] = [];

      if (currentSessionId) {
        const current = active.find((s) => s.id === currentSessionId);
        if (current) {
          lines.push(`Current: ${current.id} — ${current.goal}`);
          const progress =
            typeof current.progress === 'string' ? current.progress : undefined;
          if (progress) {
            lines.push(`  Progress: ${progress}`);
          }
          lines.push('');
        }
      } else {
        lines.push(
          'No active session in this run — call engram_session_resume to start one.',
        );
        lines.push('');
      }

      if (active.length === 0) {
        lines.push('No active working memory sessions.');
      } else {
        lines.push(`Active sessions (${active.length}):`);
        for (const s of active) {
          const marker = s.id === currentSessionId ? '*' : ' ';
          lines.push(`  ${marker} ${s.id} — ${s.goal}`);
        }
      }

      notifyOrLog(ctx, lines.join('\n'));
    },
  });
```

- [ ] **Step 2: Verify TypeScript compiles**

Run:
```bash
cd integrations/pi && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add integrations/pi/src/index.ts
git commit -m "feat(pi): /session slash command

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Update `smoke-extension.test.ts` for new registrations

**Files:**
- Modify: `integrations/pi/tests/smoke-extension.test.ts`

- [ ] **Step 1: Update the commands assertion**

Find the test `it('registers the four documented slash commands', () => { ... })`. Replace its title and assertion body with:

```typescript
  it('registers the five documented slash commands', () => {
    const { pi, commands } = makeFakePi();
    engramPiExtension(pi);

    const names = commands.map((c) => c.name).sort();
    expect(names).toEqual(['forget', 'memory', 'recall', 'remember', 'session']);

    for (const cmd of commands) {
      expect(typeof cmd.description).toBe('string');
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(typeof cmd.handler).toBe('function');
    }
  });
```

- [ ] **Step 2: Update the LLM-tools assertion**

Find the test `it('registers the four documented LLM tools with engram_ prefix', () => { ... })`. Replace the title and the `expect(names).toEqual([...])` block:

```typescript
  it('registers the seven documented LLM tools with engram_ prefix', () => {
    const { pi, tools } = makeFakePi();
    engramPiExtension(pi);

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'engram_forget',
      'engram_memory_stats',
      'engram_recall',
      'engram_remember',
      'engram_session_resume',
      'engram_session_snapshot',
      'engram_session_update',
    ]);

    for (const t of tools) {
      expect(t.name.startsWith('engram_')).toBe(true);
      expect(typeof t.description).toBe('string');
      expect(t.parameters.type).toBe('object');
      expect(typeof t.execute).toBe('function');
    }
  });
```

- [ ] **Step 3: Update the lifecycle-events test to include `before_agent_start`**

Replace the existing test:

```typescript
  it('subscribes to session_start, session_shutdown, and before_agent_start lifecycle events', () => {
    const { pi, handlers } = makeFakePi();
    engramPiExtension(pi);
    const events = handlers.map((h) => h.event).sort();
    expect(events).toEqual([
      'before_agent_start',
      'session_shutdown',
      'session_start',
    ]);
  });
```

- [ ] **Step 4: Add a new test for session-tool param contracts**

Append inside the `describe('engram-pi extension factory', ...)`:

```typescript
  it('engram_session_resume requires a message parameter', () => {
    const { pi, tools } = makeFakePi();
    engramPiExtension(pi);
    const tool = tools.find((t) => t.name === 'engram_session_resume');
    expect(tool).toBeDefined();
    expect(tool!.parameters.required).toContain('message');
  });

  it('engram_session_update and snapshot require a sessionId matching wm- prefix', () => {
    const { pi, tools } = makeFakePi();
    engramPiExtension(pi);
    for (const name of ['engram_session_update', 'engram_session_snapshot']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `tool ${name} should be registered`).toBeDefined();
      expect(tool!.parameters.required).toContain('sessionId');
      const idSchema = tool!.parameters.properties?.sessionId as
        | { pattern?: string }
        | undefined;
      expect(idSchema?.pattern).toBe('^wm-');
    }
  });

  it('before_agent_start handler returns a systemPrompt containing the session addendum', () => {
    const { pi, handlers } = makeFakePi();
    engramPiExtension(pi);
    const handler = handlers.find((h) => h.event === 'before_agent_start');
    expect(handler).toBeDefined();
    const result = handler!.handler(
      { type: 'before_agent_start', prompt: 'hi', systemPrompt: 'BASE' },
      {},
    ) as { systemPrompt?: string } | undefined;
    expect(result?.systemPrompt).toContain('BASE');
    expect(result?.systemPrompt).toContain('engram_session_resume');
    expect(result?.systemPrompt).toContain('engram_session_update');
    expect(result?.systemPrompt).toContain('engram_session_snapshot');
  });
```

- [ ] **Step 5: Run smoke-extension.test.ts to verify it passes**

Run:
```bash
cd integrations/pi && npx vitest run tests/smoke-extension.test.ts
```
Expected: all tests pass — previously-existing ones still green, new ones green.

- [ ] **Step 6: Commit**

```bash
git add integrations/pi/tests/smoke-extension.test.ts
git commit -m "test(pi): smoke-test session bridge registrations + addendum

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: End-to-end binding test for the session tools

**Files:**
- Create: `integrations/pi/tests/session-bridge.test.ts`

This task wires up a fake Pi API that actually executes tool handlers (not just captures them), so we can verify `currentSessionId` lifecycle, `/session` output, and error paths through the full binding layer.

- [ ] **Step 1: Write the failing test file**

Create `integrations/pi/tests/session-bridge.test.ts`:

```typescript
// =============================================================================
// session-bridge.test.ts — end-to-end binding test for the engram_session_*
// tools, the before_agent_start addendum, and the /session slash command.
//
// Uses a fake ExtensionAPI that actually runs handlers so we can observe
// currentSessionId lifecycle and /session output. The Engram instance is
// real (in-memory SQLite + deterministic embedder) and injected via the
// _setEngineFactoryForTesting hook so we don't pay the model download.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Engram, type EmbeddingProvider } from 'engram';

import engramPiExtension, {
  _setEngineFactoryForTesting,
  _resetEngineFactoryForTesting,
} from '../src/index.js';

class TestEmbedder implements EmbeddingProvider {
  readonly dimensions = 8;
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i < text.length; i++) {
      v[i % this.dimensions] += text.charCodeAt(i) / 256;
    }
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return mag > 0 ? new Float32Array(v.map((x) => x / mag)) : v;
  }
}

interface CapturedCommand {
  name: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
    details?: unknown;
  }>;
}

interface CapturedHandler {
  event: string;
  handler: (event: unknown, ctx: unknown) => unknown;
}

function makeFakePi(): {
  pi: ExtensionAPI;
  commands: Map<string, CapturedCommand>;
  tools: Map<string, CapturedTool>;
  handlers: Map<string, CapturedHandler['handler']>;
  notifications: string[];
} {
  const commands = new Map<string, CapturedCommand>();
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, CapturedHandler['handler']>();
  const notifications: string[] = [];

  const ui = {
    notify: (msg: string) => {
      notifications.push(msg);
    },
    confirm: vi.fn(async () => true),
  };
  const ctx = {
    hasUI: true,
    ui,
  };

  const fake = {
    registerCommand: vi.fn(
      (
        name: string,
        def: {
          description: string;
          handler: (args: string, ctx: unknown) => Promise<void>;
        },
      ) => {
        commands.set(name, {
          name,
          handler: (args: string) => def.handler(args, ctx),
        });
      },
    ),
    registerTool: vi.fn((def: CapturedTool) => {
      tools.set(def.name, def);
    }),
    on: vi.fn((event: string, handler: CapturedHandler['handler']) => {
      handlers.set(event, handler);
    }),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
    appendEntry: vi.fn(),
  };

  return {
    pi: fake as unknown as ExtensionAPI,
    commands,
    tools,
    handlers,
    notifications,
  };
}

describe('session bridge binding', () => {
  beforeEach(() => {
    _setEngineFactoryForTesting(async () =>
      Engram.create(':memory:', { embedder: new TestEmbedder() }),
    );
  });

  afterEach(() => {
    _resetEngineFactoryForTesting();
  });

  it('engram_session_resume sets currentSessionId and /session reflects it', async () => {
    const { pi, tools, commands, notifications } = makeFakePi();
    engramPiExtension(pi);

    const resume = tools.get('engram_session_resume')!;
    const result = await resume.execute('call-1', {
      message: 'refactor the auth middleware',
    });
    expect(result.isError).toBeUndefined();
    const details = result.details as { sessionId: string; reason: string };
    expect(details.sessionId).toMatch(/^wm-/);
    expect(details.reason).toBe('new');

    const session = commands.get('session')!;
    await session.handler('');
    const out = notifications.join('\n');
    expect(out).toContain(`Current: ${details.sessionId}`);
    expect(out).toContain('refactor the auth middleware');
  });

  it('engram_session_update merges progress and keeps currentSessionId set', async () => {
    const { pi, tools, commands, notifications } = makeFakePi();
    engramPiExtension(pi);

    const resume = tools.get('engram_session_resume')!;
    const r = await resume.execute('call-1', {
      message: 'plan the production rollout',
    });
    const sessionId = (r.details as { sessionId: string }).sessionId;

    const update = tools.get('engram_session_update')!;
    const u = await update.execute('call-2', {
      sessionId,
      progress: 'Drafted the rollback plan',
    });
    expect(u.isError).toBeUndefined();

    const session = commands.get('session')!;
    await session.handler('');
    const out = notifications.at(-1) ?? '';
    expect(out).toContain('Progress: Drafted the rollback plan');
  });

  it('engram_session_snapshot clears currentSessionId on the snapshotted id', async () => {
    const { pi, tools, commands, notifications } = makeFakePi();
    engramPiExtension(pi);

    const resume = tools.get('engram_session_resume')!;
    const r = await resume.execute('call-1', { message: 'audit dependencies' });
    const sessionId = (r.details as { sessionId: string }).sessionId;

    const snapshot = tools.get('engram_session_snapshot')!;
    const s = await snapshot.execute('call-2', { sessionId });
    expect(s.isError).toBeUndefined();
    const sDetails = s.details as { chunkId: string };
    expect(sDetails.chunkId).toMatch(/^chk-/);

    const session = commands.get('session')!;
    await session.handler('');
    const out = notifications.at(-1) ?? '';
    expect(out).toContain('No active session');
  });

  it('engram_session_update returns isError on unknown sessionId', async () => {
    const { pi, tools } = makeFakePi();
    engramPiExtension(pi);

    const update = tools.get('engram_session_update')!;
    const result = await update.execute('call-1', {
      sessionId: 'wm-does-not-exist',
      progress: 'this should fail',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Update failed/);
  });

  it('engram_session_snapshot returns isError on unknown sessionId', async () => {
    const { pi, tools } = makeFakePi();
    engramPiExtension(pi);

    const snapshot = tools.get('engram_session_snapshot')!;
    const result = await snapshot.execute('call-1', {
      sessionId: 'wm-does-not-exist',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Snapshot failed/);
  });
});
```

- [ ] **Step 2: Run the new test**

Run:
```bash
cd integrations/pi && npx vitest run tests/session-bridge.test.ts
```
Expected: 5 tests pass.

- [ ] **Step 3: Run the full Pi test suite**

Run:
```bash
cd integrations/pi && npx vitest run
```
Expected: all tests across `adapter.test.ts`, `smoke-extension.test.ts`, `integration-smoke.test.ts`, and `session-bridge.test.ts` pass.

- [ ] **Step 4: Commit**

```bash
git add integrations/pi/tests/session-bridge.test.ts
git commit -m "test(pi): end-to-end session bridge binding tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Update the engram-session skill with a Pi section

**Files:**
- Modify: `skills/engram-session.md`

- [ ] **Step 1: Append the Pi section to the skill**

Append to `skills/engram-session.md` (after the existing "Integration Pattern" code block at end of file):

```markdown

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
```

- [ ] **Step 2: Commit**

```bash
git add skills/engram-session.md
git commit -m "docs(skill): document Pi adapter session bridge usage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Update `docs/PI-INTEGRATION.md`

**Files:**
- Modify: `docs/PI-INTEGRATION.md`

- [ ] **Step 1: Update the Status line**

Find the line near the top:

```markdown
**Status:** Phase 1. Slash commands and LLM tools for `remember / recall / memory / forget` are implemented and tested. Reflection scheduling, auto-retain on `tool_call` / `message_end`, and `engram_session` (working memory) integration are deferred to Phase 2.
```

Replace with:

```markdown
**Status:** Phase 1 + working-memory bridge. Slash commands and LLM tools for `remember / recall / memory / forget / session` are implemented and tested; LLM-callable `engram_session_resume / _update / _snapshot` tools plus a `before_agent_start` system-prompt addendum land Phase 2's session bridge. Reflection scheduling and auto-retain on `tool_call` / `message_end` remain deferred.
```

- [ ] **Step 2: Extend the slash-commands table**

Find the slash-commands table (with the `| /remember` / `| /recall` / `| /memory` / `| /forget` rows). Append a row:

```markdown
| `/session` | Show the most recently touched working session + list active ones |
```

- [ ] **Step 3: Extend the LLM-tools table**

Find the LLM-tools table. Append three rows:

```markdown
| `engram_session_resume` | Resume or create a working memory session for the current task | `message` |
| `engram_session_update` | Update progress on an active session | `sessionId`, `progress` |
| `engram_session_snapshot` | Snapshot a completed session to long-term memory and end it | `sessionId` |
```

- [ ] **Step 4: Replace the "What's next" section**

Find the section starting with `## What's next (deferred from Phase 1)`. Replace its body (the bulleted list) with:

```markdown
Tracked in `tasks/todo.md`:

- Triggering `engram.processExtractions()` and `engram.reflect()` on `turn_end` or `session_shutdown`
- Optional auto-retain of conversation turns as `experience`-type chunks (with gating to avoid noise)
- Custom UI components via Pi's `ctx.ui.custom()` (e.g., a memory inspector widget)
- Publishing as `pi install`-able package
```

(The `engram_session` line is removed because it now ships.)

- [ ] **Step 5: Commit**

```bash
git add docs/PI-INTEGRATION.md
git commit -m "docs(pi): document session bridge tools, /session, and addendum

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Update `tasks/todo.md`

**Files:**
- Modify: `tasks/todo.md`

- [ ] **Step 1: Update the status block**

Find the lines:

```markdown
- **Pi.dev extension (Phase 1)** — merged via PR #2. Four slash commands (`/remember`, `/recall`, `/memory`, `/forget`) and four LLM tools (`engram_remember`, `engram_recall`, `engram_memory_stats`, `engram_forget`). Lives at `integrations/pi/`.
- **Main suite:** 336 tests across 19 files, all green. Format + lint clean.
- **Pi extension suite:** 28 tests in `integrations/pi/` (independent dep closure, run via `cd integrations/pi && npx vitest run`).
```

Replace with:

```markdown
- **Pi.dev extension (Phase 1)** — merged via PR #2. Four slash commands (`/remember`, `/recall`, `/memory`, `/forget`) and four LLM tools (`engram_remember`, `engram_recall`, `engram_memory_stats`, `engram_forget`). Lives at `integrations/pi/`.
- **Pi.dev extension — working-memory bridge** — shipped on this branch. Adds `/session` slash command, three LLM tools (`engram_session_resume`, `engram_session_update`, `engram_session_snapshot`), and a `before_agent_start` system-prompt addendum nudging the agent toward Engram. Spec: `docs/superpowers/specs/2026-05-13-engram-pi-session-bridge-design.md`.
- **Main suite:** all green. Format + lint clean.
- **Pi extension suite:** all green (run via `cd integrations/pi && npx vitest run`).
```

- [ ] **Step 2: Remove the completed item from "Phase 2 — Pi adapter"**

Find and delete this entry:

```markdown
- [ ] **`engram_session` ↔ Pi session persistence**
  Pi already persists sessions via `pi.appendEntry()`. Engram has the `working_memory` table. Map them without double-persistence — the right answer is probably "Engram owns long-term, Pi owns conversation flow; don't mirror state."
```

- [ ] **Step 3: Commit**

```bash
git add tasks/todo.md
git commit -m "docs(todo): mark Pi session bridge as shipped

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Final verification

**Files:** none — verification only

- [ ] **Step 1: Run the full Pi test suite**

Run:
```bash
cd integrations/pi && npx vitest run
```
Expected: all tests pass (Phase 1 + new session bridge tests).

- [ ] **Step 2: Verify TypeScript builds cleanly**

Run:
```bash
cd integrations/pi && npx tsc --noEmit
```
Expected: no output.

- [ ] **Step 3: Build the extension dist**

Run:
```bash
cd integrations/pi && npm run build
```
Expected: `dist/index.js`, `dist/adapter.js`, `dist/types.js` generated.

- [ ] **Step 4: Run the root Engram suite to confirm no library-side regression**

Run (from the repo root):
```bash
npx vitest run
```
Expected: all root tests pass.

- [ ] **Step 5: Lint + format check**

Run:
```bash
npm run format -- --check
npm run lint
```
Expected: clean.

- [ ] **Step 6: Inspect commit history on the branch**

Run:
```bash
git log --oneline main..HEAD
```
Expected: roughly 14 commits, one per task (Tasks 1–15 each commit once; Task 0 has no commit; Task 16 has no commit).

- [ ] **Step 7: Hand off**

Report back with:
- Commit count
- Test-suite output summary
- A note suggesting `gh pr create` when the user is ready

---

## Self-Review

**Spec coverage** — walked the spec section-by-section against the plan:
- API surface (3 tools) → Tasks 6, 7, 8 ✓
- Adapter pure functions → Tasks 1, 2, 3 ✓
- TypeBox schemas → Task 4 ✓
- `currentSessionId` module state + test-helper updates → Task 5 ✓
- `before_agent_start` addendum → Task 9 ✓
- `/session` slash command → Task 10 ✓
- Adapter tests against in-memory Engram → Tasks 1, 2, 3 ✓
- Binding tests → Task 12 ✓
- Smoke registration tests → Task 11 ✓
- Skill update → Task 13 ✓
- `docs/PI-INTEGRATION.md` update → Task 14 ✓
- `tasks/todo.md` update → Task 15 ✓
- Final verification → Task 16 ✓

**Placeholder scan** — no "TBD", "TODO", or "implement later" in the plan body.

**Type consistency:**
- `resumeSession` / `updateSession` / `snapshotSession` are referenced identically across adapter (Tasks 1–3), binding (Tasks 6–8), and tests (Tasks 11–12)
- TypeBox schema names `SessionResumeParams` / `SessionUpdateParams` / `SessionSnapshotParams` (Task 4) match the imports in Task 6 (binding)
- The `^wm-` pattern in TypeBox schemas (Task 4) matches what Task 11's smoke test asserts
- `engram_session_*` tool names match between Task 6–8 (registration), Task 11 (smoke assertions), and Task 12 (e2e tests)
- The addendum constant `SESSION_ADDENDUM` defined in Task 9 contains the substrings (`engram_session_resume`, `_update`, `_snapshot`) asserted by Task 11's addendum test
