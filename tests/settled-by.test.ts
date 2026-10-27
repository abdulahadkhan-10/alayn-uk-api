import { OrderService } from '../src/modules/orders/order.service';
import { OrderRepository } from '../src/modules/orders/order.repository';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => ({
  prisma: { user: { findMany: jest.fn() } },
}));

describe('the cashier printed on a bill', () => {
  const service = new OrderService();

  afterEach(() => jest.restoreAllMocks());

  it('is the staff member who settled it, not who placed the order', async () => {
    jest.spyOn(OrderRepository.prototype, 'findOrders').mockResolvedValue([
      {
        id: 'qr-bill',
        placedByName: 'Customer (QR)',
        statusHistory: [
          { status: 'SENT_TO_KITCHEN', changedById: null },
          { status: 'COMPLETED', changedById: 'cashier-1' },
        ],
      },
      { id: 'open-bill', placedByName: 'Customer (QR)', statusHistory: [{ status: 'SENT_TO_KITCHEN', changedById: null }] },
    ] as any);
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 'cashier-1', name: 'Priya' }]);

    const [settled, open] = await service.getOrders('outlet-1');

    expect(settled.settledByName).toBe('Priya');
    expect(settled.placedByName).toBe('Customer (QR)');
    expect(open.settledByName).toBeNull();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });

  it('skips the lookup when nothing on the page is settled', async () => {
    jest.spyOn(OrderRepository.prototype, 'findOrders').mockResolvedValue([{ id: 'open', statusHistory: [] }] as any);

    const [open] = await service.getOrders('outlet-1');

    expect(open.settledByName).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
