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
