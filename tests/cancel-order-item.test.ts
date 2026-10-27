import { OrderService } from '../src/modules/orders/order.service';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => {
  const prismaMock: any = {
    order: { findFirst: jest.fn() },
    orderItem: { updateMany: jest.fn() },
    orderStatusHistory: { create: jest.fn() },
    orderItemRemoval: { create: jest.fn() },
  };
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock));
  return { prisma: prismaMock };
});

// Table 1: Chicken Chilly x2 already in the kitchen, Biryani x1
const chickenChilly = {
  id: 'item-chilly',
  quantity: 2,
  unitPricePaise: 24_000,
  status: 'PREPARING',
  menuItem: { name: 'Chicken Chilly' },
};
const biryani = {
  id: 'item-biryani',
  quantity: 1,
  unitPricePaise: 30_000,
  status: 'SENT_TO_KITCHEN',
  menuItem: { name: 'Dum Biryani' },
  modifiersJson: JSON.stringify([{ name: 'Half', isVariant: true }]),
};

const STAFF = { id: 'staff-user-1', name: 'Ravi', role: 'STAFF' };

const runningBill = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-1',
  orderNumber: 'CAF1',
  tableNumber: 1,
  outletId: 'outlet-1',
  status: 'PREPARING',
  items: [chickenChilly, biryani],
  payments: [],
  ...overrides,
});

describe('removing a wrongly punched item from a running bill', () => {
  const service = new OrderService();
  let recalculate: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(runningBill());
    (prisma.orderItem.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    recalculate = jest.spyOn(service, 'recalculateOrder').mockResolvedValue(undefined as any);
  });

  const remove = (itemId: string, qty?: number) =>
    service.cancelOrderItem('outlet-1', 'order-1', itemId, qty, 'Customer did not order', STAFF, 'biz-1');

  it('marks the whole item cancelled, keeps the kitchen stage it was in, and recalculates the bill', async () => {
    await remove('item-chilly');

    expect(prisma.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'item-chilly', quantity: 2, status: 'PREPARING' },
      data: expect.objectContaining({
        status: 'CANCELLED',
        cancelledQuantity: { increment: 2 },
        cancelledFromStatus: 'PREPARING',
        cancelledAt: expect.any(Date),
      }),
    });
    expect(recalculate).toHaveBeenCalledWith('order-1', prisma);
  });

  it('reduces the quantity and line total when only part of the item is removed', async () => {
    await remove('item-chilly', 1);

    expect(prisma.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'item-chilly', quantity: 2, status: 'PREPARING' },
      data: expect.objectContaining({
        quantity: 1,
        subtotalPaise: 24_000,
        cancelledQuantity: { increment: 1 },
      }),
    });
  });

  it('records who removed it and why in the order history', async () => {
    await remove('item-chilly', 1);

    expect(prisma.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        changedById: 'staff-user-1',
        comment: 'Removed 1x Chicken Chilly · Reason: Customer did not order',
      }),
    });
  });

  it('keeps a removal record with the item, value, stage, reason and who removed it, for the owner report', async () => {
    await remove('item-chilly', 1);

    expect(prisma.orderItemRemoval.create).toHaveBeenCalledWith({
      data: {
        orderId: 'order-1',
        orderItemId: 'item-chilly',
        outletId: 'outlet-1',
        itemName: 'Chicken Chilly',
        quantity: 1,
        amountPaise: 24_000,
        reason: 'Customer did not order',
        itemStage: 'PREPARING',
        removedById: 'staff-user-1',
        removedByName: 'Ravi',
        removedByRole: 'STAFF',
      },
    });
  });

  it('names the variant in the removal record', async () => {
    await remove('item-biryani');

    expect(prisma.orderItemRemoval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ itemName: 'Dum Biryani (Half)', amountPaise: 30_000 }),
    });
  });

  it('refuses once a payment has been taken, since the bill would drop below what was paid', async () => {
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(
      runningBill({ payments: [{ status: 'CONFIRMED', amountPaise: 78_000 }] })
    );

    await expect(remove('item-chilly')).rejects.toMatchObject({ code: 'ORDER_ALREADY_PAID' });
    expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
  });

  it('still allows removal while a payment is only pending (e.g. card at counter not yet swiped)', async () => {
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(
      runningBill({ payments: [{ status: 'PENDING', amountPaise: 78_000 }] })
    );

    await remove('item-chilly');

    expect(prisma.orderItem.updateMany).toHaveBeenCalled();
  });

  it('refuses on a settled or cancelled order', async () => {
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(runningBill({ status: 'COMPLETED' }));

    await expect(remove('item-chilly')).rejects.toMatchObject({ code: 'ORDER_FINALIZED' });
  });

  it('refuses to remove the last item on the bill (cancel the order instead)', async () => {
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(runningBill({ items: [biryani] }));

    await expect(remove('item-biryani')).rejects.toMatchObject({ code: 'CANNOT_EMPTY_ORDER' });
  });

  it('refuses an item that was already removed', async () => {
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(
      runningBill({ items: [{ ...chickenChilly, status: 'CANCELLED' }, biryani] })
    );

    await expect(remove('item-chilly')).rejects.toMatchObject({ code: 'ITEM_ALREADY_CANCELLED' });
  });

  it('refuses if another device changed the item first, without touching the bill', async () => {
    (prisma.orderItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await expect(remove('item-chilly', 1)).rejects.toMatchObject({ code: 'ITEM_CHANGED' });
    expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(prisma.orderItemRemoval.create).not.toHaveBeenCalled();
    expect(recalculate).not.toHaveBeenCalled();
  });
});
