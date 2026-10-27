import { Prisma } from '@prisma/client';
import { OrderService } from '../src/modules/orders/order.service';
import { OrderRepository } from '../src/modules/orders/order.repository';
import { createOrderSchema } from '../src/modules/orders/order.schema';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => {
  const prismaMock: any = {
    outlet: { findFirst: jest.fn(), findUnique: jest.fn() },
    tableToken: { findUnique: jest.fn() },
    menuItem: { findFirst: jest.fn() },
    order: { findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn().mockResolvedValue(0), update: jest.fn() },
    payment: { create: jest.fn() },
    table: { updateMany: jest.fn() },
    restaurantCoupon: { update: jest.fn(), updateMany: jest.fn() },
  };
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock));
  return { prisma: prismaMock };
});
jest.mock('../src/modules/notifications/notification.service', () => ({
  NotificationService: { notifyOrderPlaced: jest.fn().mockResolvedValue(undefined) },
}));

const dec = (n: number) => new Prisma.Decimal(n);

// ₹1000 of food, 10% service charge, 5% GST on food + service charge = ₹1,155 (the customer page used to ask ₹1,150)
const OUTLET = {
  id: '11111111-1111-1111-1111-111111111111',
  businessId: 'biz-1',
  name: 'Alayn',
  tableOrderMode: 'ORDER_AND_PAY',
  cgstRateDecimal: dec(2.5),
  sgstRateDecimal: dec(2.5),
  serviceTaxRateDecimal: dec(10),
  gstRegistrationType: 'REGULAR',
};
const MENU_ITEM_ID = '22222222-2222-2222-2222-222222222222';

describe('ordering from the table QR', () => {
  const service = new OrderService();
  let createSpy: jest.SpyInstance;
  let appendSpy: jest.SpyInstance;

  const qrOrder = (extra: Record<string, unknown> = {}) =>
    service.createOrder(
      OUTLET.id,
      {
        source: 'QR',
        tableToken: 'table-4-token',
        items: [{ menuItemId: MENU_ITEM_ID, quantity: 1 }],
        ...extra,
      } as any,
      { id: '00000000-0000-0000-0000-000000000000', name: 'Table 4 Customer', role: 'STAFF' }
    );

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.outlet.findFirst as jest.Mock).mockResolvedValue(OUTLET);
    (prisma.outlet.findUnique as jest.Mock).mockResolvedValue(OUTLET);
    (prisma.tableToken.findUnique as jest.Mock).mockResolvedValue({
      token: 'table-4-token',
      outletId: OUTLET.id,
      tableNumber: 4,
      expiresAt: new Date(Date.now() + 60_000),
    });
    (prisma.menuItem.findFirst as jest.Mock).mockResolvedValue({
      id: MENU_ITEM_ID,
      name: 'Thali',
      pricePaise: 100_000,
      isActive: true,
      outlets: [{ isActive: true }],
      modifierGroups: [],
    });
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(null); // no open bill on the table
    (prisma.order.findUnique as jest.Mock).mockImplementation(({ where }: any) => ({ id: where.id, orderNumber: 'ALA1', totalPaise: 115_500, payments: [] }));
    createSpy = jest
      .spyOn(OrderRepository.prototype, 'createOrder')
      .mockImplementation(async (_outletId: string, data: any) => ({ id: 'order-1', outletId: OUTLET.id, ...data }) as any);
    appendSpy = jest.spyOn(OrderRepository.prototype, 'appendItemsToOrder').mockResolvedValue(undefined as any);
    jest.spyOn(OrderService.prototype, 'recalculateOrder').mockResolvedValue({ id: 'open-bill', totalPaise: 231_000, payments: [] } as any);
  });

  afterEach(() => jest.restoreAllMocks());

  it('records no payment when a diner orders, even if an older page sends one', async () => {
    await qrOrder({ paymentMethod: 'UPI', paymentStatus: 'CONFIRMED', paymentRef: ' 412345678901 ' });

    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(createSpy.mock.calls[0][1]).toMatchObject({ placedByName: 'Customer (QR)', placedByRole: 'QR', totalPaise: 115_500 });
  });

  it('ignores a discount or coupon sent from the diner\'s phone', async () => {
    await qrOrder({ discountAmount: 1_000, couponCode: 'FREE', couponId: '33333333-3333-3333-3333-333333333333' });

    expect(createSpy.mock.calls[0][1]).toMatchObject({ discountPaise: 0, totalPaise: 115_500, couponId: undefined, couponCode: undefined });
    expect(prisma.restaurantCoupon.updateMany).not.toHaveBeenCalled();
  });

  it('a second round joins the open bill without recording a payment', async () => {
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({ id: 'open-bill', placedByName: 'Customer (QR)' });

    await qrOrder({ paymentMethod: 'UPI', paymentRef: '998877665544' });

    expect(appendSpy).toHaveBeenCalledWith('open-bill', expect.any(Array), expect.anything());
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('saves the order and its items in one transaction', async () => {
    await qrOrder({ paymentMethod: 'UPI', paymentRef: '412345678901' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // The table row is locked before looking for its open bill, so two first orders can't open two bills
    const tableLock = (prisma.table.updateMany as jest.Mock).mock.invocationCallOrder[0];
    const openBillLookup = (prisma.order.findFirst as jest.Mock).mock.invocationCallOrder[0];
    expect(tableLock).toBeLessThan(openBillLookup);
  });

  it('retries with the next order number when another order took the same one at the same moment', async () => {
    const clash = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['orderNumber'] },
    });
    createSpy.mockRejectedValueOnce(clash);

    await qrOrder({ paymentMethod: 'CASH' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry other database errors', async () => {
    createSpy.mockRejectedValueOnce(new Error('connection lost'));
    await expect(qrOrder()).rejects.toThrow('connection lost');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('staff orders still record the payment they took at checkout', async () => {
    await service.createOrder(
      OUTLET.id,
      { source: 'COUNTER', items: [{ menuItemId: MENU_ITEM_ID, quantity: 1 }], paymentMethod: 'CARD', paymentStatus: 'CONFIRMED' } as any,
      { id: 'cashier-1', name: 'Ravi', role: 'STAFF' }
    );
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ method: 'CARD', status: 'CONFIRMED' }),
    });
  });
});

describe('QR order request limits', () => {
  const base = { source: 'QR', tableToken: 't', items: [{ menuItemId: MENU_ITEM_ID, quantity: 1 }] };

  it('rejects absurd quantities and over-long text', () => {
    expect(createOrderSchema.safeParse({ ...base, items: [{ menuItemId: MENU_ITEM_ID, quantity: 1_000 }] }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...base, paymentRef: 'x'.repeat(65) }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...base, customerPhone: '9'.repeat(21) }).success).toBe(false);
    expect(createOrderSchema.safeParse(base).success).toBe(true);
  });
});
