import { DashboardService } from '../src/modules/analytics/dashboard.service';
import { prisma } from '../src/config/prisma';
import { outletDateKey, outletStartOfDay } from '../src/utils/outletTime';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    order: { findMany: jest.fn(), groupBy: jest.fn() },
    orderItem: { findMany: jest.fn() },
    wasteLog: { findMany: jest.fn() },
    employee: { count: jest.fn() },
  },
}));

// Helper: an instant from an India-time wall clock on Oct 2026
const ist = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60 * 1000);
};

type FakeOrder = { id: string; status: string; createdAt: Date; subtotalPaise: number; taxPaise: number; totalPaise: number; discountPaise?: number; cgstPaise?: number; sgstPaise?: number; serviceTaxPaise?: number };

// Brew Bay Bandra — Saturday 10 Oct 2026
const RAW_ORDERS: FakeOrder[] = [
  // Settled lunch & dinner: ₹20,000 food + ₹1,000 GST
  { id: 'o1', status: 'COMPLETED', createdAt: ist(10, '13:00'), subtotalPaise: 1_000_000, taxPaise: 50_000, totalPaise: 1_050_000 },
  { id: 'o2', status: 'COMPLETED', createdAt: ist(10, '20:00'), subtotalPaise: 1_000_000, taxPaise: 50_000, totalPaise: 1_050_000 },
  // Still eating, unpaid
  { id: 'o3', status: 'SERVED', createdAt: ist(10, '22:30'), subtotalPaise: 285_714, taxPaise: 14_286, totalPaise: 300_000 },
  // Cancelled — never counts
  { id: 'o4', status: 'CANCELLED', createdAt: ist(10, '21:00'), subtotalPaise: 500_000, taxPaise: 25_000, totalPaise: 525_000 },
  // Friday (previous period for "today")
  { id: 'o5', status: 'COMPLETED', createdAt: ist(9, '19:00'), subtotalPaise: 1_600_000, taxPaise: 80_000, totalPaise: 1_680_000 },
];

const ORDERS: FakeOrder[] = RAW_ORDERS.map((o) => ({
  discountPaise: 0,
  serviceTaxPaise: 0,
  cgstPaise: o.taxPaise / 2,
  sgstPaise: o.taxPaise / 2,
  ...o,
}));

// Minimal in-memory version of the Prisma filters the dashboard uses
function matches(order: FakeOrder, where: any) {
  if (typeof where.status === 'string' && order.status !== where.status) return false;
  if (where.status?.notIn && where.status.notIn.includes(order.status)) return false;
  if (where.createdAt?.gte && order.createdAt < where.createdAt.gte) return false;
  if (where.createdAt?.lte && order.createdAt > where.createdAt.lte) return false;
  if (where.id?.in && !where.id.in.includes(order.id)) return false;
  return true;
}

