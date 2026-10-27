import { DashboardService } from '../src/modules/analytics/dashboard.service';
import { clock12 } from '../src/modules/analytics/staffToday';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    shiftAssignment: { findMany: jest.fn() },
    employeeRoster: { findMany: jest.fn() },
    attendance: { findMany: jest.fn() },
    leaveRequest: { findMany: jest.fn() },
  },
}));

// An instant from an India-time wall clock on Fri 16 Oct 2026
const ist = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 16, h, m) - 330 * 60 * 1000);
};
const emp = (id: string, name: string, role: string) => ({ id, name, role, outlet: { name: 'Bandra' } });
const MORNING = { name: 'Morning', startTime: '08:00', endTime: '16:00' };
const EVENING = { name: 'Evening', startTime: '16:00', endTime: '00:00' };

describe('Who is working today (Shift Coverage card)', () => {
  const service = new DashboardService();

  beforeEach(() => {
    (prisma.shiftAssignment.findMany as jest.Mock).mockResolvedValue([]); // no date-specific changes
    (prisma.employeeRoster.findMany as jest.Mock).mockResolvedValue([
      { employee: emp('a', 'Asha', 'MANAGER'), shift: MORNING },
      { employee: emp('b', 'Bilal', 'KITCHEN'), shift: EVENING },
      { employee: emp('c', 'Chetan', 'STAFF'), shift: null }, // weekly off
      { employee: emp('d', 'Divya', 'STAFF'), shift: MORNING }, // on leave
      { employee: emp('f', 'Farah', 'KITCHEN'), shift: MORNING }, // didn't turn up
    ]);
    (prisma.attendance.findMany as jest.Mock).mockResolvedValue([
      { employee: emp('a', 'Asha', 'MANAGER'), checkInTime: ist('08:12'), checkOutTime: null, isLate: true },
      // Covered a shift without being rostered
      { employee: emp('e', 'Esha', 'STAFF'), checkInTime: ist('07:00'), checkOutTime: ist('11:30'), isLate: false },
    ]);
    (prisma.leaveRequest.findMany as jest.Mock).mockResolvedValue([{ employee: emp('d', 'Divya', 'STAFF') }]);
  });

  it('shows real shift times and clock-ins, most urgent first', async () => {
    const result = await service.getStaffToday('outlet-1', 'biz-1', ist('13:00'));

    expect(result.rosterSource).toBe('weekly');
    expect(result.staff.map((s) => [s.name, s.statusLabel, s.shiftLabel])).toEqual([
      ['Farah', 'Not clocked in', 'Morning · 8 AM–4 PM'],
      ['Asha', 'In since 8:12 AM (late)', 'Morning · 8 AM–4 PM'],
      ['Bilal', 'Starts 4 PM', 'Evening · 4 PM–12 AM'],
      ['Esha', 'Left at 11:30 AM', null],
      ['Divya', 'On leave', 'Morning · 8 AM–4 PM'],
      ['Chetan', 'Off today', null],
    ]);
    expect(result.summary).toEqual({ working: 5, in: 1, notIn: 1, onLeave: 1 });
  });

  it('uses date-specific assignments instead of the weekly roster when there are any', async () => {
    (prisma.shiftAssignment.findMany as jest.Mock).mockResolvedValue([{ employee: emp('b', 'Bilal', 'KITCHEN'), shift: MORNING }]);
    (prisma.attendance.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.leaveRequest.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.getStaffToday('outlet-1', 'biz-1', ist('07:00'));
    expect(prisma.employeeRoster.findMany).not.toHaveBeenCalled();
    expect(result.rosterSource).toBe('assignments');
    expect(result.staff).toEqual([expect.objectContaining({ name: 'Bilal', statusLabel: 'Starts 8 AM' })]);
  });

  it('says so when no roster is set up', async () => {
    (prisma.employeeRoster.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.attendance.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.leaveRequest.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.getStaffToday('outlet-1', 'biz-1', ist('13:00'));
    expect(result.rosterSource).toBe('none');
    expect(result.staff).toEqual([]);
  });

  it('formats 24-hour shift times as 12-hour', () => {
    expect([clock12('00:00'), clock12('09:30'), clock12('12:00'), clock12('16:00'), clock12('23:45')]).toEqual([
      '12 AM', '9:30 AM', '12 PM', '4 PM', '11:45 PM',
    ]);
  });
});
