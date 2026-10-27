import AppError from '../../utils/AppError';
import { ONE_DAY_MS, businessDayStart, businessParts, businessStartOfDay } from '../../utils/outletTime';

// Every date range used by reports and comparisons is decided here, in India time, using the 5 AM business day
// (see outletTime.ts): "Friday" runs from Friday 5 AM to Saturday 4:59:59 AM.
// All month/week arithmetic is done on local calendar parts; Date.UTC normalises overflow
// (month 12 -> January next year, day 0 -> last day of previous month).

export interface DateRange {
  start: Date;
  end: Date;
}

export type PeriodPreset =
  | 'TODAY' | 'YESTERDAY' | 'LAST_7_DAYS' | 'THIS_WEEK' | 'LAST_WEEK'
  | 'THIS_MONTH' | 'LAST_MONTH' | 'THIS_QUARTER' | 'LAST_QUARTER' | 'THIS_YEAR' | 'LAST_YEAR' | 'CUSTOM';

export type CompareMode = 'PREVIOUS' | 'LAST_YEAR' | 'CUSTOM' | 'NONE';

export interface ResolvedPeriod extends DateRange {
  preset: PeriodPreset;
  toDate: boolean;
}

export interface DayStrings {
  from: string;
  to: string;
}

export const MAX_PERIOD_DAYS = 400;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dayStart = businessDayStart;
const before = (instant: Date) => new Date(instant.getTime() - 1);

function badRequest(message: string): never {
  throw new AppError('BAD_REQUEST', message, 400);
}

function parseDay(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return badRequest('Dates must look like YYYY-MM-DD');
  const [y, m, d] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const start = dayStart(y, m, d);
  const parts = businessParts(start);
  if (parts.year !== y || parts.month !== m || parts.day !== d) return badRequest('That date does not exist');
  return start;
}

/** Whole days from the start of `from` to the end of `to`; rejects reversed or over-long ranges. */
function customRange(custom: DayStrings | undefined): DateRange {
  if (!custom) return badRequest('Pick a start and end date');
  const start = parseDay(custom.from);
  const lastDay = parseDay(custom.to);
  if (start.getTime() > lastDay.getTime()) return badRequest('The start date must be on or before the end date');
  const range = { start, end: before(new Date(lastDay.getTime() + ONE_DAY_MS)) };
  if (periodDays(range) > MAX_PERIOD_DAYS) return badRequest(`Pick a period of ${MAX_PERIOD_DAYS} days or fewer`);
  return range;
}

export function resolvePeriod(preset: PeriodPreset, now: Date, custom?: DayStrings): ResolvedPeriod {
  const { year: y, month: m, day: d, weekday } = businessParts(now);
  const weekStart = d - ((weekday + 6) % 7); // weeks start on Monday
  const q = Math.floor(m / 3) * 3;
  const toDate = (start: Date): ResolvedPeriod => ({ preset, start, end: now, toDate: true });
  const whole = (start: Date, nextStart: Date): ResolvedPeriod => ({ preset, start, end: before(nextStart), toDate: false });

  switch (preset) {
    case 'TODAY': return toDate(dayStart(y, m, d));
    case 'YESTERDAY': return whole(dayStart(y, m, d - 1), dayStart(y, m, d));
    case 'LAST_7_DAYS': return toDate(dayStart(y, m, d - 6));
    case 'THIS_WEEK': return toDate(dayStart(y, m, weekStart));
    case 'LAST_WEEK': return whole(dayStart(y, m, weekStart - 7), dayStart(y, m, weekStart));
    case 'THIS_MONTH': return toDate(dayStart(y, m, 1));
    case 'LAST_MONTH': return whole(dayStart(y, m - 1, 1), dayStart(y, m, 1));
    case 'THIS_QUARTER': return toDate(dayStart(y, q, 1));
    case 'LAST_QUARTER': return whole(dayStart(y, q - 3, 1), dayStart(y, q, 1));
    case 'THIS_YEAR': return toDate(dayStart(y, 0, 1));
    case 'LAST_YEAR': return whole(dayStart(y - 1, 0, 1), dayStart(y, 0, 1));
    case 'CUSTOM': return { preset, ...customRange(custom), toDate: false };
    default: return badRequest('Unknown period');
  }
}

/** Start of the same calendar day one year earlier, with 29 Feb becoming 28 Feb. */
function yearAgo(instant: Date): Date {
  const { year, month, day } = businessParts(instant);
  const lastDayOfFeb = new Date(Date.UTC(year - 1, 2, 0)).getUTCDate();
  const clamped = month === 1 && day > lastDayOfFeb ? lastDayOfFeb : day;
  return dayStart(year - 1, month, clamped);
}