describe('Dashboard numbers', () => {
  const service = new DashboardService();
  const SAT_11PM = ist(10, '23:00');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: SAT_11PM, doNotFake: ['nextTick', 'setImmediate'] });
    (prisma.order.findMany as jest.Mock).mockImplementation(({ where }: any) => ORDERS.filter((o) => matches(o, where)));
    (prisma.orderItem.findMany as jest.Mock).mockResolvedValue([]); // no recipes set up
    (prisma.wasteLog.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.employee.count as jest.Mock).mockResolvedValue(5);
  });

  afterEach(() => jest.useRealTimers());

  describe('16a/16b — revenue is settled sales before tax', () => {
    it("counts only settled orders' subtotals, and reports GST and open bills separately", async () => {
      const kpis: any = await service.getKpis('outlet-1', 'biz-1', 'TODAY');

      expect(kpis.totalRevenue.value).toBe('₹20,000'); // not ₹21,000 (GST) or ₹24,000 (+ open bills)
      expect(kpis.taxCollected.value).toBe('₹1,000');
      expect(kpis.openBills).toEqual({ value: '₹3,000', count: 1 });
      expect(kpis.avgOrderValue.value).toBe('₹10,000');
    });

    it('today at 11 PM compares with yesterday up to 11 PM', async () => {
      const kpis: any = await service.getKpis('outlet-1', 'biz-1', 'TODAY');
      expect(kpis.totalRevenue.prev).toBe('₹16,000');
      expect(kpis.totalRevenue.change).toBe('+25.0%');
    });

    const withExtra = (extra: Array<{ id: string; createdAt: Date; subtotalPaise: number }>) => {
      const made: FakeOrder[] = extra.map((e) => ({
        status: 'COMPLETED', taxPaise: 0, totalPaise: e.subtotalPaise, discountPaise: 0, serviceTaxPaise: 0, cgstPaise: 0, sgstPaise: 0, ...e,
      }));
      (prisma.order.findMany as jest.Mock).mockImplementation(({ where }: any) =>
        [...ORDERS, ...made].filter((o) => matches(o, where)),
      );
    };

    it('today in the morning compares with yesterday up to the same time', async () => {
      jest.setSystemTime(ist(10, '10:00'));
      withExtra([{ id: 'x1', createdAt: ist(9, '09:00'), subtotalPaise: 500_000 }]);
      const kpis: any = await service.getKpis('outlet-1', 'biz-1', 'TODAY');
      expect(kpis.totalRevenue.prev).toBe('₹5,000'); // not Friday's 7 PM ₹16,000
      expect(kpis.comparison.label).toBe('vs yesterday, same time');
    });

    it('this month compares with the same dates last month', async () => {
      withExtra([
        { id: 'x2', createdAt: new Date(Date.UTC(2026, 8, 5, 6, 30)), subtotalPaise: 100_000 },
        { id: 'x3', createdAt: new Date(Date.UTC(2026, 8, 25, 6, 30)), subtotalPaise: 900_000 },
      ]);
      const kpis: any = await service.getKpis('outlet-1', 'biz-1', 'THIS_MONTH');
      expect(kpis.totalRevenue.prev).toBe('₹1,000');
      expect(kpis.comparison).toMatchObject({ current: expect.any(String), previous: expect.any(String) });
    });

    it('7 days covers today and the 6 days before', async () => {
      withExtra([
        { id: 'x4', createdAt: ist(3, '12:00'), subtotalPaise: 700_000 },
        { id: 'x5', createdAt: ist(4, '12:00'), subtotalPaise: 300_000 },
      ]);
      const kpis: any = await service.getKpis('outlet-1', 'biz-1', '7_DAY');
      expect(kpis.totalRevenue.value).toBe('₹39,000'); // 20,000 today + 16,000 Fri + 3,000 on 4 Oct; the 3 Oct order is out
    });

    it('counts settled orders and compares them with the previous period', async () => {
      const kpis: any = await service.getKpis('outlet-1', 'biz-1', 'TODAY');
      expect(kpis.orders).toEqual({ value: '2', prev: '1', change: '+100.0%', isPositive: true });
    });

    it('shows no percentage (not a fake "+100%") when there is nothing earlier to compare with', async () => {
      // A new café: Saturday's sales, nothing on Friday
      (prisma.order.findMany as jest.Mock).mockImplementation(({ where }: any) =>
        ORDERS.filter((o) => o.id !== 'o5').filter((o) => matches(o, where)),
      );
      const kpis: any = await service.getKpis('outlet-1', 'biz-1', 'TODAY');
      expect(kpis.totalRevenue).toMatchObject({ value: '₹20,000', prev: '₹0', change: '' });
      expect(kpis.avgOrderValue.change).toBe('');
    });
  });

  describe('16c — "today" is India time', () => {
    it('at 2 AM Sunday, "today" is still Saturday night: the business day started at 5 AM Saturday', async () => {
      jest.setSystemTime(ist(11, '02:00'));
      await service.getKpis('outlet-1', 'biz-1', 'TODAY');
      const firstQuery = (prisma.order.findMany as jest.Mock).mock.calls[0][0];
      expect(firstQuery.where.createdAt.gte).toEqual(ist(10, '05:00'));
    });

    it('at 6 AM Sunday a new day has started at 5 AM India time (not 5:30 AM UTC midnight)', async () => {
      jest.setSystemTime(ist(11, '06:00'));
      await service.getKpis('outlet-1', 'biz-1', 'TODAY');
      const firstQuery = (prisma.order.findMany as jest.Mock).mock.calls[0][0];
      expect(firstQuery.where.createdAt.gte).toEqual(ist(11, '05:00'));
    });

    it('"this month" starts at 5 AM India time on the 1st', async () => {
      await service.getKpis('outlet-1', 'biz-1', 'THIS_MONTH');
      const firstQuery = (prisma.order.findMany as jest.Mock).mock.calls[0][0];
      expect(firstQuery.where.createdAt.gte).toEqual(ist(1, '05:00'));
    });

    it('order numbers use the India-time date', () => {
      // 12:30 AM India time on Sunday 11 Oct is still Saturday in UTC
      expect(outletDateKey(ist(11, '00:30'))).toBe('20261011');
      expect(outletStartOfDay(ist(11, '00:30'))).toEqual(ist(11, '00:00'));
    });
  });

  describe('16d — sales by time of day uses India hours', () => {
    it('puts a 1 PM lunch in "12 PM" and an 8 PM dinner in "8 PM"', async () => {
      const chart: any[] = await service.getSalesVelocity('outlet-1', 'biz-1', 'TODAY');
      const byTime = Object.fromEntries(chart.map((p) => [p.time, p.revenue]));
      expect(byTime['12 PM']).toBe(10_000);
      expect(byTime['8 PM']).toBe(10_000);
      // Trimmed to the trading span (12 PM – 8 PM), not padded with empty night hours
      expect(chart[0].time).toBe('12 PM');
      expect(chart[chart.length - 1].time).toBe('8 PM');
    });

    it('lists the business day from the 4 AM bucket, so late-night sales come last', async () => {
      (prisma.order.findMany as jest.Mock).mockResolvedValue([
        { createdAt: ist(10, '12:30'), subtotalPaise: 1_000_00 },
        { createdAt: ist(11, '01:15'), subtotalPaise: 500_00 }, // a sale after midnight, still the same business day
      ]);
      const chart: any[] = await service.getSalesVelocity('outlet-1', 'biz-1', 'TODAY');
      expect(chart.map((p) => p.time)).toEqual(['12 PM', '2 PM', '4 PM', '6 PM', '8 PM', '10 PM', '12 AM']);
      expect(chart[chart.length - 1].revenue).toBe(500);
    });

    it('shows 10 AM – 10 PM when there are no sales', async () => {
      (prisma.order.findMany as jest.Mock).mockResolvedValue([]);
      const chart: any[] = await service.getSalesVelocity('outlet-1', 'biz-1', 'TODAY');
      expect(chart.map((p) => p.time)).toEqual(['10 AM', '12 PM', '2 PM', '4 PM', '6 PM', '8 PM', '10 PM']);
    });
  });

  describe('16e — waste instead of margin', () => {
    it('shows no food cost or margin (menu items are not linked to stock)', async () => {
      const kpis: any = await service.getKpis('outlet-1', 'biz-1', 'TODAY');
      expect(kpis.netMargin).toBeUndefined();
      expect(kpis.grossProfit).toBeUndefined();
    });

    it('shows the stock logged as wasted, where less is better', async () => {
      // ₹250 of waste today, ₹400 in the comparison period
      (prisma.wasteLog.findMany as jest.Mock).mockImplementation(({ where }: any) =>
        where.createdAt.gte >= ist(10, '00:00') ? [{ costAtLoggingPaise: 25_000 }] : [{ costAtLoggingPaise: 40_000 }]
      );
      const kpis: any = await service.getKpis('outlet-1', 'biz-1', 'TODAY');
      expect(kpis.waste).toMatchObject({ value: '₹250', prev: '₹400', change: '-37.5%', isPositive: true });
    });
  });

  it('matches nothing (instead of every business) when "all outlets" has no business', async () => {
    await service.getKpis('all', undefined, 'TODAY');
    const firstQuery = (prisma.order.findMany as jest.Mock).mock.calls[0][0];
    expect(firstQuery.where.id).toEqual({ in: [] });
  });
});
