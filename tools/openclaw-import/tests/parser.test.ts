import { describe, it, expect } from 'vitest';
import { parseMarkdown, buildContextTag } from '../src/parser.js';

describe('parseMarkdown', () => {
  it('splits content on H2 headings', () => {
    const content = [
      '## Section One',
      'This is section one with enough content to pass the minimum character threshold easily.',
      '## Section Two',
      'This is section two with enough content to pass the minimum character threshold easily.',
    ].join('\n');

    const chunks = parseMarkdown(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].headings).toEqual(['Section One']);
    expect(chunks[0].text).toContain('section one');
    expect(chunks[1].headings).toEqual(['Section Two']);
    expect(chunks[1].text).toContain('section two');
  });

  it('discards content under 50 chars', () => {
    const content = [
      '## Short',
      'Too short.',
      '## Long Enough',
      'This section has more than fifty characters of content so it should be retained in the output.',
    ].join('\n');

    const chunks = parseMarkdown(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headings).toEqual(['Long Enough']);
  });

  it('includes preamble content before first H2 (no heading)', () => {
    const content = [
      'This is preamble text that comes before any heading and has enough characters to pass the threshold.',
      '## First Section',
      'First section content that is long enough to pass the fifty character minimum threshold for chunking.',
    ].join('\n');

    const chunks = parseMarkdown(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].headings).toEqual([]);
    expect(chunks[0].text).toContain('preamble');
  });

  it('skips HR-only content', () => {
    const content = [
      '## Divider Section',
      '---',
      '---',
      '   ---   ',
      '## Real Section',
      'This section has meaningful content that exceeds the fifty character minimum threshold for inclusion.',
    ].join('\n');

    const chunks = parseMarkdown(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headings).toEqual(['Real Section']);
  });

  it('does not split on H3 headings', () => {
    const content = [
      '## Main Section',
      'Content before sub-heading that is long enough to count toward the minimum.',
      '### Sub Section',
      'Content after sub-heading that is also long enough to count toward the minimum.',
    ].join('\n');

    const chunks = parseMarkdown(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('### Sub Section');
  });

  it('splits oversized chunks on paragraph boundaries', () => {
    const para = 'A'.repeat(2000);
    const content = [
      '## Big Section',
      para,
      '',
      para,
    ].join('\n');

    const chunks = parseMarkdown(content);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(4000);
    }
  });

  it('splits oversized paragraph on line boundaries', () => {
    // Create a single paragraph (no blank lines) that exceeds 4000 chars
    const line = 'B'.repeat(200);
    const lines = Array(25).fill(line); // 25 * 201 > 4000
    const content = ['## Huge Paragraph', ...lines].join('\n');

    const chunks = parseMarkdown(content);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(4000);
    }
  });

  it('preserves heading association through oversized splits', () => {
    const para = 'C'.repeat(2000);
    const content = [
      '## My Heading',
      para,
      '',
      para,
      '',
      para,
    ].join('\n');

    const chunks = parseMarkdown(content);
    for (const chunk of chunks) {
      expect(chunk.headings).toEqual(['My Heading']);
    }
  });

  it('returns empty array for empty content', () => {
    expect(parseMarkdown('')).toEqual([]);
  });

  it('returns empty array for content below minimum', () => {
    expect(parseMarkdown('Short.')).toEqual([]);
  });
});

describe('buildContextTag', () => {
  it('formats category and identifier', () => {
    expect(buildContextTag('core', 'identity.md', [])).toBe('core:identity.md');
  });

  it('appends headings with > separator', () => {
    expect(buildContextTag('daily', '2026-04-01.md', ['Morning Standup'])).toBe(
      'daily:2026-04-01.md > Morning Standup',
    );
  });

  it('appends multiple headings', () => {
    expect(
      buildContextTag('project', 'valor.md', ['Overview', 'Architecture']),
    ).toBe('project:valor.md > Overview > Architecture');
  });

  it('handles empty headings array', () => {
    expect(buildContextTag('memo', 'note.md', [])).toBe('memo:note.md');
  });
});
