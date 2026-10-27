import { itemOutlook, LedgerMove } from '../src/modules/analytics/runOut';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { prisma } from '../src/config/prisma';
import { Prisma } from '@prisma/client';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    item: { findMany: jest.fn() },
    stockLedgerEntry: { groupBy: jest.fn(), create: jest.fn((args) => args) },
    $transaction: jest.fn((ops) => Promise.resolve(ops)),
  },
}));

const day = (d: number, h = 22) => new Date(Date.UTC(2026, 9, d, h) - 330 * 60 * 1000); // India time, Oct 2026
const move = (change: number, reason: LedgerMove['reason'], at: Date): LedgerMove => ({ itemId: 'onion', outletId: 'o1', change, reason, createdAt: at });

describe('Stock use from counts', () => {
  it('works out use as first count + purchases − second count', () => {
    // Counted 20 kg Monday night, bought 30 kg Wednesday, counted 8 kg the next Monday: 42 kg in 7 days
    const moves = [move(0, 'COUNT', day(5)), move(30, 'PURCHASE', day(7, 11)), move(-42, 'COUNT', day(12))];
    const outlook = itemOutlook(moves, 8, day(12))!;
    expect(outlook.dailyUse).toBeCloseTo(6);
    expect(outlook.estimatedStock).toBeCloseTo(8);
    expect(outlook.daysLeft).toBeCloseTo(8 / 6);
  });

  it('takes off the usual daily use since the last count', () => {
    const moves = [move(0, 'COUNT', day(5)), move(30, 'PURCHASE', day(7, 11)), move(-42, 'COUNT', day(12))];
    const outlook = itemOutlook(moves, 8, day(13))!; // a day after the count, nothing recorded since
    expect(outlook.estimatedStock).toBeCloseTo(2);
  });

  it('needs counts at least a day apart', () => {
    const moves = [move(0, 'COUNT', day(12, 9)), move(-2, 'COUNT', day(12, 21))];
    expect(itemOutlook(moves, 8, day(12))).toBeNull();
  });

  it('predicts nothing before an item has been counted (logged waste alone is not use)', () => {
    const moves = [move(10, 'PURCHASE', day(1)), move(-3, 'WASTE', day(11))];
    expect(itemOutlook(moves, 7, day(12))).toBeNull();
  });

  it('takes off waste logged since the last count when it is more than the usual use', () => {
    const moves = [move(0, 'COUNT', day(5)), move(30, 'PURCHASE', day(7, 11)), move(-42, 'COUNT', day(12)), move(-5, 'WASTE', day(12, 23))];
    const outlook = itemOutlook(moves, 3, day(12, 23))!; // an hour after the count, 5 kg thrown away
    expect(outlook.estimatedStock).toBeCloseTo(3);
  });

  it('has nothing to predict for an item that is not being used', () => {
    expect(itemOutlook([move(10, 'PURCHASE', day(1))], 10, day(12))).toBeNull();
  });
});

describe('Saving a stock count', () => {
  const service = new InventoryService();

  beforeEach(() => {
    (prisma.item.findMany as jest.Mock).mockResolvedValue([
      { id: 'onion', name: 'Onions', unit: 'kg', outletId: 'o1' },
      { id: 'oil', name: 'Oil', unit: 'L', outletId: 'o1' },
    ]);
    (prisma.stockLedgerEntry.groupBy as jest.Mock).mockResolvedValue([
      { itemId: 'onion', _sum: { change: new Prisma.Decimal(14) } },
      { itemId: 'oil', _sum: { change: new Prisma.Decimal(5) } },
    ]);
  });

  it('sets each item to what was counted, and records unchanged items too', async () => {
    const result = await service.recordCount('o1', [{ itemId: 'onion', counted: 8 }, { itemId: 'oil', counted: 5 }], 'biz-1');

    const created = (prisma.stockLedgerEntry.create as jest.Mock).mock.calls.map(([args]) => args.data);
    expect(created.map((d) => [d.itemId, d.change.toNumber(), d.reason])).toEqual([
      ['onion', -6, 'COUNT'],
      ['oil', 0, 'COUNT'],
    ]);
    expect(result.items.map((i) => [i.name, i.expected, i.counted, i.difference])).toEqual([
      ['Onions', 14, 8, -6],
      ['Oil', 5, 5, 0],
    ]);
  });

  it('only counts items of this branch', async () => {
    (prisma.item.findMany as jest.Mock).mockResolvedValue([{ id: 'onion', name: 'Onions', unit: 'kg', outletId: 'o1' }]);
    await expect(service.recordCount('o1', [{ itemId: 'onion', counted: 8 }, { itemId: 'other', counted: 1 }], 'biz-1')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect((prisma.item.findMany as jest.Mock).mock.calls.at(-1)[0].where).toMatchObject({ outletId: 'o1' });
  });
});
