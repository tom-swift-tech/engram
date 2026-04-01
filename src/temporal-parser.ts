// =============================================================================
// temporal-parser.ts - Natural Language Temporal Expression Parser
//
// Zero-dependency parser that extracts date ranges from natural language
// queries. Returns {after, before} ISO strings that feed directly into
// the temporal recall strategy.
//
// Handles: "yesterday", "last week", "past 30 days", "March 15th",
// "since Tuesday", "this month", "Q1 2026", etc.
//
// Design: pure functions, no side effects, deterministic given a reference
// date. The referenceDate parameter exists for testability.
// =============================================================================

export interface TemporalRange {
  after?: string;
  before?: string;
}

/**
 * Parse natural language temporal expressions from a query string.
 * Returns null if no temporal expression is detected.
 *
 * All returned dates are ISO 8601 strings (UTC).
 */
export function parseTemporalQuery(
  query: string,
  referenceDate: Date = new Date(),
): TemporalRange | null {
  const lower = query.toLowerCase();

  // Try each parser in order of specificity (most specific first)
  return (
    parseExplicitDate(lower, referenceDate) ??
    parseRelativePeriod(lower, referenceDate) ??
    parseNamedPeriod(lower, referenceDate) ??
    parseNamedDay(lower, referenceDate) ??
    parseMonthReference(lower, referenceDate) ??
    parseQuarter(lower, referenceDate) ??
    parseYearReference(lower, referenceDate) ??
    null
  );
}

// =============================================================================
// Individual parsers
// =============================================================================

const MONTH_NAMES: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * "2026-03-15", "March 15", "March 15th", "15 March 2026", "March 15, 2026"
 * Returns a single-day range.
 */
