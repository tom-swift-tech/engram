import { describe, it, expect } from 'vitest';
import { extractDate } from '../src/dates.js';

describe('extractDate', () => {
  describe('filename strategy', () => {
    it('extracts date from filename with YYYY-MM-DD pattern', () => {
      const result = extractDate('daily/2026-04-01.md', '# Some content');
      expect(result).toEqual({
        eventTime: '2026-04-01T00:00:00.000Z',
        temporalLabel: '2026-04-01',
        strategy: 'filename',
      });
    });

    it('extracts date from root daily filename', () => {
      const result = extractDate('2026-03-15-standup.md', 'Meeting notes');
      expect(result).toEqual({
        eventTime: '2026-03-15T00:00:00.000Z',
        temporalLabel: '2026-03-15',
        strategy: 'filename',
      });
    });

    it('extracts date from nested path with date in filename', () => {
      const result = extractDate('decisions/2025-12-31-architecture.md', '');
      expect(result).toEqual({
        eventTime: '2025-12-31T00:00:00.000Z',
        temporalLabel: '2025-12-31',
        strategy: 'filename',
      });
    });

    it('prioritizes filename date over inline date', () => {
      const content = 'Last updated: 2026-01-01';
      const result = extractDate('daily/2026-04-01.md', content);
      expect(result.strategy).toBe('filename');
      expect(result.temporalLabel).toBe('2026-04-01');
    });
  });

  describe('inline strategy', () => {
    it('extracts date from "Last updated:" line', () => {
      const content = 'Some text\nLast updated: 2026-03-20\nMore text';
      const result = extractDate('core/identity.md', content);
      expect(result).toEqual({
        eventTime: '2026-03-20T00:00:00.000Z',
        temporalLabel: 'updated 2026-03-20',
        strategy: 'inline',
      });
    });

    it('handles lowercase "last updated:"', () => {
      const content = 'last updated: 2026-02-28';
      const result = extractDate('core/preferences.md', content);
      expect(result).toEqual({
        eventTime: '2026-02-28T00:00:00.000Z',
        temporalLabel: 'updated 2026-02-28',
        strategy: 'inline',
      });
    });

    it('handles "Last updated" without colon', () => {
      const content = 'Last updated 2026-01-15';
      const result = extractDate('memo.md', content);
      expect(result).toEqual({
        eventTime: '2026-01-15T00:00:00.000Z',
        temporalLabel: 'updated 2026-01-15',
        strategy: 'inline',
      });
    });
  });

  describe('none strategy', () => {
    it('returns null fields when no date found', () => {
      const result = extractDate('core/identity.md', '# Identity\nSome info');
      expect(result).toEqual({
        eventTime: null,
        temporalLabel: null,
        strategy: 'none',
      });
    });

    it('returns none for empty content and undated filename', () => {
      const result = extractDate('notes.md', '');
      expect(result).toEqual({
        eventTime: null,
        temporalLabel: null,
        strategy: 'none',
      });
    });
  });
});
