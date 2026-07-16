// =============================================================================
// types.ts — typebox parameter schemas for the LLM-callable tools.
//
// Pi tools accept JSON-Schema-shaped parameter definitions; typebox builds
// these from TypeScript with full static type inference, so the executor
// gets typed `params` for free.
// =============================================================================

import { Type, type Static } from 'typebox';

export const RememberParams = Type.Object({
  text: Type.String({ description: 'The fact, decision, or context to remember' }),
  source: Type.Optional(
    Type.String({
      description:
        "Source identifier (e.g. 'conversation:session-id', 'file:path/to/x.md'). Defaults to 'pi:tool'.",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description:
        "Freeform context tag (e.g. 'project:foo', 'topic:auth'). Improves later filtering.",
    }),
  ),
  trustScore: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description:
        'Confidence in the fact. 0.85 typical for user-stated info; 0.6 for inference.',
    }),
  ),
});

export type RememberToolParams = Static<typeof RememberParams>;

export const RecallParams = Type.Object({
  query: Type.String({
    description:
      'Natural-language query. Temporal phrases ("last week", "yesterday") are auto-parsed.',
  }),
  topK: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: 'Max number of results to return (default 5)',
    }),
  ),
  minTrust: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: 'Minimum trust score filter (default 0)',
    }),
  ),
  memoryTypes: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal('world'),
        Type.Literal('experience'),
        Type.Literal('observation'),
        Type.Literal('opinion'),
      ]),
      { description: 'Filter to specific memory types. Omit to search all.' },
    ),
  ),
  after: Type.Optional(
    Type.String({
      description: 'ISO 8601 date — only include facts after this date.',
    }),
  ),
  before: Type.Optional(
    Type.String({
      description: 'ISO 8601 date — only include facts before this date.',
    }),
  ),
  strategies: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal('semantic'),
        Type.Literal('keyword'),
        Type.Literal('graph'),
        Type.Literal('temporal'),
      ]),
      { description: 'Retrieval strategies to use. Omit to use all four.' },
    ),
  ),
  minScore: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description:
        'Drop results whose final weighted relevance score falls below this threshold (default: no filtering).',
    }),
  ),
  explainScores: Type.Optional(
    Type.Boolean({
      description:
        'When true, each result includes a strategyScores breakdown of the per-strategy rank/score that produced its final ranking (default: false).',
    }),
  ),
  decayHalfLifeDays: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Recency decay half-life in days for this call only. Pi's own default is 0 (no decay — long-term continuity); pass a value (e.g. 180) to weight recent facts more heavily for this query.",
    }),
  ),
});

export type RecallToolParams = Static<typeof RecallParams>;

export const MemoryStatsParams = Type.Object({});
export type MemoryStatsToolParams = Static<typeof MemoryStatsParams>;

export const ForgetParams = Type.Object({
  chunkId: Type.String({
    description:
      "The chunk ID to forget (format: 'chk-xxx'). Use engram_recall to find IDs first; do not guess.",
    pattern: '^chk-',
  }),
});

export type ForgetToolParams = Static<typeof ForgetParams>;

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
