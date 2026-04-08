import { describe, it, expect } from 'vitest';
import { classifyPath, shouldSkip, SKIP_PATTERNS } from '../src/classify.js';

describe('classifyPath', () => {
  it('classifies core/ files as core', () => {
    const result = classifyPath('core/identity.md');
    expect(result).toEqual({ category: 'core', isRootDaily: false });
  });

  it('classifies relationships.md as core', () => {
    const result = classifyPath('relationships.md');
    expect(result).toEqual({ category: 'core', isRootDaily: false });
  });

  it('classifies daily/ files as daily (not root)', () => {
    const result = classifyPath('daily/2026-04-01.md');
    expect(result).toEqual({ category: 'daily', isRootDaily: false });
  });

  it('classifies decisions/ files as decision', () => {
    const result = classifyPath('decisions/use-sqlite.md');
    expect(result).toEqual({ category: 'decision', isRootDaily: false });
  });

  it('classifies dreams/*-creative.md as dream', () => {
    const result = classifyPath('dreams/ocean-creative.md');
    expect(result).toEqual({ category: 'dream', isRootDaily: false });
  });

  it('classifies non-creative dreams/ files as reference', () => {
    const result = classifyPath('dreams/lucid-log.md');
    expect(result).toEqual({ category: 'reference', isRootDaily: false });
  });

  it('classifies projects/ files as project', () => {
    const result = classifyPath('projects/valor-engine.md');
    expect(result).toEqual({ category: 'project', isRootDaily: false });
  });

  it('classifies root date-stamped files as daily with isRootDaily true', () => {
    const result = classifyPath('2026-04-01-standup.md');
    expect(result).toEqual({ category: 'daily', isRootDaily: true });
  });

  it('classifies INDEX.md as reference', () => {
    const result = classifyPath('INDEX.md');
    expect(result).toEqual({ category: 'reference', isRootDaily: false });
  });

  it('classifies unknown files as memo', () => {
    const result = classifyPath('random-note.md');
    expect(result).toEqual({ category: 'memo', isRootDaily: false });
  });

  it('normalizes backslashes to forward slashes', () => {
    const result = classifyPath('core\\identity.md');
    expect(result).toEqual({ category: 'core', isRootDaily: false });
  });

  it('prioritizes core/ over date-stamped filename', () => {
    const result = classifyPath('core/2026-04-01.md');
    expect(result).toEqual({ category: 'core', isRootDaily: false });
  });

  it('prioritizes daily/ over date-stamped filename', () => {
    const result = classifyPath('daily/2026-04-01.md');
    expect(result).toEqual({ category: 'daily', isRootDaily: false });
  });
});

describe('shouldSkip', () => {
  it('skips .log files', () => {
    expect(shouldSkip('debug.log')).toBe(true);
  });

  it('skips .json files', () => {
    expect(shouldSkip('data.json')).toBe(true);
  });

  it('skips .txt files', () => {
    expect(shouldSkip('notes.txt')).toBe(true);
  });

  it('skips .html files', () => {
    expect(shouldSkip('page.html')).toBe(true);
  });

  it('skips .jsonl files', () => {
    expect(shouldSkip('events.jsonl')).toBe(true);
  });

  it('skips .backup files', () => {
    expect(shouldSkip('data.backup')).toBe(true);
  });

  it('skips numbered .backup files', () => {
    expect(shouldSkip('data.backup.3')).toBe(true);
  });

  it('skips .old files', () => {
    expect(shouldSkip('config.old')).toBe(true);
  });

  it('skips .prev files', () => {
    expect(shouldSkip('state.prev')).toBe(true);
  });

  it('skips visual-prompt paths', () => {
    expect(shouldSkip('visual-prompt/something.md')).toBe(true);
  });

  it('skips chat-archives/ directory', () => {
    expect(shouldSkip('chat-archives/session-1.md')).toBe(true);
  });

  it('skips baselines/ directory', () => {
    expect(shouldSkip('baselines/v1.md')).toBe(true);
  });

  it('skips x-digests/ directory', () => {
    expect(shouldSkip('x-digests/weekly.md')).toBe(true);
  });

  it('skips dreams/images/ directory', () => {
    expect(shouldSkip('dreams/images/photo.md')).toBe(true);
  });

  it('skips content-drafts/ directory', () => {
    expect(shouldSkip('content-drafts/draft.md')).toBe(true);
  });

  it('skips dreams/visual-prompts/ directory', () => {
    expect(shouldSkip('dreams/visual-prompts/prompt.md')).toBe(true);
  });

  it('skips heartbeat-metrics paths', () => {
    expect(shouldSkip('heartbeat-metrics/report.md')).toBe(true);
  });

  it('does not skip normal .md files', () => {
    expect(shouldSkip('core/identity.md')).toBe(false);
  });

  it('normalizes backslashes before checking', () => {
    expect(shouldSkip('chat-archives\\session.md')).toBe(true);
  });
});

describe('SKIP_PATTERNS', () => {
  it('is an array of RegExp', () => {
    expect(SKIP_PATTERNS).toBeInstanceOf(Array);
    for (const p of SKIP_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });
});
