import { flagStaffing, rosteredStaffByDate } from '../src/modules/analytics/staffingWeek';
import { prisma } from '../src/config/prisma';
import { NO_MATCH_UUID } from '../src/utils/tenantScope';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    shiftAssignment: { findMany: jest.fn() },
    employeeRoster: { findMany: jest.fn() },
    leaveRequest: { findMany: jest.fn() },
  },
}));

const day = (date: string, forecast: number | null, staff: number, closed = false) => ({
  date,
  weekday: new Date(`${date}T00:00:00Z`).getUTCDay(),
  forecast,
  closed,
  staff,
});

describe('Week-ahead staffing flags', () => {
  it('flags a busy day with ordinary staff, and a quiet day with extra staff', () => {
    const result = flagStaffing([
      day('2026-10-17', 1000, 4),
      day('2026-10-18', 2000, 4), // forecast nearly 2× the average, same 4 people
      day('2026-10-19', 1000, 4),
      day('2026-10-20', 500, 6), // quiet, but the most people rostered
      day('2026-10-21', 1000, 4),
      day('2026-10-22', 1000, 4),
      day('2026-10-23', 1000, 4),
    ]);
    expect(result.map((d) => d.flag)).toEqual([null, 'understaffed', null, 'overstaffed', null, null, null]);
    expect(result[1].salesPerStaff).toBe(500);
  });

  it('does not flag closed days or days without a forecast', () => {
    const result = flagStaffing([
      day('2026-10-17', 1000, 4),
      day('2026-10-18', 1000, 4),
      day('2026-10-19', 1000, 4),
      day('2026-10-20', null, 0),
      day('2026-10-21', 0, 0, true),
    ]);
    expect(result.every((d) => d.flag === null)).toBe(true);
    expect(result[3].salesPerStaff).toBeNull();
  });

  it('needs at least 3 forecast days to compare against', () => {
    const result = flagStaffing([day('2026-10-17', 1000, 4), day('2026-10-18', 3000, 2)]);
    expect(result.every((d) => d.flag === null)).toBe(true);
  });
});

describe('People rostered per date', () => {
  const dates = [
    { date: '2026-10-17', weekday: 6 }, // Saturday
    { date: '2026-10-18', weekday: 0 }, // Sunday
  ];

  beforeEach(() => {
    (prisma.employeeRoster.findMany as jest.Mock).mockResolvedValue([
      { dayOfWeek: 'SATURDAY', employeeId: 'a' },
      { dayOfWeek: 'SATURDAY', employeeId: 'b' },
      { dayOfWeek: 'SATURDAY', employeeId: 'c' },
      { dayOfWeek: 'SUNDAY', employeeId: 'a' },
    ]);
    // Sunday has date-specific assignments, which replace the weekly roster for that day
    (prisma.shiftAssignment.findMany as jest.Mock).mockResolvedValue([
      { date: new Date('2026-10-18T00:00:00Z'), employeeId: 'b' },
      { date: new Date('2026-10-18T00:00:00Z'), employeeId: 'd' },
    ]);
    (prisma.leaveRequest.findMany as jest.Mock).mockResolvedValue([
      { employeeId: 'c', startDate: new Date('2026-10-17T00:00:00Z'), endDate: new Date('2026-10-17T00:00:00Z') },
    ]);
  });

  it('uses the weekly roster, date-specific changes and approved leave', async () => {
    const staff = await rosteredStaffByDate('outlet-1', 'biz-1', dates);
    expect(staff.get('2026-10-17')).toBe(2); // a, b (c on leave)
    expect(staff.get('2026-10-18')).toBe(2); // b, d instead of a
  });

  it("matches nothing for a caller without a business in all-outlets mode", async () => {
    await rosteredStaffByDate('all', undefined, dates);
    const where = (prisma.employeeRoster.findMany as jest.Mock).mock.calls.at(-1)[0].where;
    expect(where.outlet).toEqual({ businessId: NO_MATCH_UUID });
  });
});
