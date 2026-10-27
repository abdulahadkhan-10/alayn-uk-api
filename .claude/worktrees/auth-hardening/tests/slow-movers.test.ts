import { DashboardService } from '../src/modules/analytics/dashboard.service';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    menuItem: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
  },
}));

// An instant from an India-time wall clock in Oct 2026
const ist = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60 * 1000);
};
const NOW = ist(17, '15:00');

describe('Slow movers (Overview)', () => {
  const service = new DashboardService();

  beforeEach(() => {
    (prisma.menuItem.findMany as jest.Mock).mockResolvedValue([
      { id: 'a', name: 'Paneer Wrap', pricePaise: 18_000, category: { name: 'Wraps' } },
      { id: 'b', name: 'Mango Lassi', pricePaise: 9_000, category: { name: 'Drinks' } },
      { id: 'c', name: 'Cold Coffee', pricePaise: 12_000, category: null },
    ]);
    (prisma.orderItem.findMany as jest.Mock).mockResolvedValue([
      { menuItemId: 'a', order: { createdAt: ist(1, '20:00') } },
      { menuItemId: 'c', order: { createdAt: ist(2, '13:00') } },
    ]);
  });

  it('lists active dishes with no sales in 14 days, never-sold and longest-unsold first', async () => {
    const result = await service.getSlowMovers('outlet-1', 'biz-1', NOW);
    expect(result.days).toBe(14);
    expect(result.items.map((i) => [i.name, i.lastSoldDaysAgo, i.price, i.category])).toEqual([
      ['Mango Lassi', null, 90, 'Drinks'],
      ['Paneer Wrap', 16, 180, 'Wraps'],
      ['Cold Coffee', 15, 120, 'General'],
    ]);
  });

  it('leaves out dishes added in the last 14 days and only counts settled sales of this outlet', async () => {
    await service.getSlowMovers('outlet-1', 'biz-1', NOW);
    const where = (prisma.menuItem.findMany as jest.Mock).mock.calls.at(-1)[0].where;
    expect(where.createdAt.lt).toEqual(ist(3, '00:00'));
    expect(where.orderItems.none.order).toMatchObject({ outletId: 'outlet-1', status: 'COMPLETED' });
  });
});
