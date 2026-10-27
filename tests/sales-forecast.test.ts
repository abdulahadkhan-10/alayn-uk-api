import { DashboardService } from '../src/modules/analytics/dashboard.service';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    order: { findMany: jest.fn() },
    outlet: { findMany: jest.fn() },
    outletHoliday: { findMany: jest.fn() },
  },
}));

const DAY_MS = 24 * 60 * 60 * 1000;
// An instant from an India-time wall clock, `daysAgo` days before Tue 13 Oct 2026
const ist = (daysAgo: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 13, h, m) - 330 * 60 * 1000 - daysAgo * DAY_MS);
};

type FakeOrder = { outletId: string; status: string; createdAt: Date; subtotalPaise: number; deletedAt: null };

// Bandra (A): ₹500 at lunch + ₹500 just before midnight, every day → ₹1,000/day
// Juhu (B): a late-night outlet, ₹2,000 at 12:10 AM after each evening it opens. Days run 5 AM to 5 AM,
// so that sale belongs to the evening before. Closed on Sundays, holiday on Thu 15 Oct
const ORDERS: FakeOrder[] = [];
for (let daysAgo = 70; daysAgo >= 0; daysAgo--) {
  const order = (outletId: string, createdAt: Date, subtotalPaise: number) =>
    ORDERS.push({ outletId, status: 'COMPLETED', createdAt, subtotalPaise, deletedAt: null });
  order('A', ist(daysAgo, '12:00'), 50_000);
  if (daysAgo > 0) order('A', ist(daysAgo, '23:50'), 50_000); // tonight hasn't happened yet
  const openEvening = ist(daysAgo, '12:00').getUTCDay() !== 0;
  if (daysAgo > 0 && openEvening) order('B', new Date(ist(daysAgo, '00:10').getTime() + DAY_MS), 200_000); // next morning 12:10 AM
}
ORDERS.push({ outletId: 'A', status: 'CANCELLED', createdAt: ist(1, '13:00'), subtotalPaise: 9_999_900, deletedAt: null });

const OUTLETS = [
  { id: 'A', operatingDays: null },
  { id: 'B', operatingDays: JSON.stringify(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']) },
];

describe('Sales forecast endpoint', () => {
  const service = new DashboardService();
  const NOW = ist(0, '15:00');

  beforeEach(() => {
    (prisma.outlet.findMany as jest.Mock).mockImplementation(({ where }: any) =>
      where.id ? OUTLETS.filter((o) => o.id === where.id) : OUTLETS,
    );
    (prisma.order.findMany as jest.Mock).mockImplementation(({ where }: any) =>
      ORDERS.filter(
        (o) =>
          where.outletId.in.includes(o.outletId) &&
          o.status === where.status &&
          o.createdAt >= where.createdAt.gte &&
          o.createdAt <= where.createdAt.lte,
      ),
    );
    (prisma.outletHoliday.findMany as jest.Mock).mockResolvedValue([
      { outletId: 'B', date: new Date('2026-10-15T00:00:00.000Z') },
    ]);
  });

  it('forecasts all outlets together using India-time days, holidays and closed weekdays', async () => {
    const result = await service.getSalesForecast('all', 'biz-1', NOW);

    expect(result.status).toBe('ok');
    expect(result.coverage).toEqual({ forecasted: 2, total: 2 });
    expect(result.points).toHaveLength(7 + 1 + 7);

    const byDate = Object.fromEntries(result.points.map((p) => [p.date, p]));
    // Late-night and just-after-midnight orders land on the evening they belong to (business day)
    expect(byDate['2026-10-12']).toMatchObject({ actual: 3000, label: '12 Oct' }); // includes Tue 12:10 AM
    expect(byDate['2026-10-11']).toMatchObject({ actual: 1000 }); // Sunday: Juhu closed (no Mon 12:10 AM sale)
    expect(byDate['2026-10-13']).toMatchObject({ actual: 500, isToday: true, label: 'Today', projected: 3000 }); // tonight still to come

    expect(byDate['2026-10-14']).toMatchObject({ isFuture: true, actual: null, projected: 3000 });
    expect(byDate['2026-10-15'].projected).toBe(1000); // Juhu holiday
    expect(byDate['2026-10-18'].projected).toBe(1000); // Sunday
    expect(byDate['2026-10-14'].low!).toBeLessThan(3000);
    expect(byDate['2026-10-14'].high!).toBeGreaterThan(3000);

    expect(result.accuracy).toEqual({ mapePct: 0, daysEvaluated: 28 });
    expect(result.summary).toMatchObject({ next7DaysProjected: 3000 * 5 + 1000 * 2, last7DaysActual: 3000 * 6 + 1000 });
  });

  it('forecasts a single outlet and checks it belongs to the business', async () => {
    const result = await service.getSalesForecast('A', 'biz-1', NOW, { range: '30d', horizon: 3 });

    expect((prisma.outlet.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({ id: 'A', businessId: 'biz-1' });
    expect(result.points).toHaveLength(30 + 1 + 3);
    expect(result.points.filter((p) => p.isFuture).every((p) => p.projected === 1000)).toBe(true);
  });

  it('keeps learning instead of inventing numbers after a single test order', async () => {
    (prisma.order.findMany as jest.Mock).mockResolvedValue([
      { outletId: 'A', createdAt: ist(9, '12:00'), subtotalPaise: 71_000 },
    ]);
    const result = await service.getSalesForecast('A', 'biz-1', NOW);

    expect(result.status).toBe('learning');
    expect(result).toMatchObject({ salesDays: 1, earlyEstimateAfterDays: 3, fullForecastAfterDays: 14 });
    expect(result.points.every((p) => p.projected === null)).toBe(true);
    expect(result.summary).toBeNull();
    expect(result.accuracy).toBeNull();
  });

  it('gives a new café an early estimate from its third day of sales', async () => {
    (prisma.order.findMany as jest.Mock).mockResolvedValue(
      [0, 1, 2, 3, 4].map((d) => ({ outletId: 'A', createdAt: ist(d, '12:00'), subtotalPaise: 50_000 })),
    );
    const result = await service.getSalesForecast('A', 'biz-1', NOW);

    expect(result.status).toBe('early');
    expect(result.salesDays).toBe(4);
    expect(result.points.filter((p) => p.isFuture).every((p) => p.projected === 500)).toBe(true);
    expect(result.summary).toMatchObject({ next7DaysProjected: 3500, vsLast7DaysPct: null });
    expect(result.accuracy).toBeNull();
  });

  it('matches nothing when an "all outlets" request has no business', async () => {
    const result = await service.getSalesForecast('all', undefined, NOW);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(result.status).toBe('learning');
    expect(result.points).toHaveLength(15);
  });
});
