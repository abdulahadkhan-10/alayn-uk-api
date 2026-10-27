import { buildRemovedItemsReport } from '../src/modules/reports/removals';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    orderItemRemoval: { findMany: jest.fn() },
    outlet: { findMany: jest.fn() },
  },
}));

const removal = (overrides: Record<string, unknown>) => ({
  id: 'r',
  orderId: 'order-1',
  outletId: 'outlet-1',
  itemName: 'Chicken Chilly',
  quantity: 1,
  amountPaise: 24_000,
  reason: 'Customer didn\'t order (wrongly punched)',
  itemStage: 'PREPARING',
  removedById: 'ravi',
  removedByName: 'Ravi',
  removedByRole: 'STAFF',
  createdAt: new Date('2026-10-22T08:00:00Z'),
  order: { orderNumber: 'CAF1', tableNumber: 1 },
  ...overrides,
});

describe('removed items report', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const request = { preset: 'TODAY', compare: 'NONE', filters: {} } as any;

  beforeEach(() => {
    (prisma.outlet.findMany as jest.Mock).mockResolvedValue([{ id: 'outlet-1', name: 'Bandra' }]);
    (prisma.orderItemRemoval.findMany as jest.Mock).mockResolvedValue([
      removal({ id: 'r1' }),
      removal({ id: 'r2', itemName: 'Dum Biryani (Half)', quantity: 2, amountPaise: 60_000, itemStage: 'SERVED', reason: 'Other reason: customer refused to pay' }),
      removal({ id: 'r3', removedById: 'asha', removedByName: 'Asha', removedByRole: 'MANAGER', reason: 'Customer didn\'t order (wrongly punched): table 4 not 1' }),
    ]);
  });

  it('only reads removals from the outlets the caller may see, within the period', async () => {
    await buildRemovedItemsReport(request, ['outlet-1'], now);

    expect(prisma.orderItemRemoval.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          outletId: { in: ['outlet-1'] },
          createdAt: { gte: expect.any(Date), lte: expect.any(Date) },
        }),
      })
    );
  });

  it('totals the removals and singles out food removed after it was served', async () => {
    const report = await buildRemovedItemsReport(request, ['outlet-1'], now);

    expect(report.totals).toEqual({
      removals: 3,
      quantity: 4,
      amountPaise: 108_000,
      afterServedRemovals: 1,
      afterServedPaise: 60_000,
    });
  });

  it('groups by person, highest value first', async () => {
    const report = await buildRemovedItemsReport(request, ['outlet-1'], now);

    expect(report.byPerson).toEqual([
      { key: 'ravi', name: 'Ravi', role: 'STAFF', removals: 2, quantity: 3, amountPaise: 84_000 },
      { key: 'asha', name: 'Asha', role: 'MANAGER', removals: 1, quantity: 1, amountPaise: 24_000 },
    ]);
  });

  it('groups reasons by their preset, ignoring the extra detail typed after it', async () => {
    const report = await buildRemovedItemsReport(request, ['outlet-1'], now);

    expect(report.byReason).toEqual([
      { reason: 'Other reason', removals: 1, quantity: 2, amountPaise: 60_000 },
      { reason: 'Customer didn\'t order (wrongly punched)', removals: 2, quantity: 2, amountPaise: 48_000 },
    ]);
  });

  it('lists each removal with its order, table and outlet', async () => {
    const report = await buildRemovedItemsReport(request, ['outlet-1'], now);

    expect(report.rows[1]).toMatchObject({
      orderNumber: 'CAF1',
      tableNumber: 1,
      outletName: 'Bandra',
      itemName: 'Dum Biryani (Half)',
      itemStage: 'SERVED',
      removedByName: 'Ravi',
    });
    expect(report.truncated).toBe(false);
  });
});
