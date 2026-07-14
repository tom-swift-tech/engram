// =============================================================================
// grounding.test.ts — Subagent Grounding Layer (spec §7.4)
//
//   (a) opinions never appear in a groundSubagent result, even when asked for
//   (b) empty type-intersection still grounds (belief-free), never zero
//   (c) parent-scoped taskContext pulls artifacts under the parent, not siblings
//   (d) a report round-trips through metabolizeReport into a durable
//       agent_generated experience that is then challengeable by reflect
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Engram } from '../src/engram.js';
import {
  groundSubagent,
  taskContext,
  metabolizeReport,
  type SubagentReport,
} from '../src/grounding.js';
import type { DecisionArtifact } from '../src/context-store.js';
import { MockEmbedder, MockGenerator, tmpDbPath, cleanupDb } from './helpers.js';

describe('Subagent Grounding Layer', () => {
  let dbPath: string;
  let engram: Engram;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  /** Seed an opinion row directly (no reflect machinery) via a second RW handle. */
  function seedOpinion(belief: string, confidence: number, domain: string) {
    const raw = new Database(dbPath);
    raw.pragma('busy_timeout = 5000');
    raw
      .prepare(
        `INSERT INTO opinions (id, belief, confidence, domain) VALUES (?, ?, ?, ?)`,
      )
      .run(`op-${Math.round(confidence * 1000)}-${domain}`, belief, confidence, domain);
    raw.close();
  }

  // (a) --------------------------------------------------------------------------

  it('never surfaces opinions, even when memoryTypes explicitly asks for opinion', async () => {
    await engram.retain('Rust favors zero-cost abstractions for systems work', {
      memoryType: 'world',
      sourceType: 'user_stated',
      trustScore: 0.9,
    });
    // A belief that WOULD match the task query if opinions were included
    // (recall() surfaces active opinions with confidence >= 0.5 whose belief
    // matches a query token). groundSubagent must exclude it regardless.
    seedOpinion(
      'Rust is the only acceptable systems language for this team',
      0.8,
      'preferences',
    );

    const view = await engram.readonlyView();
    const grounding = await groundSubagent(view, {
      task: 'Rust systems language choices',
      memoryTypes: ['world', 'observation', 'opinion'],
    });

    // No belief section in the injected block, and the belief text is absent.
    expect(grounding.prompt).not.toMatch(/### Beliefs/);
    expect(grounding.prompt).not.toMatch(/only acceptable systems language/);
    // No opinion-type fact leaked into the structured results either.
    expect(grounding.facts.every((f) => f.memoryType !== 'opinion')).toBe(true);
    // The world fact IS present — grounding still works.
    expect(grounding.facts.some((f) => /zero-cost/i.test(f.text))).toBe(true);
    expect(grounding.meta.injectedChars).toBe(grounding.prompt.length);

    view.close();
  });

  // (b) --------------------------------------------------------------------------

  it('grounds belief-free even when only opinion is requested (empty intersection)', async () => {
    await engram.retain('Kafka partitions are ordered per-partition only', {
      memoryType: 'world',
      sourceType: 'user_stated',
      trustScore: 0.9,
    });

    const view = await engram.readonlyView();
    const grounding = await groundSubagent(view, {
      task: 'Kafka partition ordering',
      memoryTypes: ['opinion'], // intersects to empty → falls back to grounding set
    });

    expect(grounding.facts.length).toBeGreaterThan(0);
    expect(grounding.facts.every((f) => f.memoryType !== 'opinion')).toBe(true);
    expect(grounding.prompt).not.toMatch(/### Beliefs/);

    view.close();
  });

  // (c) --------------------------------------------------------------------------

  it('taskContext pulls artifacts under the given parent, not sibling scopes', async () => {
    const mk = (decision: string): DecisionArtifact => ({
      decision,
      rationale: `because ${decision}`,
      confidence: 0.8,
      agentId: 'orchestrator-1',
    });

    const rootA = await engram.commitContext(mk('task A root'));
    await engram.commitContext(mk('adopt Terraform for provisioning'), {
      parent: rootA,
    });

    const rootB = await engram.commitContext(mk('task B root'));
    await engram.commitContext(mk('adopt Ansible for configuration'), {
      parent: rootB,
    });

    const view = await engram.readonlyView();
    const slice = await taskContext(view, rootA, 'provisioning tooling decision');

    const decisions = slice.artifacts.map((a) => a.artifact.decision);
    expect(decisions).toContain('adopt Terraform for provisioning');
    expect(decisions).not.toContain('adopt Ansible for configuration');

    view.close();
  });

  // (d) --------------------------------------------------------------------------

  it('metabolizes a report into a durable agent_generated experience that reflect can challenge', async () => {
    const report: SubagentReport = {
      result: { summary: 'subagent finished the spike' },
      artifact: {
        decision: 'use connection pooling for the hot path',
        confidence: 0.7,
        agentId: 'subagent-ephemeral',
      },
      candidateExperiences: [
        {
          text: 'Connection pooling cut p99 latency on the checkout path',
          context: 'perf-spike',
        },
        { text: 'This one should be dropped by the keep filter' },
      ],
    };

    const result = await metabolizeReport(engram, report, {
      // Orchestrator's judgment: keep only the substantive experience.
      keepExperiences: (c) => c.context === 'perf-spike',
    });

    // Artifact committed task-scoped; one experience retained.
    expect(result.artifactRef?.scope).toBe('task');
    expect(result.retainedExperienceIds).toHaveLength(1);

    // The retained experience is durable / experience / agent_generated (tier 1)
    // and unreflected — i.e. it will be metabolized by the NEXT reflect cycle.
    const raw = new Database(dbPath);
    const retainedId = result.retainedExperienceIds[0];
    const row = raw
      .prepare(
        `SELECT memory_type, source_type, scope FROM chunks WHERE id = ?`,
      )
      .get(retainedId) as {
      memory_type: string;
      source_type: string;
      scope: string;
    };
    expect(row).toMatchObject({
      memory_type: 'experience',
      source_type: 'agent_generated',
      scope: 'durable',
    });

    const unreflected = raw
      .prepare(`SELECT 1 FROM v_unreflected WHERE id = ?`)
      .get(retainedId);
    expect(unreflected).toBeDefined();
    raw.close();
  });
});
