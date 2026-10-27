import { AttendanceRepository } from './attendance.repository';
import { AppError } from '../../utils/AppError';
import { assertCanManageEmployee } from '../employees/employee.permissions';
import { findApprovedLeaveOn } from '../employees/leave.helpers';
import { BUSINESS_DAY_START_HOUR, businessParts, outletDayStart, outletLocalParts } from '../../utils/outletTime';

// All outlets currently operate in India (IST, UTC+5:30). Attendance times are
// always taken from the server clock and converted to India time — never
// from the client, which staff could tamper with.
//
// Days are business days, 5 AM to 5 AM (see utils/outletTime.ts): a night shift that runs past
// midnight belongs to the evening it started, and so do its breaks and clock-out.
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_EARLY_BUFFER_MINUTES = 30;
const DEFAULT_LATE_GRACE_MINUTES = 30;
const EARLY_DEPARTURE_THRESHOLD_MINUTES = 15;

// A punch still open after this long is treated as a forgotten clock-out. It is NOT given an invented
// end time: it is flagged "missed clock-out" and counts 0 hours until a manager enters the real time.
// Long enough that genuine double shifts / overtime past closing are never cut off.
const STALE_OPEN_PUNCH_HOURS = 20;

// Before 5 AM, a clock-in counts towards the next day's shift when that shift starts within this many hours
const EARLY_OPENER_LOOKAHEAD_HOURS = 6;
// ...unless they clocked out on the previous business day within this many hours (a night break)
const NIGHT_BREAK_RETURN_HOURS = 4;

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

// Roles allowed to clock in/out on behalf of another employee (e.g. shared terminal, fixing a missed punch)
const PROXY_PUNCH_ROLES = ['BUSINESS_OWNER', 'MANAGER', 'SUPER_ADMIN'];

export interface AttendanceActor {
  userId?: string;
  role?: string;
  businessId?: string | null;
}

export interface AttendancePunchInput {
  employeeId?: string;
  latitude?: number;
  longitude?: number;
  // Set after the employee confirms "Clock in anyway?" on a holiday / closed day / weekly off
  confirmOffDay?: boolean;
}

export interface AttendanceCorrectionInput {
  checkInTime?: Date;
  checkOutTime?: Date;
  reason: string;
}

/** The business date (stored as UTC midnight, like every @db.Date) that an instant belongs to. */
export function businessDateOf(instant: Date): Date {
  const { year, month, day } = businessParts(instant);
  return new Date(Date.UTC(year, month, day));
}

/**
 * When a shift rostered on a business date really starts and ends. Clock times before 5 AM belong to the
 * night after that date (a Friday "00:00–04:00" shift runs Saturday 12–4 AM), and an end at or before
 * the start runs past midnight ("20:00–03:00").
 */
export function shiftWindow(date: Date, startTime: string, endTime: string): { start: Date; end: Date } {
  const midnight = outletDayStart(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()).getTime();
  const at = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    const mins = h * 60 + m;
    return midnight + mins * MINUTE_MS + (mins < BUSINESS_DAY_START_HOUR * 60 ? DAY_MS : 0);
  };
  const start = at(startTime);
  let end = at(endTime);
  if (end <= start) end += DAY_MS;
  return { start: new Date(start), end: new Date(end) };
}

