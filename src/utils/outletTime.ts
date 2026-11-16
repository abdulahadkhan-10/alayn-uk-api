// All outlets currently operate in the UK (Europe/London: GMT in winter, BST in summer). The server runs in UTC
// (Docker default), so "today", "this month" and "hour of day" must be computed in outlet time explicitly — never
// with the server's local clock (Date#getHours, new Date(y, m, d), setHours...), which would be off by the UK offset.
export const OUTLET_TIME_ZONE = 'Europe/London';

const DAY_MS = 24 * 60 * 60 * 1000;

const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: OUTLET_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  weekday: 'short',
});
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Calendar parts of an instant in outlet local time. */
export function outletLocalParts(instant: Date) {
  const get: Record<string, string> = {};
  for (const part of partsFormat.formatToParts(instant)) get[part.type] = part.value;
  return {
    year: Number(get.year),
    month: Number(get.month) - 1,
    day: Number(get.day),
    weekday: WEEKDAYS.indexOf(get.weekday),
    hour: Number(get.hour),
    minute: Number(get.minute),
  };
}

/** Offset of outlet local time from UTC at `instant`, in ms (0 in winter, +1h in summer). */
function offsetMsAt(instant: Date): number {
  const p = outletLocalParts(instant);
  return Date.UTC(p.year, p.month, p.day, p.hour, p.minute) - Math.floor(instant.getTime() / 60000) * 60000;
}

/** The instant at which the outlet-local wall clock reads the given date and hour (DST-aware). */
export function outletLocalToInstant(year: number, month: number, day: number, hour = 0): Date {
  const wall = Date.UTC(year, month, day, hour);
  let guess = wall - offsetMsAt(new Date(wall));
  guess = wall - offsetMsAt(new Date(guess));
  return new Date(guess);
}

/** The instant at which the given outlet-local calendar day starts (local midnight). */
export function outletDayStart(year: number, month: number, day: number): Date {
  return outletLocalToInstant(year, month, day);
}

/** Start of the outlet-local day containing `instant`. */
export function outletStartOfDay(instant: Date): Date {
  const { year, month, day } = outletLocalParts(instant);
  return outletDayStart(year, month, day);
}

/** Last millisecond of the outlet-local day containing `instant`. */
export function outletEndOfDay(instant: Date): Date {
  const { year, month, day } = outletLocalParts(instant);
  return new Date(outletDayStart(year, month, day + 1).getTime() - 1);
}

/** Start of the outlet-local day for a "YYYY-MM-DD" string (falls back to the instant's day for other formats). */
export function outletStartOfDateString(dateStr: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (match) {
    return outletDayStart(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  return outletStartOfDay(new Date(dateStr));
}

/** "YYYYMMDD" for the outlet-local day of `instant` (used in daily order numbers). */
export function outletDateKey(instant: Date): string {
  const { year, month, day } = outletLocalParts(instant);
  return `${year}${String(month + 1).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

export const ONE_DAY_MS = DAY_MS;

// ---------- Business day ----------
// Restaurants trade past midnight, so a "day" for sales, reports and attendance runs from 5 AM to 5 AM
// (UK time), not midnight to midnight. A 1:30 AM order on Saturday belongs to Friday night's business.
// Use these for "which day is this?"; keep outletLocalParts for "what time is it?" (hour-of-day charts,
// lunch-hour filters, shift clock times).
export const BUSINESS_DAY_START_HOUR = 5;
const BUSINESS_SHIFT_MS = BUSINESS_DAY_START_HOUR * 60 * 60 * 1000;

/**
 * The business day an instant belongs to (year/month/day/weekday), plus hour/minute counted from that
 * day's 5 AM start (so 5:00 AM is hour 0 and 4:59 AM next morning is hour 23).
 */
export function businessParts(instant: Date) {
  return outletLocalParts(new Date(instant.getTime() - BUSINESS_SHIFT_MS));
}

/** The instant a business day starts: 5 AM UK time on that calendar date. */
export function businessDayStart(year: number, month: number, day: number): Date {
  return outletLocalToInstant(year, month, day, BUSINESS_DAY_START_HOUR);
}

/** Start (5 AM) of the business day containing `instant`. */
export function businessStartOfDay(instant: Date): Date {
  const { year, month, day } = businessParts(instant);
  return businessDayStart(year, month, day);
}

/** "YYYY-MM-DD" of the business day containing `instant`. */
export function businessDateString(instant: Date): string {
  const { year, month, day } = businessParts(instant);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
