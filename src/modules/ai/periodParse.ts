import AppError from '../../utils/AppError';
import { businessDayStart, businessParts } from '../../utils/outletTime';
import { comparisonPeriod, describeRange, resolvePeriod, DateRange, ResolvedPeriod, DayStrings, PeriodPreset } from '../reports/periods';

// Finds the date periods a question mentions (India time) so the assistant can build a report for each.
// Phrases that are exactly a report preset use that preset; everything else becomes a CUSTOM range
// with exact day strings, so the Reports page link matches the figures.

export interface DetectedPeriod {
  range: DateRange;
  label: string;
  preset: PeriodPreset;
  custom?: DayStrings;
}

const MAX_DETECTED = 3;

const MONTH_NUMBER: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const MONTH = '(' + Object.keys(MONTH_NUMBER).sort((a, b) => b.length - a.length).join('|') + ')';
const ORD = '(?:st|nd|rd|th)?';
const DASH = '(?:-|–|to|until|till)';
// Words that are also ordinary English, so they need a month-like context to count.
const AMBIGUOUS = new Set(['may', 'march']);
const CONTEXT_WORDS = new Set(['in', 'of', 'for', 'vs', 'versus', 'and', 'to', 'compare', 'compared']);
const FOLLOW_WORDS = new Set(['vs', 'versus', 'and', 'to']);

const pad = (n: number) => String(n).padStart(2, '0');
const dayString = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const isRealDay = (y: number, m: number, d: number) => d >= 1 && d <= daysInMonth(y, m);
const isOtherMonth = (w?: string) => !!w && w in MONTH_NUMBER && !AMBIGUOUS.has(w);

interface Found {
  index: number;
  period: DetectedPeriod;
}

