import { describe, it, expect } from 'vitest';
import { parseTemporalQuery } from '../src/temporal-parser.js';

// Fixed reference date: Wednesday, 2026-04-01 12:00:00 UTC
const REF = new Date('2026-04-01T12:00:00Z');

describe('parseTemporalQuery()', () => {
  // ---------------------------------------------------------------------------
  // Named periods
  // ---------------------------------------------------------------------------

  it('parses "today"', () => {
    const r = parseTemporalQuery('what happened today', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-04-01');
    expect(r!.before).toContain('2026-04-01');
  });

  it('parses "yesterday"', () => {
    const r = parseTemporalQuery('meetings yesterday', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-31');
    expect(r!.before).toContain('2026-03-31');
  });

  it('parses "this week"', () => {
    const r = parseTemporalQuery('progress this week', REF);
    expect(r).not.toBeNull();
    // 2026-04-01 is Wednesday; Monday = March 30
    expect(r!.after).toContain('2026-03-30');
    expect(r!.before).toContain('2026-04-01');
  });

  it('parses "last week"', () => {
    const r = parseTemporalQuery('what happened last week', REF);
    expect(r).not.toBeNull();
    // Last week: Mon Mar 23 to Sun Mar 29
    expect(r!.after).toContain('2026-03-23');
    expect(r!.before).toContain('2026-03-29');
  });

  it('parses "this month"', () => {
    const r = parseTemporalQuery('activity this month', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-04-01');
    expect(r!.before).toContain('2026-04-01');
  });

  it('parses "last month"', () => {
    const r = parseTemporalQuery('decisions last month', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-01');
    expect(r!.before).toContain('2026-03-31');
  });

  // ---------------------------------------------------------------------------
  // Relative periods
  // ---------------------------------------------------------------------------

  it('parses "last 7 days"', () => {
    const r = parseTemporalQuery('changes in the last 7 days', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-25');
    expect(r!.before).toContain('2026-04-01');
  });

  it('parses "past 30 days"', () => {
    const r = parseTemporalQuery('activity past 30 days', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-02');
  });

  it('parses "last 2 weeks"', () => {
    const r = parseTemporalQuery('what happened in the last 2 weeks', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-18');
  });

  it('parses "last 3 months"', () => {
    const r = parseTemporalQuery('progress over the last 3 months', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-01');
  });

  // ---------------------------------------------------------------------------
  // Explicit dates
  // ---------------------------------------------------------------------------

  it('parses ISO date "2026-03-15"', () => {
    const r = parseTemporalQuery('what happened on 2026-03-15', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-15');
    expect(r!.before).toContain('2026-03-15');
  });

  it('parses "March 15th"', () => {
    const r = parseTemporalQuery('meetings on March 15th', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-15');
    expect(r!.before).toContain('2026-03-15');
  });

  it('parses "March 15, 2026"', () => {
    const r = parseTemporalQuery('what was decided March 15, 2026', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-15');
  });

  it('parses "15th March"', () => {
    const r = parseTemporalQuery('deployed 15th march', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-15');
  });

  // ---------------------------------------------------------------------------
  // Named days
  // ---------------------------------------------------------------------------

  it('parses "on Tuesday"', () => {
    // REF is Wednesday Apr 1 → last Tuesday = Mar 31
    const r = parseTemporalQuery('what happened on tuesday', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-31');
    expect(r!.before).toContain('2026-03-31');
  });

  it('parses "last Friday"', () => {
    // REF is Wednesday Apr 1 → last Friday = Mar 27
    const r = parseTemporalQuery('standup notes last friday', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-27');
    expect(r!.before).toContain('2026-03-27');
  });

  it('parses "since Monday"', () => {
    // REF is Wednesday Apr 1 → since Monday = since Mar 30
    const r = parseTemporalQuery('all changes since monday', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-30');
    expect(r!.before).toContain('2026-04-01');
  });

  // ---------------------------------------------------------------------------
  // Month references
  // ---------------------------------------------------------------------------

  it('parses "March 2026"', () => {
    const r = parseTemporalQuery('activity in March 2026', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-01');
    expect(r!.before).toContain('2026-03-31');
  });

  it('parses "in March" (current year)', () => {
    const r = parseTemporalQuery('deployments in march', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-01');
    expect(r!.before).toContain('2026-03-31');
  });

  it('parses "since March" → from March 1 to now', () => {
    const r = parseTemporalQuery('all changes since march', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-03-01');
    expect(r!.before).toContain('2026-04-01');
  });

  // ---------------------------------------------------------------------------
  // Quarter references
  // ---------------------------------------------------------------------------

  it('parses "Q1 2026"', () => {
    const r = parseTemporalQuery('metrics for Q1 2026', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-01-01');
    expect(r!.before).toContain('2026-03-31');
  });

  it('parses "Q4" (current year)', () => {
    const r = parseTemporalQuery('plans for q4', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-10-01');
    expect(r!.before).toContain('2026-12-31');
  });

  it('parses "last quarter"', () => {
    // REF is April 2026 → Q2, last quarter = Q1
    const r = parseTemporalQuery('revenue last quarter', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-01-01');
    expect(r!.before).toContain('2026-03-31');
  });

  it('parses "this quarter"', () => {
    const r = parseTemporalQuery('goals this quarter', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-04-01');
    expect(r!.before).toContain('2026-04-01');
  });

  // ---------------------------------------------------------------------------
  // Year references
  // ---------------------------------------------------------------------------

  it('parses "this year"', () => {
    const r = parseTemporalQuery('all decisions this year', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2026-01-01');
  });

  it('parses "last year"', () => {
    const r = parseTemporalQuery('projects from last year', REF);
    expect(r).not.toBeNull();
    expect(r!.after).toContain('2025-01-01');
    expect(r!.before).toContain('2025-12-31');
  });

  // ---------------------------------------------------------------------------
  // No temporal expression
  // ---------------------------------------------------------------------------

  it('returns null for non-temporal queries', () => {
    expect(parseTemporalQuery('what tools does Tom use', REF)).toBeNull();
    expect(parseTemporalQuery('Terraform infrastructure preferences', REF)).toBeNull();
    expect(parseTemporalQuery('how does the build pipeline work', REF)).toBeNull();
  });
});

// =============================================================================
// Integration: temporal strategy auto-activation in recall()
// =============================================================================

import Database from 'better-sqlite3';
import { retain } from '../src/retain.js';
import { recall } from '../src/recall.js';
import { createTestDb, MockEmbedder } from './helpers.js';
import { beforeEach, afterEach } from 'vitest';

describe('recall() — auto-temporal from natural language', () => {
  let db: Database.Database;
  const embedder = new MockEmbedder();

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  it('activates temporal strategy for "last week" without explicit after/before', async () => {
    // Insert a chunk with a recent created_at
    const r = await retain(db, 'deployed the new API gateway', embedder, { trustScore: 0.9 });
    // Set created_at to 5 days ago
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`UPDATE chunks SET created_at = ? WHERE id = ?`).run(fiveDaysAgo, r.chunkId);

    // Also insert an old chunk
    const old = await retain(db, 'set up the original server', embedder, {
      trustScore: 0.9,
      dedupMode: 'none',
    });
    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`UPDATE chunks SET created_at = ? WHERE id = ?`).run(sixMonthsAgo, old.chunkId);

    const result = await recall(db, 'what happened last week', embedder, {
      strategies: ['temporal'],
    });

    // Temporal should have activated and found the recent chunk
    expect(result.strategiesUsed).toContain('temporal');
    expect(result.results.some(r => r.text.includes('API gateway'))).toBe(true);
    expect(result.results.some(r => r.text.includes('original server'))).toBe(false);
  });

  it('does not override explicit after/before', async () => {
    await retain(db, 'a fact from 2020', embedder, { eventTime: '2020-06-01T00:00:00Z' });
    await retain(db, 'a recent fact', embedder, { eventTime: '2026-03-15T00:00:00Z' });

    // Explicit filter should take precedence over "yesterday" in query
    const result = await recall(db, 'fact yesterday', embedder, {
      strategies: ['temporal'],
      after: '2020-01-01T00:00:00Z',
      before: '2021-01-01T00:00:00Z',
    });

    const texts = result.results.map(r => r.text);
    expect(texts).toContain('a fact from 2020');
    expect(texts).not.toContain('a recent fact');
  });

  it('"today" filters to only today\'s memories', async () => {
    const todayChunk = await retain(db, 'morning standup notes', embedder, { trustScore: 0.9 });
    const oldChunk = await retain(db, 'old standup notes', embedder, {
      trustScore: 0.9,
      dedupMode: 'none',
    });
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`UPDATE chunks SET created_at = ? WHERE id = ?`).run(thirtyDaysAgo, oldChunk.chunkId);

    const result = await recall(db, 'standup notes from today', embedder, {
      strategies: ['temporal'],
    });

    expect(result.strategiesUsed).toContain('temporal');
    expect(result.results.some(r => r.id === todayChunk.chunkId)).toBe(true);
    expect(result.results.some(r => r.id === oldChunk.chunkId)).toBe(false);
  });
});
