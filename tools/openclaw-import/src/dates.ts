import type { DateResult } from './types.js';

const FILENAME_DATE_RE = /(\d{4}-\d{2}-\d{2})/;
const INLINE_DATE_RE = /[Ll]ast\s+updated:?\s*(\d{4}-\d{2}-\d{2})/;

export function extractDate(relativePath: string, content: string): DateResult {
  // Strategy 1: filename date
  const filenameMatch = relativePath.match(FILENAME_DATE_RE);
  if (filenameMatch) {
    const dateStr = filenameMatch[1];
    return {
      eventTime: `${dateStr}T00:00:00.000Z`,
      temporalLabel: dateStr,
      strategy: 'filename',
    };
  }

  // Strategy 2: inline date reference
  const inlineMatch = content.match(INLINE_DATE_RE);
  if (inlineMatch) {
    const dateStr = inlineMatch[1];
    return {
      eventTime: `${dateStr}T00:00:00.000Z`,
      temporalLabel: `updated ${dateStr}`,
      strategy: 'inline',
    };
  }

  // Strategy 3: no date
  return {
    eventTime: null,
    temporalLabel: null,
    strategy: 'none',
  };
}
