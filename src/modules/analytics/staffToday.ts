/*
 * Who is working today, from Alayn's own records: date-specific shift assignments (or, if there are
 * none, the weekly roster), today's clock-ins and approved leave. Used by the Overview's Shift
 * Coverage card and by AlaynAI, so both always tell the owner the same thing.
 */
import { prisma } from '../../config/prisma';
import { outletScope } from '../../utils/tenantScope';
import { BUSINESS_DAY_START_HOUR, businessParts, outletLocalParts } from '../../utils/outletTime';

/** Minutes since the 5 AM start of the business day for an "HH:MM" clock time ("01:00" is late tonight, not this morning). */
const businessMinutesOf = (hhmm: string) => (minutesOf(hhmm) - BUSINESS_DAY_START_HOUR * 60 + 1440) % 1440;

const DAY_ENUM = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;

/**
 * - in: clocked in, not out yet       - left: clocked in and out
 * - not_in: shift has started, no clock-in   - upcoming: shift hasn't started yet
 * - leave: approved leave today        - off: rostered weekly off
 */
export type StaffStatus = 'in' | 'left' | 'not_in' | 'upcoming' | 'leave' | 'off';

export interface StaffTodayEntry {
  employeeId: string;
  name: string;
  role: string;
  outletName: string | null;
  shift: { name: string; startTime: string; endTime: string } | null;
  status: StaffStatus;
  late: boolean;
  clockIn: Date | null;
  clockOut: Date | null;
}

export interface StaffToday {
  weekday: number; // 0 = Sunday, outlet-local
  /** Where the roster came from; 'none' means no roster is set up for today */
  rosterSource: 'assignments' | 'weekly' | 'none';
  entries: StaffTodayEntry[];
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** "16:00" → "4 PM", "09:30" → "9:30 AM" */
export function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 || h === 24 ? 'AM' : 'PM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hour}:${String(m).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`;
}

/** Instant → "8:05 AM" in outlet-local time */
export function instant12(instant: Date): string {
  const { hour, minute } = outletLocalParts(instant);
  return clock12(`${hour}:${minute}`);
}

export async function getStaffToday(outletId?: string, businessId?: string, now: Date = new Date()): Promise<StaffToday> {
  const scope = outletScope(outletId, businessId);
  // Business day: at 1 AM "today" is still last night's roster and attendance
  const { year, month, day, weekday, hour, minute } = businessParts(now);
  const today = new Date(Date.UTC(year, month, day)); // @db.Date columns hold the (business) date
  const activeEmployee = { deletedAt: null, status: 'ACTIVE' as const };
  const employee = { select: { id: true, name: true, role: true, outlet: { select: { name: true } } } };
  const shiftSelect = { select: { name: true, startTime: true, endTime: true } };

  const assignments = await prisma.shiftAssignment.findMany({
    where: { ...scope, date: today, employee: activeEmployee },
    select: { employee, shift: shiftSelect },
    take: 100,
  });
  const weekly = assignments.length
    ? []
    : await prisma.employeeRoster.findMany({
        where: { ...scope, dayOfWeek: DAY_ENUM[weekday], employee: activeEmployee },
        select: { employee, shift: shiftSelect },
        take: 100,
      });
  const [attendance, leave] = await Promise.all([
    prisma.attendance.findMany({
      where: { ...scope, date: today },
      select: { checkInTime: true, checkOutTime: true, isLate: true, employee },
    }),
    prisma.leaveRequest.findMany({
      where: { ...scope, status: 'APPROVED', startDate: { lte: today }, endDate: { gte: today } },
      select: { employee },
    }),
  ]);

  const rostered = assignments.length ? assignments : weekly;
  const nowMinutes = hour * 60 + minute;
  const byEmployee = new Map<string, StaffTodayEntry>();
  const base = (e: (typeof rostered)[number]['employee']) => ({
    employeeId: e.id,
    name: e.name,
    role: e.role,
    outletName: e.outlet?.name ?? null,
    late: false,
    clockIn: null,
    clockOut: null,
  });

  for (const r of rostered) {
    const started = r.shift ? nowMinutes >= businessMinutesOf(r.shift.startTime) : false;
    byEmployee.set(r.employee.id, {
      ...base(r.employee),
      shift: r.shift,
      status: r.shift ? (started ? 'not_in' : 'upcoming') : 'off',
    });
  }
  // People can clock in without being rostered (extra shift, cover), so attendance adds them too
  for (const a of attendance) {
    const entry = byEmployee.get(a.employee.id) ?? { ...base(a.employee), shift: null, status: 'in' as StaffStatus };
    entry.clockIn = a.checkInTime;
    entry.clockOut = a.checkOutTime;
    entry.late = a.isLate;
    entry.status = a.checkOutTime ? 'left' : 'in';
    byEmployee.set(a.employee.id, entry);
  }
  for (const l of leave) {
    const entry = byEmployee.get(l.employee.id) ?? { ...base(l.employee), shift: null, status: 'leave' as StaffStatus };
    if (!entry.clockIn) entry.status = 'leave';
    byEmployee.set(l.employee.id, entry);
  }

  return {
    weekday,
    rosterSource: assignments.length ? 'assignments' : weekly.length ? 'weekly' : 'none',
    entries: [...byEmployee.values()],
  };
}
