# Handoff — Engram remediation sprint (2026-07-13)

## Where we are

**Model-resolver fix: DONE & MERGED.** PR #27 → `main@aa149af`. Eliminated
silent model-fallback (single resolver + preflight + fail-loud sentinel). 692
tests green, CI green on Node 20 + 24. Branch deleted local + remote.

**Remediation sprint: PLANNED, branch cut, ready to execute.**
- Branch: `fix/engram-remediation` (HEAD `7b20e8e`, off `main@aa149af`).
- Full plan: `tasks/todo.md` (committed). Six defects D1–D6, all mechanisms
  verified against the tree (four parallel investigations, findings in the plan).
- Note: D1 (Tier-1 `INSTR` scan) and D2/D6 (memory-quality) were already
  foreshadowed in the prior Phase 3/4 backlog — this sprint absorbs them.

## Decisions locked

1. **Scope:** full six-defect sprint, dependency order.
2. **D3 gate:** content heuristic in `planAutoRetain` (in-repo, ships now) +
   purge the 56 cron chunks. Leave issue #21 (upstream scheduler signal) open;
   note the residual brittleness in a code comment.
3. **Base:** model-resolver merged first (done). Remediation off clean main.

## Next step — spawn 4 parallel builders (disjoint files, one worktree each)

Base SHA for all worktrees: `7b20e8e`. Lead creates worktrees before spawning;
each builder owns a disjoint file set; brief from
`~/.claude/builder-brief-template.md`.

| Lane | Owns | Defect |
|------|------|--------|
| **D1** | `src/extract-cpu.ts`, `tests/extract-cpu.test.ts` | word-boundary + stopword + min-len ≥4 in `strategyGraphMatching` (`:221-265`); replace `INSTR` substring matching. |
| **D6** | `src/recall.ts`, `tests/recall.test.ts`, `tests/trust-tier.test.ts` | thread cosine out of `semanticSearch` (`:446-512`), within-tier cosine-primary score + `minScore` gate; **leave `(tier,score)` comparator `:1136-1143` untouched** (security floor). Port assessment params: `cosine × 0.94–0.99 trust-bias · minScore 0.42`. |
| **D2+D4** | `src/reflect.ts`, `tests/reflect.test.ts` | D2: `findMatchingObservation` mirroring `findMatchingOpinion` (`:488-511`), route new obs into the `observation_refreshes` seam (`:675-703`), lexical (no schema change). D4: durability rubric at prompt `:256`/`:261`; attribution guard in `resolveEntityIds` (`:478-486`). |
| **D3-gate** | `integrations/pi/src/adapter.ts`, `integrations/pi/tests/auto-retain.test.ts` | cron/job detector in `planAutoRetain` (`:667-703`)/`ROLE_MAP` (`:600-605`): refuse or downgrade job prompts so they never store as `user_stated`/0.7. |

## Purge — DELIVER A SCRIPT ONLY; running against a live store is OUT OF SCOPE

`mira.engram` (and any live agent store) is **out of scope** — operator-owned
data, not our execution target. Do NOT ask for its path or run any destructive
op against it. Deliverable is a **store-agnostic** maintenance script (takes any
`.engram` path, mandatory `engram.backup()` first + a `--dry-run` default). The
operator runs it. Requirements the script must encode: hard-delete (not
`forget()`, which soft-deletes and reclaims nothing) in FK-safe child-first order
`relations → chunk_entities → entities` (no `ON DELETE CASCADE`), then `VACUUM`.
Fragment/stopword entities keyed by `entities.canonical_name`. Cron-chunk filter:
`memory_type='experience' AND source='pi:conversation' AND source_type='user_stated'
AND trust_score=0.7`, narrowed by FTS/`text` on the known cron phrases (no
session-id column). Projected effect on a store like the assessment's:
329 MB → ~100–120 MB. **We do not observe that number — the operator does.**

**D5 (reflection catch-up)** and **Step 6 (consolidate vs expand)** come after
the code lanes; D5 is cheaper once D2/D4 cut wasted writes.

## Verification per lane

Root vitest + affected integration suite, typecheck, lint, format. Baseline
**692 green** (root 517 / pi 108 / openclaw 67). Surface-parity (13 tools) must
stay green — none of these touch the tool surface. Cargo/AQL out of scope. D6 is
validated by unit tests + a synthetic-fixture ranking test (build a small local
`.engram` in-test); the assessment's live-store numbers (cron-noise 15 → 1) are
the operator's to reproduce, not ours. Purge script validated on a throwaway
in-test `.engram`, never a live store.

## Gotchas carried forward (still live)

- **Never compare scores across two recall() calls in tests without
  `decayHalfLifeDays: 0`** — decay makes scores time-dependent. Directly
  relevant to D6's new score assertions.
- CLAUDE.md ↔ AGENTS.md mirror: edit both together, verify with the CI filter.
- Rebuild `integrations/pi/dist` before trusting a Pi smoke-test failure.
- cargo blocked by Windows Application Control in SOME worktree paths (AQL only).
- Put isolation constraints (worktree, base SHA, file scope) in each builder's
  task description at creation time — an ownership notification races a
  separately-sent brief.
