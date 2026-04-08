import type { ParsedChunk } from './types.js';

const MIN_CHUNK_CHARS = 50;
const MAX_CHUNK_CHARS = 4000; // conservative limit for nomic-embed-text context window

const HR_ONLY_RE = /^[\s\-*_]+$/;

export function parseMarkdown(content: string): ParsedChunk[] {
  const lines = content.split('\n');
  const chunks: ParsedChunk[] = [];

  let currentH2: string | null = null;
  let currentLines: string[] = [];

  function flush() {
    const text = currentLines.join('\n').trim();
    if (text.length < MIN_CHUNK_CHARS) return;
    if (HR_ONLY_RE.test(text)) return;

    const headings: string[] = [];
    if (currentH2) headings.push(currentH2);

    if (text.length <= MAX_CHUNK_CHARS) {
      chunks.push({ text, headings });
    } else {
      // Split oversized sections on paragraph boundaries, then on lines
      const paragraphs = text.split(/\n\n+/);
      let buf = '';
      for (const para of paragraphs) {
        if (para.length > MAX_CHUNK_CHARS) {
          // Flush current buffer first
          if (buf.trim().length >= MIN_CHUNK_CHARS) {
            chunks.push({ text: buf.trim(), headings: [...headings] });
          }
          // Split oversized paragraph on line boundaries
          const paraLines = para.split('\n');
          buf = '';
          for (const line of paraLines) {
            if (buf && buf.length + line.length + 1 > MAX_CHUNK_CHARS) {
              chunks.push({ text: buf.trim(), headings: [...headings] });
              buf = line;
            } else {
              buf = buf ? buf + '\n' + line : line;
            }
          }
        } else if (buf && buf.length + para.length + 2 > MAX_CHUNK_CHARS) {
          chunks.push({ text: buf.trim(), headings: [...headings] });
          buf = para;
        } else {
          buf = buf ? buf + '\n\n' + para : para;
        }
      }
      if (buf.trim().length >= MIN_CHUNK_CHARS) {
        chunks.push({ text: buf.trim(), headings: [...headings] });
      }
    }
  }

  for (const line of lines) {
    if (line.startsWith('## ') && !line.startsWith('### ')) {
      flush();
      currentH2 = line.replace(/^## /, '').trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  flush();

  return chunks;
}

export function buildContextTag(
  category: string,
  identifier: string,
  headings: string[],
): string {
  const parts = [`${category}:${identifier}`, ...headings];
  return parts.join(' > ');
}