export function comparisonPeriod(
  current: ResolvedPeriod,
  mode: CompareMode,
  now: Date,
  custom?: DayStrings,
): DateRange | null {
  if (mode === 'NONE') return null;
  if (mode === 'CUSTOM') return customRange(custom);

  if (mode === 'LAST_YEAR') {
    const start = yearAgo(current.start);
    const endDay = yearAgo(current.end);
    if (current.toDate) {
      // Same clock time a year earlier (time since the business day's 5 AM start).
      const sinceDayStart = current.end.getTime() - businessStartOfDay(current.end).getTime();
      return { start, end: new Date(endDay.getTime() + sinceDayStart) };
    }
    return { start, end: before(new Date(endDay.getTime() + ONE_DAY_MS)) };
  }

  // PREVIOUS: move the start back one unit.
  const s = businessParts(current.start);
  let start: Date;
  switch (current.preset) {
    case 'TODAY': case 'YESTERDAY': start = dayStart(s.year, s.month, s.day - 1); break;
    case 'LAST_7_DAYS': case 'THIS_WEEK': case 'LAST_WEEK': start = dayStart(s.year, s.month, s.day - 7); break;
    case 'THIS_MONTH': case 'LAST_MONTH': start = dayStart(s.year, s.month - 1, 1); break;
    case 'THIS_QUARTER': case 'LAST_QUARTER': start = dayStart(s.year, s.month - 3, 1); break;
    case 'THIS_YEAR': case 'LAST_YEAR': start = dayStart(s.year - 1, 0, 1); break;
    default: start = dayStart(s.year, s.month, s.day - periodDays(current)); // CUSTOM: same length just before
  }
  // The earlier unit always ends right where the current one begins.
  const unitEnd = before(current.start);
  if (!current.toDate) return { start, end: unitEnd };
  const end = new Date(start.getTime() + (now.getTime() - current.start.getTime()));
  return { start, end: end.getTime() > unitEnd.getTime() ? unitEnd : end };
}

const fmtDay = (p: { day: number; month: number }) => `${p.day} ${MONTHS[p.month]}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

export function describeRange(range: DateRange, now: Date): string {
  const s = businessParts(range.start);
  const e = businessParts(range.end);
  const n = businessParts(now);
  const wholeDays =
    s.hour === 0 && s.minute === 0 &&
    businessStartOfDay(new Date(range.end.getTime() + 1)).getTime() === range.end.getTime() + 1;
  const sameDay = s.year === e.year && s.month === e.month && s.day === e.day;

  if (sameDay) {
    if (s.year === n.year && s.month === n.month && s.day === n.day) return 'Today';
    const yesterday = businessParts(dayStart(n.year, n.month, n.day - 1));
    if (s.year === yesterday.year && s.month === yesterday.month && s.day === yesterday.day) return 'Yesterday';
    const year = s.year === n.year ? '' : ` ${s.year}`;
    return `${WEEKDAYS[s.weekday]} ${fmtDay(s)}${year}`;
  }

  if (wholeDays && s.day === 1 && e.year === s.year) {
    const endsOnLastDay = e.day === daysInMonth(e.year, e.month);
    if (s.month === 0 && e.month === 11 && endsOnLastDay) return `${s.year}`;
    if (s.month % 3 === 0 && e.month === s.month + 2 && endsOnLastDay) {
      return `${MONTHS[s.month]}–${MONTHS[e.month]} ${s.year}`;
    }
    if (e.month === s.month && endsOnLastDay) return `${MONTHS[s.month]} ${s.year}`;
  }

  if (s.year === e.year && s.month === e.month) return `${s.day}–${e.day} ${MONTHS[e.month]} ${e.year}`;
  if (s.year === e.year) return `${fmtDay(s)} – ${fmtDay(e)} ${e.year}`;
  return `${fmtDay(s)} ${s.year} – ${fmtDay(e)} ${e.year}`;
}

export function compareLabel(current: ResolvedPeriod, mode: CompareMode, cmp: DateRange | null, now: Date): string {
  if (mode === 'NONE' || !cmp) return '';
  if (mode === 'PREVIOUS' && current.preset === 'TODAY') return 'vs yesterday, same time';
  if (mode === 'PREVIOUS' && current.preset === 'YESTERDAY') return 'vs the day before';

  const s = businessParts(cmp.start);
  const e = businessParts(cmp.end);
  const singleDay = s.year === e.year && s.month === e.month && s.day === e.day;
  // A custom comparison day is always a whole day, so it is never "same time"
  const sameTime = current.toDate && singleDay && mode !== 'CUSTOM' ? ', same time' : '';
  const lastYear = mode === 'LAST_YEAR' ? ' (last year)' : '';
  return `vs ${describeRange(cmp, now)}${sameTime}${lastYear}`;
}

/** Business days touched by the range. */
export function periodDays(range: DateRange): number {
  const first = businessStartOfDay(range.start).getTime();
  const last = businessStartOfDay(range.end).getTime();
  return Math.round((last - first) / ONE_DAY_MS) + 1;
}

/** Percentage change to one decimal; null when there is nothing to compare against. */
export function pctChange(current: number, previous: number): number | null {
  if (!(previous > 0)) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
