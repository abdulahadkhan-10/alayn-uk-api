import { AttendanceService, shiftWindow, businessDateOf } from '../src/modules/attendance/attendance.service';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => {
  const client: any = {
    $executeRaw: jest.fn(),
    employee: { findFirst: jest.fn() },
    attendance: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    outletHoliday: { findUnique: jest.fn() },
    outlet: { findUnique: jest.fn() },
    employeeRoster: { findUnique: jest.fn() },
    shiftAssignment: { findFirst: jest.fn() },
    leaveRequest: { findFirst: jest.fn() },
  };
  client.$transaction = jest.fn((fn: any) => fn(client));
  return { prisma: client };
});

// IST wall-clock time in October 2026. Fri 16 Oct, Sat 17 Oct.
const ist = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60 * 1000);
};
const DATE = (day: number) => new Date(Date.UTC(2026, 9, day)); // @db.Date value
const rahul = { userId: 'user-rahul', role: 'STAFF' };

/** Weekly roster by day name, e.g. { FRIDAY: lateShift, SATURDAY: null (weekly off) } */
function roster(byDay: Record<string, { name: string; startTime: string; endTime: string } | null>) {
  (prisma.employeeRoster.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
    const day = where.employeeId_dayOfWeek.dayOfWeek;
    if (!(day in byDay)) return null;
    const shift = byDay[day];
    return { shiftId: shift ? 'shift' : null, shift };
  });
}

