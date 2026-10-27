import { OrderRepository } from '../src/modules/orders/order.repository';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => ({ prisma: { order: { findMany: jest.fn() } } }));

// An instant from an India-time wall clock in Oct 2026
const ist = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60 * 1000);
};

describe('Orders page date filter', () => {
  const repo = new OrderRepository();
  const where = () => (prisma.order.findMany as jest.Mock).mock.calls[0][0].where;

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.order.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('uses business days, 5 AM to 5 AM India time, like reports', async () => {
    await repo.findOrders('o1', 'ALL', { startDate: '2026-10-16', endDate: '2026-10-17' });
    expect(where().createdAt).toEqual({
      gte: ist(16, '05:00'),
      lte: new Date(ist(18, '05:00').getTime() - 1), // Saturday night's 2 AM orders are included
    });
  });

  it('a single day covers that night after midnight too', async () => {
    await repo.findOrders('o1', 'ALL', { startDate: '2026-10-16', endDate: '2026-10-16' });
    const { gte, lte } = where().createdAt;
    expect(ist(17, '01:30').getTime()).toBeGreaterThanOrEqual(gte.getTime());
    expect(ist(17, '01:30').getTime()).toBeLessThanOrEqual(lte.getTime());
    expect(ist(16, '04:30').getTime()).toBeLessThan(gte.getTime()); // Thursday night
  });

  it('works with only one end of the range', async () => {
    await repo.findOrders('o1', 'ALL', { endDate: '2026-10-16' });
    expect(where().createdAt).toEqual({ lte: new Date(ist(17, '05:00').getTime() - 1) });
  });
});