/** "5:30 PM" in India time */
function clockLabel(instant: Date): string {
  const { hour, minute } = outletLocalParts(instant);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function summaryStatus(isLate: boolean, leftEarly: boolean): 'PRESENT' | 'LATE' | 'EARLY_DEPARTURE' {
  // The single legacy status column keeps the most important fact; the separate flags keep both.
  if (isLate) return 'LATE';
  if (leftEarly) return 'EARLY_DEPARTURE';
  return 'PRESENT';
}

export class AttendanceService {
  private attendanceRepository = new AttendanceRepository();

  /**
   * The business date a clock-in belongs to. From 5 AM it is always the current business day. Before 5 AM
   * the punch stays on the previous business day (the night still running) only while the person is still
   * clocked in, clocked out within the last few hours (a night break), or their night shift hasn't ended yet; otherwise, if the next day's shift starts within a few
   * hours, it is an early opener and belongs to that day (so the usual "too early" rule applies).
   */
  private async punchDate(
    employeeId: string,
    now: Date,
    openRecord: { checkInTime: Date } | null,
    repo: AttendanceRepository
  ): Promise<Date> {
    const today = businessDateOf(now);
    if (outletLocalParts(now).hour >= BUSINESS_DAY_START_HOUR) return today;

    if (openRecord && !this.isStale(openRecord.checkInTime, now)) return today;
    // Back from a break taken during the night (unrostered, or overtime past the shift's end)
    const earlier = await repo.findAttendancesOnDate(employeeId, today);
    const breakCutoff = now.getTime() - NIGHT_BREAK_RETURN_HOURS * 60 * 60 * 1000;
    if (earlier.some((a) => a.checkOutTime && a.checkOutTime.getTime() >= breakCutoff)) return today;
    const { shift: current } = await this.findScheduledShift(employeeId, today, repo);
    if (current && shiftWindow(today, current.startTime, current.endTime).end.getTime() > now.getTime()) return today;

    const next = new Date(today.getTime() + DAY_MS);
    const { shift: upcoming } = await this.findScheduledShift(employeeId, next, repo);
    if (upcoming) {
      const { start } = shiftWindow(next, upcoming.startTime, upcoming.endTime);
      if (start.getTime() - now.getTime() <= EARLY_OPENER_LOOKAHEAD_HOURS * 60 * MINUTE_MS) return next;
    }
    return today;
  }

  private isStale(checkInTime: Date, now: Date) {
    return now.getTime() - checkInTime.getTime() > STALE_OPEN_PUNCH_HOURS * 60 * 60 * 1000;
  }

  /** The shift an employee is scheduled for on a date: a date-specific assignment wins, otherwise the weekly roster. */
  private async findScheduledShift(employeeId: string, date: Date, repo = this.attendanceRepository) {
    const assignment = await repo.findShiftAssignment(employeeId, date);
    if (assignment?.shift) {
      return { shift: assignment.shift, roster: null };
    }
    // `date` is UTC midnight of the local calendar day, so its UTC weekday is the local weekday
    const roster = await repo.findEmployeeRoster(employeeId, DAY_NAMES[date.getUTCDay()]);
    return { shift: roster?.shift ?? null, roster };
  }

  /**
   * Decides whose attendance is being punched. Staff/Kitchen can only punch for
   * themselves; only owners/managers may pass another employee's ID.
   */
  private async resolveTargetEmployee(outletId: string, actor: AttendanceActor, requestedEmployeeId?: string) {
    const self = actor.userId ? await this.attendanceRepository.findEmployeeByUserId(actor.userId) : null;
    const isProxyPunch = !!requestedEmployeeId && requestedEmployeeId !== self?.id;

    if (isProxyPunch) {
      if (!actor.role || !PROXY_PUNCH_ROLES.includes(actor.role)) {
        throw new AppError('FORBIDDEN', 'You can only clock in or out for yourself.', 403);
      }
      const employee = await this.attendanceRepository.findEmployee(outletId, requestedEmployeeId!, actor.businessId);
      if (!employee) {
        throw new AppError('EMPLOYEE_NOT_FOUND', 'Employee not found', 404);
      }
      return employee;
    }

    if (!self) {
      throw new AppError('EMPLOYEE_NOT_FOUND', 'Employee profile not found for logged in user', 404);
    }
    return self;
  }

  private getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3; // metres
    const phi1 = lat1 * Math.PI / 180; // φ, λ in radians
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  private assertWithinGeofence(outlet: any, lat: number | undefined, lng: number | undefined, action: 'in' | 'out') {
    if (outlet && outlet.latitude && outlet.longitude) {
      if (lat === undefined || lng === undefined) {
        throw new AppError('LOCATION_REQUIRED', `Location access is required to punch ${action} at this outlet.`, 400);
      }
      const distance = this.getDistance(lat, lng, outlet.latitude, outlet.longitude);
      const maxRadius = outlet.geofenceRadius || 100;
      if (distance > maxRadius) {
        throw new AppError('OUTSIDE_GEOFENCE', `You are ${Math.round(distance)} meters away. You must be within ${maxRadius} meters of the outlet to punch ${action}.`, 400);
      }
    }
  }

  async checkIn(
    outletId: string,
    actor: AttendanceActor,
    input: AttendancePunchInput = {},
    now: Date = new Date()
  ) {
    const employee = await this.resolveTargetEmployee(outletId, actor, input.employeeId);
    const targetEmployeeId = employee.id;
    outletId = employee.outletId;

    if (employee.status !== 'ACTIVE') {
      throw new AppError('INACTIVE_EMPLOYEE', 'Inactive employees cannot check in', 400);
    }

    // Serialised per employee: a double tap or retried request waits here, then sees the first punch as open
    return this.attendanceRepository.withEmployeePunchLock(targetEmployeeId, (repo) =>
      this.createPunch(repo, outletId, targetEmployeeId, input, now)
    );
  }

  private async createPunch(
    repo: AttendanceRepository,
    outletId: string,
    targetEmployeeId: string,
    input: AttendancePunchInput,
    now: Date
  ) {
    const { latitude: lat, longitude: lng } = input;
    const outlet = await repo.findOutlet(outletId);
    // Rules are configured per outlet by the owner/manager (Settings), never supplied by the client
    const earlyBufferMinutes = outlet?.earlyBufferMinutes ?? DEFAULT_EARLY_BUFFER_MINUTES;
    const lateGraceMinutes = outlet?.lateGraceMinutes ?? DEFAULT_LATE_GRACE_MINUTES;

    const openRecord = await repo.findOpenAttendance(targetEmployeeId);
    // Business date (UTC midnight of the day this punch belongs to; days run 5 AM to 5 AM)
    const date = await this.punchDate(targetEmployeeId, now, openRecord, repo);

    if (openRecord) {
      const fromEarlierDay = openRecord.date.getTime() < date.getTime();
      if (fromEarlierDay || this.isStale(openRecord.checkInTime, now)) {
        // Forgot to clock out last time: flag it for the manager (0 hours, no invented end time) and carry on
        await repo.markMissedClockOut(openRecord.id);
      } else {
        throw new AppError('ALREADY_CHECKED_IN', 'You are already clocked in. Clock out first.', 400);
      }
    }

    // Split shifts / breaks: several punches per day are allowed. Late/early rules apply to the first one only.
    const earlierToday = await repo.findAttendancesOnDate(targetEmployeeId, date);
    const isFirstPunchToday = earlierToday.length === 0;

    this.assertWithinGeofence(outlet, lat, lng, 'in');

    // Holidays, closed days and weekly offs no longer block clock-in: the employee confirms, and the
    // punch is tagged so the manager can see (and pay) it correctly.
    const currentDayName = DAY_NAMES[date.getUTCDay()];
    const holiday = await repo.findOutletHoliday(outletId, date);

    let workedOnClosedDay = false;
    if (outlet?.operatingDays) {
      try {
        const operatingDaysArr: string[] = JSON.parse(outlet.operatingDays);
        workedOnClosedDay = !operatingDaysArr.includes(currentDayName);
      } catch {
        // Malformed operating days: treat the outlet as open
      }
    }

    const { shift, roster } = await this.findScheduledShift(targetEmployeeId, date, repo);
    const onWeeklyOff = !shift && !!roster && roster.shiftId === null;
    const approvedLeave = await findApprovedLeaveOn(targetEmployeeId, date);
    // Working on a weekly off or during approved leave is an extra (unplanned) shift
    const extraShift = onWeeklyOff || !!approvedLeave;

    const offDayReasons: string[] = [];
    if (holiday) offDayReasons.push(`Today is an outlet holiday (${holiday.name}).`);
    if (workedOnClosedDay) offDayReasons.push(`The outlet is normally closed on ${currentDayName.toLowerCase()}s.`);
    if (approvedLeave) offDayReasons.push('You are on approved leave today.');
    else if (onWeeklyOff) offDayReasons.push('Today is your scheduled weekly off.');

    if (offDayReasons.length > 0 && isFirstPunchToday && !input.confirmOffDay) {
      throw new AppError('CLOCK_IN_CONFIRMATION_REQUIRED', `${offDayReasons.join(' ')} Clock in anyway?`, 409);
    }

    let isLate = false;
    if (shift && isFirstPunchToday) {
      const { startTime, name: shiftName } = shift;
      // Real instants, so a shift starting at midnight and a clock-in at 11:45 PM compare correctly
      const { start, end } = shiftWindow(date, startTime, shift.endTime);
      const earliestAllowed = start.getTime() - earlyBufferMinutes * MINUTE_MS;

      if (now.getTime() < earliestAllowed) {
        throw new AppError(
          'TOO_EARLY',
          `Cannot clock in yet: Your ${shiftName} starts at ${startTime}. Early clock-in opens ${earlyBufferMinutes} minutes prior (at ${clockLabel(new Date(earliestAllowed))}).`,
          400
        );
      }

      // A punch before 5 AM kept on the previous business day after that day's shift had ended is night
      // work, not a late arrival. Otherwise arriving after the grace (even after the shift's end) is late.
      const nightAfterShift =
        outletLocalParts(now).hour < BUSINESS_DAY_START_HOUR &&
        date.getTime() === businessDateOf(now).getTime() &&
        now.getTime() > end.getTime();
      isLate = !nightAfterShift && now.getTime() > start.getTime() + lateGraceMinutes * MINUTE_MS;
    }

    if (!isFirstPunchToday) {
      // Back from a break / second half of a split shift: the earlier clock-out wasn't "leaving early"
      await repo.clearLeftEarlyOnDate(targetEmployeeId, date);
    }

    return repo.createAttendance({
      outletId,
      employeeId: targetEmployeeId,
      date,
      checkInTime: now,
      status: isLate ? 'LATE' : 'PRESENT',
      isLate,
      workedOnHoliday: !!holiday,
      workedOnClosedDay,
      extraShift,
    });
  }

  async checkOut(
    outletId: string,
    actor: AttendanceActor,
    input: AttendancePunchInput = {},
    now: Date = new Date()
  ) {
    const { latitude: lat, longitude: lng } = input;
    const employee = await this.resolveTargetEmployee(outletId, actor, input.employeeId);
    const targetEmployeeId = employee.id;
    outletId = employee.outletId;

    const openRecord = await this.attendanceRepository.findOpenAttendance(targetEmployeeId);
    if (!openRecord) {
      throw new AppError('NO_OPEN_ATTENDANCE', 'No open attendance record found for this employee', 400);
    }

    if (this.isStale(openRecord.checkInTime, now)) {
      // Clocking out a day later would record an invented 20+ hour shift
      await this.attendanceRepository.markMissedClockOut(openRecord.id);
      throw new AppError(
        'MISSED_CLOCK_OUT',
        'Your last clock-in was too long ago and has been marked as a missed clock-out. Please ask your manager to enter the correct time.',
        400
      );
    }

    const outlet = await this.attendanceRepository.findOutlet(outletId);
    this.assertWithinGeofence(outlet, lat, lng, 'out');

    if (now <= openRecord.checkInTime) {
      throw new AppError('INVALID_CHECKOUT_TIME', 'Check-out time must be after check-in time', 400);
    }

    let leftEarly = false;
    const { shift } = await this.findScheduledShift(targetEmployeeId, openRecord.date);

    if (shift) {
      // The shift of the day this punch belongs to; night shifts crossing midnight end the next morning
      const { end } = shiftWindow(openRecord.date, shift.startTime, shift.endTime);
      leftEarly = now.getTime() < end.getTime() - EARLY_DEPARTURE_THRESHOLD_MINUTES * MINUTE_MS;
    }

    // Late and left-early are stored separately, so leaving early never erases a late arrival
    return this.attendanceRepository.updateAttendance(openRecord.id, {
      checkOutTime: now,
      leftEarly,
      status: summaryStatus(openRecord.isLate, leftEarly),
    });
  }

  /**
   * Manager/owner correction of a punch (e.g. entering the real time for a missed clock-out).
   * Keeps an audit trail: who changed it, when and why.
   */
  async correctAttendance(
    outletId: string,
    actor: AttendanceActor,
    attendanceId: string,
    input: AttendanceCorrectionInput,
    now: Date = new Date()
  ) {
    const record = await this.attendanceRepository.findAttendanceById(attendanceId);
    const isAll = !outletId || outletId === 'all';
    const inScope =
      !!record &&
      (isAll
        ? actor.role === 'SUPER_ADMIN' || record.employee.outlet.businessId === actor.businessId
        : record.outletId === outletId);
    if (!record || !inScope) {
      throw new AppError('ATTENDANCE_NOT_FOUND', 'Attendance record not found', 404);
    }

    if (record.employee.userId && record.employee.userId === actor.userId) {
      throw new AppError('FORBIDDEN', 'You cannot edit your own attendance. Ask the business owner.', 403);
    }
    // Managers may only correct Staff and Kitchen attendance
    assertCanManageEmployee({ userId: actor.userId || '', role: actor.role || '', businessId: actor.businessId }, record.employee);

    const newIn = input.checkInTime ?? record.checkInTime;
    const newOut = input.checkOutTime ?? record.checkOutTime;

    if (newIn > now || (newOut && newOut > now)) {
      throw new AppError('INVALID_TIME', 'Attendance times cannot be in the future.', 400);
    }
    if (newOut && newOut <= newIn) {
      throw new AppError('INVALID_TIME', 'Clock-out time must be after clock-in time.', 400);
    }
    if (newOut && newOut.getTime() - newIn.getTime() > 24 * 60 * 60 * 1000) {
      throw new AppError('INVALID_TIME', 'A single shift cannot be longer than 24 hours.', 400);
    }
    if (newOut) {
      const overlap = await this.attendanceRepository.findOverlappingAttendance(record.employeeId, record.id, newIn, newOut);
      if (overlap) {
        throw new AppError('OVERLAPPING_ATTENDANCE', 'These times overlap with another punch of the same employee.', 400);
      }
    }

    return this.attendanceRepository.updateAttendance(record.id, {
      checkInTime: newIn,
      checkOutTime: newOut,
      // Once a real end time is entered, the record counts again
      missedClockOut: newOut ? false : record.missedClockOut,
      editedById: actor.userId,
      editReason: input.reason.trim(),
      editedAt: now,
    });
  }

  async getAttendanceLogs(outletId: string, businessId?: string, now: Date = new Date()) {
    // Surface forgotten clock-outs as soon as anyone looks at attendance (no background scheduler needed)
    await this.attendanceRepository.markStaleOpenRecordsMissed(
      new Date(now.getTime() - STALE_OPEN_PUNCH_HOURS * 60 * 60 * 1000)
    );
    return this.attendanceRepository.findAttendanceLogs(outletId, businessId);
  }
}
export default AttendanceService;
