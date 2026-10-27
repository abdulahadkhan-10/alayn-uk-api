import { OrderService } from '../src/modules/orders/order.service';
import { tableBillRequestSchema } from '../src/modules/orders/order.schema';
import { NotificationService } from '../src/modules/notifications/notification.service';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => {
  const prismaMock: any = {
    tableToken: { findUnique: jest.fn() },
    order: { findFirst: jest.fn(), findUnique: jest.fn() },
    payment: { create: jest.fn(), updateMany: jest.fn() },
  };
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock));
  return { prisma: prismaMock };
});
jest.mock('../src/modules/notifications/notification.service', () => ({
  NotificationService: { notifyBillRequested: jest.fn().mockResolvedValue(undefined) },
}));

const OUTLET = { id: 'outlet-1', businessId: 'biz-1', upiId: 'cafe@okaxis', allowPayAtCounter: true };

describe('asking for the bill from the table QR', () => {
  const service = new OrderService();

  const tokenFor = (outlet: Record<string, unknown> = OUTLET) =>
    (prisma.tableToken.findUnique as jest.Mock).mockResolvedValue({
      token: 'table-4-token',
      outletId: OUTLET.id,
      tableNumber: 4,
      expiresAt: new Date(Date.now() + 60_000),
      outlet,
    });

  // Two rounds on one running bill: ₹2,310 with ₹500 already taken in cash
  const openBill = (payments: any[] = []) =>
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 'bill-1',
      orderNumber: 'ALA1',
      tableNumber: 4,
      outletId: OUTLET.id,
      totalPaise: 231_000,
      payments,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    tokenFor();
    openBill();
    (prisma.order.findUnique as jest.Mock).mockImplementation(({ where }: any) => ({ id: where.id, orderNumber: 'ALA1', tableNumber: 4, outletId: OUTLET.id, payments: [] }));
  });

  it('records card at the counter as one pending payment for the whole bill and alerts the staff', async () => {
    await service.requestTableBill('table-4-token', { paymentMethod: 'CARD' });

    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: { orderId: 'bill-1', amountPaise: 231_000, method: 'CARD', status: 'PENDING', reference: null },
    });
    expect(NotificationService.notifyBillRequested).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bill-1', tableNumber: 4, method: 'CARD', amountPaise: 231_000 })
    );
  });

  it('asks only for what is still due and keeps the UTR of a UPI payment', async () => {
    openBill([{ status: 'CONFIRMED', amountPaise: 50_000, method: 'CASH' }]);

    await service.requestTableBill('table-4-token', { paymentMethod: 'UPI', paymentRef: ' 412345678901 ' });

    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: { orderId: 'bill-1', amountPaise: 181_000, method: 'UPI', status: 'PENDING', reference: '412345678901' },
    });
  });

  it('replaces an earlier choice instead of adding to it', async () => {
    openBill([{ status: 'PENDING', amountPaise: 115_500, method: 'CASH' }]);

    await service.requestTableBill('table-4-token', { paymentMethod: 'UPI' });

    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'bill-1', status: 'PENDING' },
      data: { status: 'VOID' },
    });
    const voided = (prisma.payment.updateMany as jest.Mock).mock.invocationCallOrder[0];
    const created = (prisma.payment.create as jest.Mock).mock.invocationCallOrder[0];
    expect(voided).toBeLessThan(created);
  });

  it('records nothing when the bill is already paid', async () => {
    openBill([{ status: 'CONFIRMED', amountPaise: 231_000, method: 'UPI' }]);

    await service.requestTableBill('table-4-token', { paymentMethod: 'CASH' });

    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(NotificationService.notifyBillRequested).not.toHaveBeenCalled();
  });

  it('fails when the table has no open bill', async () => {
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(service.requestTableBill('table-4-token', { paymentMethod: 'CASH' })).rejects.toMatchObject({ code: 'NO_ACTIVE_ORDER' });
  });

  it('refuses counter payment when the restaurant only takes UPI from the phone', async () => {
    tokenFor({ ...OUTLET, allowPayAtCounter: false });

    await expect(service.requestTableBill('table-4-token', { paymentMethod: 'CASH' })).rejects.toMatchObject({ code: 'PAY_AT_COUNTER_DISABLED' });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('refuses UPI when the restaurant has no UPI ID', async () => {
    tokenFor({ ...OUTLET, upiId: null });

    await expect(service.requestTableBill('table-4-token', { paymentMethod: 'UPI' })).rejects.toMatchObject({ code: 'UPI_NOT_AVAILABLE' });
  });

  it('rejects expired table codes', async () => {
    (prisma.tableToken.findUnique as jest.Mock).mockResolvedValue({ token: 't', outletId: OUTLET.id, tableNumber: 4, expiresAt: new Date(Date.now() - 1000), outlet: OUTLET });

    await expect(service.requestTableBill('t', { paymentMethod: 'CASH' })).rejects.toMatchObject({ code: 'EXPIRED_TOKEN' });
  });

  it('validates the request', () => {
    expect(tableBillRequestSchema.safeParse({ paymentMethod: 'CARD' }).success).toBe(true);
    expect(tableBillRequestSchema.safeParse({ paymentMethod: 'WALLET' }).success).toBe(false);
    expect(tableBillRequestSchema.safeParse({ paymentMethod: 'UPI', paymentRef: 'x'.repeat(65) }).success).toBe(false);
  });
});