describe('Night shifts and the 5 AM business day', () => {
  const service = new AttendanceService();

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.employee.findFirst as jest.Mock).mockResolvedValue({ id: 'emp-rahul', outletId: 'outlet-1', status: 'ACTIVE' });
    (prisma.attendance.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.attendance.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.attendance.create as jest.Mock).mockImplementation(({ data }: any) => ({ id: 'att-new', ...data }));
    (prisma.attendance.update as jest.Mock).mockImplementation(({ where, data }: any) => ({ id: where.id, ...data }));
    (prisma.attendance.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.outletHoliday.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.outlet.findUnique as jest.Mock).mockResolvedValue({ id: 'outlet-1', lateGraceMinutes: 15, earlyBufferMinutes: 30 });
    (prisma.shiftAssignment.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.leaveRequest.findFirst as jest.Mock).mockResolvedValue(null);
    roster({});
  });

  describe('helpers', () => {
    it('a punch at 1:30 AM Saturday belongs to Friday', () => {
      expect(businessDateOf(ist(17, '01:30'))).toEqual(DATE(16));
      expect(businessDateOf(ist(17, '05:00'))).toEqual(DATE(17));
    });

    it('shift times before 5 AM run on the night after the rostered day', () => {
      expect(shiftWindow(DATE(16), '20:00', '03:00')).toEqual({ start: ist(16, '20:00'), end: ist(17, '03:00') });
      expect(shiftWindow(DATE(16), '00:00', '04:00')).toEqual({ start: ist(17, '00:00'), end: ist(17, '04:00') });
      expect(shiftWindow(DATE(16), '10:00', '18:00')).toEqual({ start: ist(16, '10:00'), end: ist(16, '18:00') });
    });
  });

  describe('clock-in', () => {
    const midnightShift = { name: 'Midnight', startTime: '00:00', endTime: '04:00' };

    it('arriving at 11:45 PM for a midnight shift is on time, not late', async () => {
      roster({ FRIDAY: midnightShift });
      const result: any = await service.checkIn('outlet-1', rahul, {}, ist(16, '23:45'));
      expect(result.isLate).toBe(false);
      expect(result.date).toEqual(DATE(16));
    });

    it('arriving at 12:20 AM for a midnight shift is late, and uses Friday\'s roster', async () => {
      roster({ FRIDAY: midnightShift, SATURDAY: null });
      const result: any = await service.checkIn('outlet-1', rahul, {}, ist(17, '00:20'));
      expect(result.isLate).toBe(true);
      expect(result.date).toEqual(DATE(16));
    });

    it('coming back from a break at 12:30 AM continues Friday night, without weekly-off or too-early checks', async () => {
      roster({ FRIDAY: { name: 'Late', startTime: '20:00', endTime: '03:00' }, SATURDAY: null }); // Saturday is a weekly off
      (prisma.attendance.findMany as jest.Mock).mockResolvedValue([{ id: 'att-1', date: DATE(16) }]); // first half of the shift
      const result: any = await service.checkIn('outlet-1', rahul, {}, ist(17, '00:30'));
      expect(result.date).toEqual(DATE(16));
      expect(result.extraShift).toBe(false);
      expect(prisma.attendance.updateMany).toHaveBeenCalled(); // the break isn't "left early"
    });

    it('opening staff clocking in at 4:40 AM for a 5 AM shift get the new day\'s shift', async () => {
      roster({ SATURDAY: { name: 'Opening', startTime: '05:00', endTime: '13:00' } });
      const result: any = await service.checkIn('outlet-1', rahul, {}, ist(17, '04:40'));
      expect(result.date).toEqual(DATE(17));
      expect(result.isLate).toBe(false);
    });

    it('clocking in at 4:20 AM for a 5:00 AM shift is too early, and creates no Friday record', async () => {
      roster({ FRIDAY: { name: 'Morning', startTime: '10:00', endTime: '18:00' }, SATURDAY: { name: 'Opening', startTime: '05:00', endTime: '13:00' } });
      await expect(service.checkIn('outlet-1', rahul, {}, ist(17, '04:20'))).rejects.toMatchObject({
        code: 'TOO_EARLY',
        message: expect.stringContaining('(at 4:30 AM)'),
      });
      expect(prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('clocking in at 4:50 AM for a 5:30 AM shift is too early, and creates no Friday record', async () => {
      roster({ FRIDAY: { name: 'Morning', startTime: '10:00', endTime: '18:00' }, SATURDAY: { name: 'Opening', startTime: '05:30', endTime: '13:30' } });
      await expect(service.checkIn('outlet-1', rahul, {}, ist(17, '04:50'))).rejects.toMatchObject({
        code: 'TOO_EARLY',
        message: expect.stringContaining('(at 5:00 AM)'),
      });
      expect(prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('a first punch after 12 AM, kept on the day before once its shift has ended, is not marked late', async () => {
      roster({ FRIDAY: { name: 'Morning', startTime: '10:00', endTime: '18:00' } });
      const result: any = await service.checkIn('outlet-1', rahul, {}, ist(17, '02:00'));
      expect(result.date).toEqual(DATE(16));
      expect(result.isLate).toBe(false);
    });

    it('day shift 10 AM–6 PM, first clock-in at 7 PM is still late (the missed shift stays visible)', async () => {
      roster({ FRIDAY: { name: 'Morning', startTime: '10:00', endTime: '18:00' } });
      const result: any = await service.checkIn('outlet-1', rahul, {}, ist(16, '19:00'));
      expect(result.date).toEqual(DATE(16));
      expect(result.isLate).toBe(true);
      expect(result.status).toBe('LATE');
    });

    /** Punches already on a date, matching on the date like the database does. */
    const punchesOn = (date: Date, records: any[]) =>
      (prisma.attendance.findMany as jest.Mock).mockImplementation(({ where }: any) =>
        where.date.getTime() === date.getTime() ? records : []);

    it('unrostered night worker back from a break at 1:30 AM continues Friday, despite a 6 AM Saturday shift', async () => {
      roster({ SATURDAY: { name: 'Morning', startTime: '06:00', endTime: '14:00' } }); // no Friday shift
      punchesOn(DATE(16), [{ id: 'att-1', date: DATE(16), checkInTime: ist(16, '22:00'), checkOutTime: ist(17, '01:00') }]);
      const result: any = await service.checkIn('outlet-1', rahul, {}, ist(17, '01:30'));
      expect(result.date).toEqual(DATE(16));
      expect(result.isLate).toBe(false);
      expect(prisma.attendance.create).toHaveBeenCalledTimes(1);
      expect((prisma.attendance.create as jest.Mock).mock.calls[0][0].data.date).toEqual(DATE(16));
    });

    it('closer on overtime (6 PM–2 AM, break 1:45–2:15 AM) continues Friday, despite an 8:15 AM Saturday shift', async () => {
      roster({ FRIDAY: { name: 'Evening', startTime: '18:00', endTime: '02:00' }, SATURDAY: { name: 'Morning', startTime: '08:15', endTime: '16:00' } });
      punchesOn(DATE(16), [{ id: 'att-1', date: DATE(16), checkInTime: ist(16, '17:55'), checkOutTime: ist(17, '01:45') }]);
      const result: any = await service.checkIn('outlet-1', rahul, {}, ist(17, '02:15'));
      expect(result.date).toEqual(DATE(16));
      expect((prisma.attendance.create as jest.Mock).mock.calls[0][0].data.date).toEqual(DATE(16));
    });

    it('an early opener whose Friday ended long ago still gets "too early" on Saturday', async () => {
      roster({ FRIDAY: { name: 'Morning', startTime: '10:00', endTime: '18:00' }, SATURDAY: { name: 'Opening', startTime: '05:00', endTime: '13:00' } });
      punchesOn(DATE(16), [{ id: 'att-1', date: DATE(16), checkInTime: ist(16, '10:00'), checkOutTime: ist(16, '18:00') }]);
      await expect(service.checkIn('outlet-1', rahul, {}, ist(17, '04:20'))).rejects.toMatchObject({ code: 'TOO_EARLY' });
      expect(prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('6 PM–2 AM shift: in at 5:45 PM, break 12:30–1:00 AM, out at 2:00 AM all stay on Friday', async () => {
      roster({ FRIDAY: { name: 'Evening', startTime: '18:00', endTime: '02:00' }, SATURDAY: { name: 'Opening', startTime: '05:00', endTime: '13:00' } });
      const first: any = await service.checkIn('outlet-1', rahul, {}, ist(16, '17:45'));
      expect(first.date).toEqual(DATE(16));
      expect(first.isLate).toBe(false);

      (prisma.attendance.findFirst as jest.Mock).mockResolvedValue({ ...first, id: 'att-1' });
      const breakOut: any = await service.checkOut('outlet-1', rahul, {}, ist(17, '00:30'));
      expect(breakOut.leftEarly).toBe(true);

      (prisma.attendance.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.attendance.findMany as jest.Mock).mockResolvedValue([{ id: 'att-1', date: DATE(16) }]);
      const back: any = await service.checkIn('outlet-1', rahul, {}, ist(17, '01:00'));
      expect(back.date).toEqual(DATE(16));
      expect(prisma.attendance.updateMany).toHaveBeenCalled(); // the break isn't "left early"

      (prisma.attendance.findFirst as jest.Mock).mockResolvedValue({ ...back, id: 'att-2' });
      const out: any = await service.checkOut('outlet-1', rahul, {}, ist(17, '02:00'));
      expect(out.leftEarly).toBe(false);
    });

    it('8 PM–3 AM shift still clocked in, tapping clock-in at 1 AM: already clocked in', async () => {
      roster({ FRIDAY: { name: 'Late', startTime: '20:00', endTime: '03:00' }, SATURDAY: { name: 'Opening', startTime: '05:00', endTime: '13:00' } });
      const open = { id: 'att-1', employeeId: 'emp-rahul', date: DATE(16), checkInTime: ist(16, '20:00'), isLate: false };
      (prisma.attendance.findFirst as jest.Mock).mockResolvedValue(open);
      (prisma.attendance.findMany as jest.Mock).mockResolvedValue([open]);
      await expect(service.checkIn('outlet-1', rahul, {}, ist(17, '01:00'))).rejects.toMatchObject({ code: 'ALREADY_CHECKED_IN' });
      expect(prisma.attendance.update).not.toHaveBeenCalled();
    });

    it('forgot to clock out on Friday, clocking in Saturday 7:45 PM flags Friday as a missed clock-out', async () => {
      roster({ FRIDAY: { name: 'Evening', startTime: '18:00', endTime: '02:00' }, SATURDAY: { name: 'Late', startTime: '20:00', endTime: '03:00' } });
      const open = { id: 'att-1', employeeId: 'emp-rahul', date: DATE(16), checkInTime: ist(16, '17:50'), isLate: false };
      (prisma.attendance.findFirst as jest.Mock).mockResolvedValue(open);
      const result: any = await service.checkIn('outlet-1', rahul, {}, ist(17, '19:45'));
      expect(prisma.attendance.update).toHaveBeenCalledWith({ where: { id: 'att-1' }, data: { missedClockOut: true } });
      expect(result.date).toEqual(DATE(17));
      expect(result.isLate).toBe(false);
    });

    it('day shifts work as before: too early before the buffer, with the time in the message', async () => {
      roster({ FRIDAY: { name: 'Morning', startTime: '10:00', endTime: '18:00' } });
      await expect(service.checkIn('outlet-1', rahul, {}, ist(16, '09:00'))).rejects.toMatchObject({
        code: 'TOO_EARLY',
        message: expect.stringContaining('(at 9:30 AM)'),
      });
      const result: any = await service.checkIn('outlet-1', rahul, {}, ist(16, '10:20'));
      expect(result.isLate).toBe(true);
    });
  });

  describe('clock-out', () => {
    const open = { id: 'att-1', employeeId: 'emp-rahul', date: DATE(16), checkInTime: ist(16, '20:00'), isLate: false };

    beforeEach(() => {
      roster({ FRIDAY: { name: 'Late', startTime: '20:00', endTime: '03:00' } });
      (prisma.attendance.findFirst as jest.Mock).mockResolvedValue(open);
    });

    it('leaving at 2:50 AM from a shift ending at 3 AM is not leaving early', async () => {
      const result: any = await service.checkOut('outlet-1', rahul, {}, ist(17, '02:50'));
      expect(result.leftEarly).toBe(false);
    });

    it('leaving at 1 AM from a shift ending at 3 AM is leaving early', async () => {
      const result: any = await service.checkOut('outlet-1', rahul, {}, ist(17, '01:00'));
      expect(result.leftEarly).toBe(true);
    });
  });
});
