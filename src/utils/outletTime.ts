// All outlets currently operate in India (IST, UTC+5:30). The server runs in UTC (Docker default),
// so "today", "this month" and "hour of day" must be computed in IST explicitly — never with the
// server's local clock (Date#getHours, new Date(y, m, d), setHours...), which would be 5h30m off.
export const OUTLET_UTC_OFFSET_MINUTES = 330;

const OFFSET_MS = OUTLET_UTC_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar parts of an instant in outlet local time. */
export function outletLocalParts(instant: Date) {
  const local = new Date(instant.getTime() + OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    day: local.getUTCDate(),
    weekday: local.getUTCDay(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
  };
}

/** The instant at which the given outlet-local calendar day starts (local midnight). */
export function outletDayStart(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day) - OFFSET_MS);
}

/** Start of the outlet-local day containing `instant`. */
export function outletStartOfDay(instant: Date): Date {
  const { year, month, day } = outletLocalParts(instant);
  return outletDayStart(year, month, day);
}

/** Last millisecond of the outlet-local day containing `instant`. */
export function outletEndOfDay(instant: Date): Date {
  return new Date(outletStartOfDay(instant).getTime() + DAY_MS - 1);
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
// (India time), not midnight to midnight. A 1:30 AM order on Saturday belongs to Friday night's business.
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

/** The instant a business day starts: 5 AM India time on that calendar date. */
export function businessDayStart(year: number, month: number, day: number): Date {
  return new Date(outletDayStart(year, month, day).getTime() + BUSINESS_SHIFT_MS);
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
