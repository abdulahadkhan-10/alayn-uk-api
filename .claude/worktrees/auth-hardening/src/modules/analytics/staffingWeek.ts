/*
 * Week-ahead staffing: how many people are rostered on each of the next 7 days, next to that day's
 * sales forecast, flagging days where the two don't match ("Saturday is forecast at twice a Tuesday
 * but has the same 4 staff"). Uses the same roster rules as Shift Coverage: date-specific assignments
 * replace the weekly roster for that date, and approved leave takes people off.
 */
import { prisma } from '../../config/prisma';
import { outletScope } from '../../utils/tenantScope';

const DAY_ENUM = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
/** A day this much busier (or quieter) than the week's average is worth a look */
const BUSY = 1.3;
const QUIET = 0.7;

export type StaffingFlag = 'understaffed' | 'overstaffed' | null;

export interface StaffingDayInput {
  date: string; // YYYY-MM-DD, outlet-local
  weekday: number; // 0 = Sunday
  forecast: number | null; // rupees; null when there's no forecast yet
  closed: boolean;
  staff: number;
}

export interface StaffingDay extends StaffingDayInput {
  flag: StaffingFlag;
  /** Forecast sales per person rostered */
  salesPerStaff: number | null;
}

/** Pure: compares each day with the week's averages. */
export function flagStaffing(days: StaffingDayInput[]): StaffingDay[] {
  const open = days.filter((d) => !d.closed && d.forecast !== null && d.forecast > 0);
  const avgForecast = open.length ? open.reduce((s, d) => s + (d.forecast ?? 0), 0) / open.length : 0;
  const avgStaff = open.length ? open.reduce((s, d) => s + d.staff, 0) / open.length : 0;

  return days.map((d) => {
    let flag: StaffingFlag = null;
    if (!d.closed && d.forecast !== null && avgForecast > 0 && open.length >= 3) {
      if (d.forecast >= avgForecast * BUSY && d.staff <= avgStaff) flag = 'understaffed';
      else if (d.forecast <= avgForecast * QUIET && d.staff >= avgStaff && d.staff > 0) flag = 'overstaffed';
    }
    return { ...d, flag, salesPerStaff: d.forecast !== null && d.staff > 0 ? Math.round(d.forecast / d.staff) : null };
  });
}

/** People rostered on each given date (outlet-local "YYYY-MM-DD"), minus approved leave. */
export async function rosteredStaffByDate(
  outletId: string | undefined,
  businessId: string | undefined,
  dates: { date: string; weekday: number }[],
): Promise<Map<string, number>> {
  const scope = outletScope(outletId, businessId);
  const activeEmployee = { deletedAt: null, status: 'ACTIVE' as const };
  const asDbDate = (d: string) => new Date(`${d}T00:00:00.000Z`); // @db.Date columns hold the calendar date
  const from = asDbDate(dates[0].date);
  const to = asDbDate(dates[dates.length - 1].date);

  const [assignments, weekly, leave] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: { ...scope, date: { gte: from, lte: to }, employee: activeEmployee },
      select: { date: true, employeeId: true },
    }),
    prisma.employeeRoster.findMany({
      where: { ...scope, shiftId: { not: null }, employee: activeEmployee },
      select: { dayOfWeek: true, employeeId: true },
    }),
    prisma.leaveRequest.findMany({
      where: { ...scope, status: 'APPROVED', startDate: { lte: to }, endDate: { gte: from } },
      select: { employeeId: true, startDate: true, endDate: true },
    }),
  ]);

  const result = new Map<string, number>();
  for (const { date, weekday } of dates) {
    const day = asDbDate(date).getTime();
    const assigned = assignments.filter((a) => a.date.getTime() === day).map((a) => a.employeeId);
    // Date-specific assignments replace the weekly roster for that date
    const people = new Set(assigned.length ? assigned : weekly.filter((r) => r.dayOfWeek === DAY_ENUM[weekday]).map((r) => r.employeeId));
    for (const l of leave) {
      if (l.startDate.getTime() <= day && l.endDate.getTime() >= day) people.delete(l.employeeId);
    }
    result.set(date, people.size);
  }
  return result;
}