export function detectPeriods(text: string, now: Date): DetectedPeriod[] {
  const original = (text ?? '').toLowerCase();
  let work = original;
  const found: Found[] = [];

  const today = businessParts(now);
  const todayStr = dayString(today.year, today.month, today.day);
  // Anything starting before 1 Jan two years ago is too old to be useful.
  const oldestStart = businessDayStart(today.year - 2, 0, 1);

  const resolvedOf = new WeakMap<DetectedPeriod, ResolvedPeriod>();
  const build = (preset: PeriodPreset, custom?: DayStrings): DetectedPeriod | null => {
    try {
      const range = resolvePeriod(preset, now, custom);
      if (range.start.getTime() < oldestStart.getTime()) return null;
      const period: DetectedPeriod = {
        range: { start: range.start, end: range.end },
        label: describeRange(range, now),
        preset,
        ...(custom ? { custom } : {}),
      };
      resolvedOf.set(period, range);
      return period;
    } catch (error) {
      if (error instanceof AppError) return null;
      throw error;
    }
  };

  // A custom range between two day strings, trimmed to end today; future-only ranges are dropped.
  const custom = (from: string, to: string): DetectedPeriod | null => {
    if (from > todayStr) return null;
    return build('CUSTOM', { from, to: to > todayStr ? todayStr : to });
  };

  /** handler: undefined = not a real match (text left alone); null = consumed but unusable. */
  const scan = (re: RegExp, handler: (m: RegExpMatchArray) => DetectedPeriod | null | undefined) => {
    for (const m of work.matchAll(new RegExp(re.source, 'g'))) {
      const result = handler(m);
      if (result === undefined) continue;
      const index = m.index ?? 0;
      work = work.slice(0, index) + ' '.repeat(m[0].length) + work.slice(index + m[0].length);
      if (result) found.push({ index, period: result });
    }
  };

  // Month with no year: the most recent one that has started.
  const yearForMonth = (month: number) => (month <= today.month ? today.year : today.year - 1);
  const monthRange = (year: number, month: number) =>
    custom(dayString(year, month, 1), dayString(year, month, daysInMonth(year, month)));
  const dayRange = (year: number | undefined, month: number, d1: number, d2: number) => {
    const y = year ?? yearForMonth(month);
    if (!isRealDay(y, month, d1) || !isRealDay(y, month, d2)) return null;
    return custom(dayString(y, month, d1), dayString(y, month, d2));
  };

  // 1. ISO dates and ranges.
  scan(/\b(\d{4}-\d{2}-\d{2})\s*(?:to|until|till|through|-|–)\s*(\d{4}-\d{2}-\d{2})\b/, (m) => custom(m[1], m[2]));
  scan(/\b(\d{4}-\d{2}-\d{2})\b/, (m) => custom(m[1], m[1]));
  // Year and month: "2026-08".
  scan(/(?<![\d/.-])(20\d{2})-(\d{2})(?![\d/-])/, (m) => {
    const month = Number(m[2]) - 1;
    if (month < 0 || month > 11) return undefined;
    return monthRange(Number(m[1]), month);
  });

  // 1b. "same month last year" and friends: remembered now, attached to the period before them below.
  const sameAsLastYear: number[] = [];
  scan(/\bsame\s+(?:month|period|time|day|week)\s+(?:last|the previous)\s+year\b/, (m) => {
    sameAsLastYear.push(m.index ?? 0);
    return null;
  });

  // 2a. Ranges across months: "1 aug to 15 sep", "aug 1 - sep 15 2025". A missing year is the most
  // recent one that fits; the start is in the year before when its month is later in the calendar.
  const crossMonth = (d1: string, m1: string, y1: string | undefined, d2: string, m2: string, y2: string | undefined) => {
    const [a, b] = [MONTH_NUMBER[m1], MONTH_NUMBER[m2]];
    const endYear = y2 ? Number(y2) : y1 ? Number(y1) + (b < a ? 1 : 0) : yearForMonth(b);
    const startYear = y1 ? Number(y1) : endYear - (a > b ? 1 : 0);
    if (!isRealDay(startYear, a, Number(d1)) || !isRealDay(endYear, b, Number(d2))) return null;
    return custom(dayString(startYear, a, Number(d1)), dayString(endYear, b, Number(d2)));
  };
  scan(new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?\\s*${DASH}\\s*(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?\\b`), (m) =>
    crossMonth(m[1], m[2], m[3], m[4], m[5], m[6]));
  scan(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?!\\d)${ORD}(?:,?\\s+(\\d{4}))?\\s*${DASH}\\s*${MONTH}\\s+(\\d{1,2})(?!\\d)${ORD}(?:,?\\s+(\\d{4}))?\\b`), (m) =>
    crossMonth(m[2], m[1], m[3], m[5], m[4], m[6]));

  // 2. Day ranges in one month: "1-15 aug", "1 to 15 aug 2025", "aug 1-15".
  scan(new RegExp(`\\b(\\d{1,2})${ORD}\\s*${DASH}\\s*(\\d{1,2})(?!\\d)${ORD}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?\\b`), (m) =>
    dayRange(m[4] ? Number(m[4]) : undefined, MONTH_NUMBER[m[3]], Number(m[1]), Number(m[2])));
  scan(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?!\\d)${ORD}\\s*${DASH}\\s*(\\d{1,2})(?!\\d)${ORD}(?:,?\\s+(\\d{4}))?\\b`), (m) =>
    dayRange(m[4] ? Number(m[4]) : undefined, MONTH_NUMBER[m[1]], Number(m[2]), Number(m[3])));

  // 3. Single dates: "5 aug", "aug 5", "5th of august 2025".
  scan(new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?\\b`), (m) =>
    dayRange(m[3] ? Number(m[3]) : undefined, MONTH_NUMBER[m[2]], Number(m[1]), Number(m[1])));
  scan(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?!\\d)${ORD}(?:,?\\s+(\\d{4}))?\\b`), (m) =>
    dayRange(m[3] ? Number(m[3]) : undefined, MONTH_NUMBER[m[1]], Number(m[2]), Number(m[2])));

  // 4. Phrases that are exactly a preset.
  const presets: Array<[RegExp, PeriodPreset]> = [
    [/\btoday\b/, 'TODAY'],
    [/\byesterday\b/, 'YESTERDAY'],
    [/\bthis week\b/, 'THIS_WEEK'],
    [/\blast week\b/, 'LAST_WEEK'],
    [/\bthis month\b/, 'THIS_MONTH'],
    [/\blast month\b/, 'LAST_MONTH'],
    [/\bthis quarter\b/, 'THIS_QUARTER'],
    [/\blast quarter\b/, 'LAST_QUARTER'],
    [/\bthis year\b/, 'THIS_YEAR'],
    [/\blast year\b/, 'LAST_YEAR'],
  ];
  for (const [re, preset] of presets) scan(re, () => build(preset));

  // 5. "last 30 days" = today and the 29 days before.
  scan(/\b(?:last|past|previous)\s+(\d{1,4})\s+days?\b/, (m) => {
    const n = Number(m[1]);
    if (n < 1) return null;
    const from = businessParts(businessDayStart(today.year, today.month, today.day - (n - 1)));
    return build('CUSTOM', { from: dayString(from.year, from.month, from.day), to: todayStr });
  });

  // 6. Quarters, with an optional year; without one, the most recent that has started.
  scan(/\bq([1-4])(?:\s*(?:of\s+)?(\d{4}))?\b/, (m) => {
    const startMonth = (Number(m[1]) - 1) * 3;
    let year = m[2] ? Number(m[2]) : today.year;
    if (!m[2] && startMonth > today.month) year -= 1;
    const end = startMonth + 2;
    return custom(dayString(year, startMonth, 1), dayString(year, end, daysInMonth(year, end)));
  });

  // 7. Month names with an optional year. "may" and "march" also need a month-like context.
  scan(new RegExp(`\\b${MONTH}(?:\\s+(\\d{4}))?\\b`), (m) => {
    const word = m[1];
    const index = m.index ?? 0;
    if (!m[2] && AMBIGUOUS.has(word)) {
      const prev = /([a-z]+)\W*$/.exec(original.slice(0, index))?.[1];
      const next = /^\W*([a-z]+)/.exec(original.slice(index + m[0].length))?.[1];
      const near =
        (!!prev && (CONTEXT_WORDS.has(prev) || isOtherMonth(prev))) ||
        (!!next && (FOLLOW_WORDS.has(next) || isOtherMonth(next)));
      if (!near) return undefined;
    }
    const month = MONTH_NUMBER[word];
    return monthRange(m[2] ? Number(m[2]) : yearForMonth(month), month);
  });

  // 8. A bare year is the whole year (this year ends today).
  // Not after money signs, digits, dates or slashes, and not before more digits or date parts.
  scan(/(?<![\d₹/.-])(?<!\brs\s?)(?<!₹\s)(20\d{2})(?!\d)(?![-/]\d)/, (m) => custom(`${m[1]}-01-01`, `${m[1]}-12-31`));

  // 9. "same time last year" shifts the nearest period before it back one year.
  for (const at of sameAsLastYear) {
    const prior = found.filter((f) => f.index < at).sort((a, b) => b.index - a.index)[0];
    const resolved = prior && resolvedOf.get(prior.period);
    if (!resolved) continue;
    const cmp = comparisonPeriod(resolved, 'LAST_YEAR', now);
    if (!cmp) continue;
    const s = businessParts(cmp.start);
    const e = businessParts(cmp.end);
    const shifted = build('CUSTOM', { from: dayString(s.year, s.month, s.day), to: dayString(e.year, e.month, e.day) });
    if (shifted) found.push({ index: at, period: shifted });
  }

  const seen = new Set<string>();
  return found
    .sort((a, b) => a.index - b.index)
    .map((f) => f.period)
    .filter((p) => {
      const key = `${p.range.start.getTime()}-${p.range.end.getTime()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_DETECTED);
}
