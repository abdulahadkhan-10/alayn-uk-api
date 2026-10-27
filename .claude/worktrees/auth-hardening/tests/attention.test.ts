import { getAttention } from '../src/modules/analytics/attention';
import { prisma } from '../src/config/prisma';
import { Prisma } from '@prisma/client';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    item: { findMany: jest.fn() },
    stockLedgerEntry: { groupBy: jest.fn(), findMany: jest.fn() },
    stockBatch: { findMany: jest.fn() },
    order: { findMany: jest.fn() },
    shiftAssignment: { findMany: jest.fn() },
    employeeRoster: { findMany: jest.fn() },
    attendance: { findMany: jest.fn() },
    leaveRequest: { findMany: jest.fn() },
  },
}));

// An instant from an India-time wall clock in Oct 2026
const ist = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60 * 1000);
};
const NOW = ist(16, '17:00'); // Fri 16 Oct, 5 PM
const dec = (n: number) => new Prisma.Decimal(n);
const outlet = { id: 'o1', name: 'Bandra' };

function quietDay() {
  (prisma.item.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.stockLedgerEntry.groupBy as jest.Mock).mockResolvedValue([]);
  (prisma.stockLedgerEntry.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.stockBatch.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.order.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.shiftAssignment.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.employeeRoster.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.attendance.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.leaveRequest.findMany as jest.Mock).mockResolvedValue([]);
}

describe('Needs attention (Overview)', () => {
  beforeEach(quietDay);

  it('is empty on a day with nothing to act on', async () => {
    expect(await getAttention('o1', 'biz-1', NOW)).toEqual([]);
  });

  it('lists every problem, most urgent first, with plain wording and a link to fix it', async () => {
    // Stock: milk below its reorder level (from the stock ledger, like the Inventory page)
    (prisma.item.findMany as jest.Mock).mockResolvedValue([
      { id: 'milk', name: 'Milk', unit: 'L', reorderThreshold: dec(5), outlet },
      { id: 'beans', name: 'Coffee beans', unit: 'kg', reorderThreshold: dec(2), outlet },
    ]);
    (prisma.stockLedgerEntry.groupBy as jest.Mock).mockResolvedValue([
      { itemId: 'milk', _sum: { change: dec(2.5) } },
      { itemId: 'beans', _sum: { change: dec(10) } },
    ]);
    (prisma.stockBatch.findMany as jest.Mock).mockResolvedValue([
      { quantity: dec(1), expiryDate: ist(15, '00:00'), item: { id: 'cream', name: 'Cream', unit: 'L' }, outlet },
      { quantity: dec(3), expiryDate: ist(17, '12:00'), item: { id: 'bread', name: 'Bread', unit: 'pcs' }, outlet },
    ]);
    // A bill opened at lunch and never settled
    (prisma.order.findMany as jest.Mock).mockResolvedValue([{ totalPaise: 47_300, createdAt: ist(16, '13:10') }]);
    // Head Waiter's shift started at 4 PM, no clock-in
    (prisma.employeeRoster.findMany as jest.Mock).mockResolvedValue([
      { employee: { id: 'e1', name: 'Head Waiter', role: 'STAFF', outlet }, shift: { name: 'Evening', startTime: '16:00', endTime: '00:00' } },
    ]);

    const items = await getAttention('o1', 'biz-1', NOW);
    expect(items.map((i) => [i.kind, i.severity, i.title, i.detail, i.href])).toEqual([
      ['expired_stock', 'high', '1 item expired but still in stock', 'Cream', '/inventory'],
      ['staff_not_in', 'high', '1 person not clocked in', 'Head Waiter (shift started 4 PM)', '/workforce'],
      ['stale_bills', 'medium', '1 bill open for over 2 hours', '₹473 not settled · oldest opened 1:10 PM', '/orders'],
      ['low_stock', 'medium', '1 item running low', 'Milk (2.5 L left)', '/inventory'],
      ['expiring_soon', 'medium', '1 item expiring in the next 3 days', 'Bread tomorrow', '/inventory'],
    ]);
  });

  it('only flags bills that have been open for over 2 hours (normal open orders show in Active Orders)', async () => {
    await getAttention('o1', 'biz-1', NOW);
    const where = (prisma.order.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.createdAt.lte).toEqual(ist(16, '15:00'));
    expect(where.status).toEqual({ notIn: ['COMPLETED', 'CANCELLED'] });
  });

  it('shortens long lists', async () => {
    (prisma.employeeRoster.findMany as jest.Mock).mockResolvedValue(
      ['A', 'B', 'C', 'D', 'E'].map((n) => ({
        employee: { id: n, name: n, role: 'STAFF', outlet },
        shift: { name: 'Morning', startTime: '08:00', endTime: '16:00' },
      })),
    );
    const [staff] = await getAttention('o1', 'biz-1', NOW);
    expect(staff.title).toBe('5 people not clocked in');
    expect(staff.detail).toBe('A (shift started 8 AM), B (shift started 8 AM), C (shift started 8 AM) and 2 more');
  });

  it('names the outlet in "All outlets" mode', async () => {
    (prisma.employeeRoster.findMany as jest.Mock).mockResolvedValue([
      { employee: { id: 'e1', name: 'Asha', role: 'STAFF', outlet }, shift: { name: 'Morning', startTime: '08:00', endTime: '16:00' } },
    ]);
    const [staff] = await getAttention('all', 'biz-1', NOW);
    expect(staff.detail).toBe('Asha (Bandra) (shift started 8 AM)');
  });

  it('matches nothing (instead of every business) when "All outlets" has no business', async () => {
    expect(await getAttention('all', undefined, NOW)).toEqual([]);
    expect(prisma.item.findMany).not.toHaveBeenCalled();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('warns about stock that will run out soon, from stock counts', async () => {
    (prisma.item.findMany as jest.Mock).mockResolvedValue([
      { id: 'milk', name: 'Milk', unit: 'L', reorderThreshold: dec(5), outlet }, // already low: listed there instead
      { id: 'beans', name: 'Coffee beans', unit: 'kg', reorderThreshold: dec(2), outlet },
      { id: 'sugar', name: 'Sugar', unit: 'kg', reorderThreshold: dec(1), outlet }, // counted, but not used
    ]);
    (prisma.stockLedgerEntry.groupBy as jest.Mock).mockResolvedValue([
      { itemId: 'milk', _sum: { change: dec(2.5) } },
      { itemId: 'beans', _sum: { change: dec(12) } },
      { itemId: 'sugar', _sum: { change: dec(10) } },
    ]);
    // Beans counted at 40 kg last Friday and 12 kg this morning: 4 kg a day
    const move = (itemId: string, change: number, at: Date) => ({ itemId, outletId: 'o1', change: dec(change), reason: 'COUNT', createdAt: at });
    (prisma.stockLedgerEntry.findMany as jest.Mock).mockResolvedValue([
      move('beans', 0, ist(9, '10:00')),
      move('sugar', 0, ist(9, '10:00')),
      move('beans', -28, ist(16, '10:00')),
      move('sugar', 0, ist(16, '10:00')),
    ]);

    const items = await getAttention('o1', 'biz-1', NOW);
    expect(items.find((i) => i.kind === 'runs_out_soon')).toEqual({
      kind: 'runs_out_soon',
      severity: 'medium',
      title: '1 item will run out in the next 3 days',
      detail: 'Coffee beans in ~2 days (Sun)',
      href: '/inventory',
    });
  });
});