function parseExplicitDate(query: string, ref: Date): TemporalRange | null {
  // ISO-ish: 2026-03-15
  const isoMatch = query.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    return dayRange(
      parseInt(isoMatch[1]),
      parseInt(isoMatch[2]) - 1,
      parseInt(isoMatch[3]),
    );
  }

  // "March 15th" or "March 15" with optional year
  const monthNames = Object.keys(MONTH_NAMES).join('|');
  const mdyRegex = new RegExp(
    `\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:[,\\s]+(\\d{4}))?\\b`,
  );
  const mdyMatch = query.match(mdyRegex);
  if (mdyMatch) {
    const month = MONTH_NAMES[mdyMatch[1]];
    const day = parseInt(mdyMatch[2]);
    const year = mdyMatch[3] ? parseInt(mdyMatch[3]) : ref.getFullYear();
    return dayRange(year, month, day);
  }

  // "15 March 2026" or "15th March"
  const dmyRegex = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})(?:\\s+(\\d{4}))?\\b`,
  );
  const dmyMatch = query.match(dmyRegex);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1]);
    const month = MONTH_NAMES[dmyMatch[2]];
    const year = dmyMatch[3] ? parseInt(dmyMatch[3]) : ref.getFullYear();
    return dayRange(year, month, day);
  }

  return null;
}

/**
 * "last N days/weeks/months", "past N days", "last 2 weeks"
 */
function parseRelativePeriod(query: string, ref: Date): TemporalRange | null {
  const match = query.match(
    /\b(?:last|past|previous|recent)\s+(\d+)\s+(days?|weeks?|months?)\b/,
  );
  if (!match) return null;

  const n = parseInt(match[1]);
  const unit = match[2].replace(/s$/, '');
  const start = new Date(ref);

  switch (unit) {
    case 'day':
      start.setUTCDate(start.getUTCDate() - n);
      break;
    case 'week':
      start.setUTCDate(start.getUTCDate() - n * 7);
      break;
    case 'month':
      start.setUTCMonth(start.getUTCMonth() - n);
      break;
  }

  return {
    after: startOfDay(start).toISOString(),
    before: endOfDay(ref).toISOString(),
  };
}

/**
 * "today", "yesterday", "this week", "last week", "this month", "last month"
 */
function parseNamedPeriod(query: string, ref: Date): TemporalRange | null {
  if (/\btoday\b/.test(query)) {
    return {
      after: startOfDay(ref).toISOString(),
      before: endOfDay(ref).toISOString(),
    };
  }

  if (/\byesterday\b/.test(query)) {
    const d = new Date(ref);
    d.setUTCDate(d.getUTCDate() - 1);
    return {
      after: startOfDay(d).toISOString(),
      before: endOfDay(d).toISOString(),
    };
  }

  if (/\bthis\s+week\b/.test(query)) {
    const start = startOfWeek(ref);
    return {
      after: start.toISOString(),
      before: endOfDay(ref).toISOString(),
    };
  }

  if (/\blast\s+week\b/.test(query)) {
    const thisWeekStart = startOfWeek(ref);
    const lastWeekStart = new Date(thisWeekStart);
    lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 7);
    const lastWeekEnd = new Date(thisWeekStart);
    lastWeekEnd.setUTCMilliseconds(-1);
    return {
      after: lastWeekStart.toISOString(),
      before: lastWeekEnd.toISOString(),
    };
  }

  if (/\bthis\s+month\b/.test(query)) {
    const start = utcDate(ref.getUTCFullYear(), ref.getUTCMonth(), 1);
    return {
      after: start.toISOString(),
      before: endOfDay(ref).toISOString(),
    };
  }

  if (/\blast\s+month\b/.test(query)) {
    const start = utcDate(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1);
    const end = endOfMonth(ref.getUTCFullYear(), ref.getUTCMonth() - 1);
    return {
      after: start.toISOString(),
      before: end.toISOString(),
    };
  }

  return null;
}

/**
 * "on Tuesday", "last Friday", "since Monday"
 */
function parseNamedDay(query: string, ref: Date): TemporalRange | null {
  // "since Monday" → from that day to now
  const sinceMatch = query.match(
    new RegExp(`\\bsince\\s+(${Object.keys(DAY_NAMES).join('|')})\\b`),
  );
  if (sinceMatch) {
    const targetDay = DAY_NAMES[sinceMatch[1]];
    const d = mostRecentWeekday(ref, targetDay);
    return {
      after: startOfDay(d).toISOString(),
      before: endOfDay(ref).toISOString(),
    };
  }

  // "on Tuesday" or "last Friday"
  const dayMatch = query.match(
    new RegExp(`\\b(?:on|last)\\s+(${Object.keys(DAY_NAMES).join('|')})\\b`),
  );
  if (dayMatch) {
    const targetDay = DAY_NAMES[dayMatch[1]];
    const d = mostRecentWeekday(ref, targetDay);
    return {
      after: startOfDay(d).toISOString(),
      before: endOfDay(d).toISOString(),
    };
  }

  return null;
}

/**
 * "in March", "March 2026", "last March", "since March"
 */
function parseMonthReference(query: string, ref: Date): TemporalRange | null {
  const monthNames = Object.keys(MONTH_NAMES).join('|');

  // "since March"
  const sinceMatch = query.match(new RegExp(`\\bsince\\s+(${monthNames})\\b`));
  if (sinceMatch) {
    const month = MONTH_NAMES[sinceMatch[1]];
    let year = ref.getUTCFullYear();
    if (month > ref.getUTCMonth()) year--;
    const start = utcDate(year, month, 1);
    return {
      after: start.toISOString(),
      before: endOfDay(ref).toISOString(),
    };
  }

  // "March 2026" or "in March" or "last March"
  const monthYearMatch = query.match(
    new RegExp(`\\b(${monthNames})\\s+(\\d{4})\\b`),
  );
  if (monthYearMatch) {
    const month = MONTH_NAMES[monthYearMatch[1]];
    const year = parseInt(monthYearMatch[2]);
    const start = utcDate(year, month, 1);
    const end = endOfMonth(year, month);
    return {
      after: start.toISOString(),
      before: end.toISOString(),
    };
  }

  const inMonthMatch = query.match(
    new RegExp(`\\b(?:in|last|during)\\s+(${monthNames})\\b`),
  );
  if (inMonthMatch) {
    const month = MONTH_NAMES[inMonthMatch[1]];
    let year = ref.getUTCFullYear();
    if (month > ref.getUTCMonth() || /\blast\b/.test(query)) year--;
    const start = utcDate(year, month, 1);
    const end = endOfMonth(year, month);
    return {
      after: start.toISOString(),
      before: end.toISOString(),
    };
  }

  return null;
}

/**
 * "Q1 2026", "Q4", "last quarter"
 */
function parseQuarter(query: string, ref: Date): TemporalRange | null {
  // "Q1 2026"
  const qMatch = query.match(/\bq([1-4])\s*(\d{4})?\b/);
  if (qMatch) {
    const q = parseInt(qMatch[1]);
    const year = qMatch[2] ? parseInt(qMatch[2]) : ref.getUTCFullYear();
    const startMonth = (q - 1) * 3;
    const start = utcDate(year, startMonth, 1);
    const end = endOfMonth(year, startMonth + 2);
    return {
      after: start.toISOString(),
      before: end.toISOString(),
    };
  }

  if (/\blast\s+quarter\b/.test(query)) {
    const currentQ = Math.floor(ref.getUTCMonth() / 3);
    const prevQ = currentQ === 0 ? 3 : currentQ - 1;
    const year =
      currentQ === 0 ? ref.getUTCFullYear() - 1 : ref.getUTCFullYear();
    const startMonth = prevQ * 3;
    const start = utcDate(year, startMonth, 1);
    const end = endOfMonth(year, startMonth + 2);
    return {
      after: start.toISOString(),
      before: end.toISOString(),
    };
  }

  if (/\bthis\s+quarter\b/.test(query)) {
    const currentQ = Math.floor(ref.getUTCMonth() / 3);
    const startMonth = currentQ * 3;
    const start = utcDate(ref.getUTCFullYear(), startMonth, 1);
    return {
      after: start.toISOString(),
      before: endOfDay(ref).toISOString(),
    };
  }

  return null;
}

/**
 * "this year", "last year", "in 2025"
 */
function parseYearReference(query: string, ref: Date): TemporalRange | null {
  if (/\bthis\s+year\b/.test(query)) {
    const start = utcDate(ref.getUTCFullYear(), 0, 1);
    return {
      after: start.toISOString(),
      before: endOfDay(ref).toISOString(),
    };
  }

  if (/\blast\s+year\b/.test(query)) {
    const year = ref.getUTCFullYear() - 1;
    const start = utcDate(year, 0, 1);
    const end = utcDate(year, 11, 31, 23, 59, 59, 999);
    return {
      after: start.toISOString(),
      before: end.toISOString(),
    };
  }

  const yearMatch = query.match(/\b(?:in\s+)?(\d{4})\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1]);
    if (year >= 2000 && year <= 2100) {
      const start = utcDate(year, 0, 1);
      const end = utcDate(year, 11, 31, 23, 59, 59, 999);
      return {
        after: start.toISOString(),
        before: end.toISOString(),
      };
    }
  }

  return null;
}

// =============================================================================
// Date helpers (all UTC to avoid timezone drift with toISOString())
// =============================================================================

function startOfDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

function endOfDay(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

function startOfWeek(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1; // Monday = start of week
  const start = new Date(d);
  start.setUTCDate(start.getUTCDate() - diff);
  return startOfDay(start);
}

function dayRange(year: number, month: number, day: number): TemporalRange {
  const start = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
  return {
    after: start.toISOString(),
    before: end.toISOString(),
  };
}

function utcDate(
  year: number,
  month: number,
  day: number,
  h = 0,
  m = 0,
  s = 0,
  ms = 0,
): Date {
  return new Date(Date.UTC(year, month, day, h, m, s, ms));
}

function endOfMonth(year: number, month: number): Date {
  // Day 0 of next month = last day of this month
  return new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
}

function mostRecentWeekday(ref: Date, targetDay: number): Date {
  const d = new Date(ref);
  const currentDay = d.getUTCDay();
  let diff = currentDay - targetDay;
  if (diff <= 0) diff += 7; // go back to last occurrence
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}
