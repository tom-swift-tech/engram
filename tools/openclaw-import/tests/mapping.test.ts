import { describe, it, expect } from 'vitest';
import { mapCategory } from '../src/mapping.js';
import type { CategoryMapping } from '../src/mapping.js';

describe('mapCategory', () => {
  it('maps core category correctly', () => {
    const result = mapCategory('core', false);
    expect(result).toEqual({
      memoryType: 'world',
      trustScore: 0.9,
      sourceType: 'external_doc',
      skipExtraction: false,
    });
  });

  it('maps daily category correctly', () => {
    const result = mapCategory('daily', false);
    expect(result).toEqual({
      memoryType: 'experience',
      trustScore: 0.7,
      sourceType: 'external_doc',
      skipExtraction: false,
    });
  });

  it('maps decision category correctly', () => {
    const result = mapCategory('decision', false);
    expect(result).toEqual({
      memoryType: 'world',
      trustScore: 0.85,
      sourceType: 'external_doc',
      skipExtraction: false,
    });
  });

  it('maps dream category correctly', () => {
    const result = mapCategory('dream', false);
    expect(result).toEqual({
      memoryType: 'experience',
      trustScore: 0.6,
      sourceType: 'external_doc',
      skipExtraction: true,
    });
  });

  it('maps project category correctly', () => {
    const result = mapCategory('project', false);
    expect(result).toEqual({
      memoryType: 'world',
      trustScore: 0.8,
      sourceType: 'external_doc',
      skipExtraction: false,
    });
  });

  it('maps reference category correctly', () => {
    const result = mapCategory('reference', false);
    expect(result).toEqual({
      memoryType: 'world',
      trustScore: 0.85,
      sourceType: 'external_doc',
      skipExtraction: true,
    });
  });

  it('maps memo category correctly', () => {
    const result = mapCategory('memo', false);
    expect(result).toEqual({
      memoryType: 'world',
      trustScore: 0.75,
      sourceType: 'external_doc',
      skipExtraction: false,
    });
  });

  it('overrides daily trust to 0.75 for root dailies', () => {
    const result = mapCategory('daily', true);
    expect(result.trustScore).toBe(0.75);
    expect(result.memoryType).toBe('experience');
  });

  it('does not override trust for non-daily root files', () => {
    const result = mapCategory('core', true);
    expect(result.trustScore).toBe(0.9);
  });

  it('returns a new object (not a reference to the internal mapping)', () => {
    const a = mapCategory('core', false);
    const b = mapCategory('core', false);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('all categories return valid CategoryMapping shape', () => {
    const categories = [
      'core',
      'daily',
      'decision',
      'dream',
      'project',
      'reference',
      'memo',
    ] as const;

    for (const cat of categories) {
      const result: CategoryMapping = mapCategory(cat, false);
      expect(result.memoryType).toBeDefined();
      expect(result.trustScore).toBeGreaterThanOrEqual(0);
      expect(result.trustScore).toBeLessThanOrEqual(1);
      expect(result.sourceType).toBe('external_doc');
      expect(typeof result.skipExtraction).toBe('boolean');
    }
  });
});
