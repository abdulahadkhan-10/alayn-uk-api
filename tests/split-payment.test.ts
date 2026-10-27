import { Prisma } from '@prisma/client';
import { OrderService } from '../src/modules/orders/order.service';
import { updateOrderStatusSchema } from '../src/modules/orders/order.schema';
import { summarizePayments, validateSettlementPayments } from '../src/modules/orders/splitPayment';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => {
  const prismaMock: any = {
    order: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment: { create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    table: { updateMany: jest.fn() },
    orderStatusHistory: { create: jest.fn() },
    restaurantCoupon: { findFirst: jest.fn(), update: jest.fn() },
  };
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock));
  return { prisma: prismaMock };
});
jest.mock('../src/modules/notifications/notification.service', () => ({
  NotificationService: { notifyOrderPlaced: jest.fn().mockResolvedValue(undefined), notifyOrderReady: jest.fn().mockResolvedValue(undefined) },
}));

const dec = (n: number) => new Prisma.Decimal(n);

describe('validateSettlementPayments', () => {
  it('accepts ₹100 cash + ₹185 UPI on a ₹285 bill', () => {
    const recorded = validateSettlementPayments(
      [
        { method: 'CASH', amountPaise: 10_000 },
        { method: 'UPI', amountPaise: 18_500, reference: ' 4123 ', verified: true },
      ],
      28_500
    );
    expect(recorded).toEqual([
      { method: 'CASH', amountPaise: 10_000, reference: null, isOnline: false },
      { method: 'UPI', amountPaise: 18_500, reference: '4123', isOnline: true },
    ]);
  });

  it('refuses payments that fall short of the balance, naming the gap', () => {
    expect(() =>
      validateSettlementPayments([{ method: 'CASH', amountPaise: 10_000 }, { method: 'UPI', amountPaise: 18_450, verified: true }], 28_500)
    ).toThrow(expect.objectContaining({ code: 'PAYMENT_AMOUNT_MISMATCH', message: expect.stringContaining('₹0.50 is still unallocated') }));
  });

  it('refuses payments that exceed the balance', () => {
    expect(() => validateSettlementPayments([{ method: 'CASH', amountPaise: 30_000 }], 28_500)).toThrow(
      expect.objectContaining({ code: 'PAYMENT_AMOUNT_MISMATCH', message: expect.stringContaining('₹15.00 more') })
    );
  });

  it.each(['UPI', 'CARD'] as const)('needs an unverified %s part to be confirmed received', (method) => {
    expect(() =>
      validateSettlementPayments([{ method: 'CASH', amountPaise: 10_000 }, { method, amountPaise: 18_500 }], 28_500)
    ).toThrow(expect.objectContaining({ code: 'PAYMENT_NOT_VERIFIED' }));
  });

  it('does not need cash to be verified', () => {
    expect(() => validateSettlementPayments([{ method: 'CASH', amountPaise: 28_500 }], 28_500)).not.toThrow();
  });

  it('refuses zero or fractional amounts and too many parts', () => {
    expect(() => validateSettlementPayments([{ method: 'CASH', amountPaise: 0 }], 0)).toThrow('greater than zero');
    expect(() => validateSettlementPayments([{ method: 'CASH', amountPaise: 100.5 }], 100.5)).toThrow('greater than zero');
    const seven = Array.from({ length: 7 }, () => ({ method: 'CASH' as const, amountPaise: 100 }));
    expect(() => validateSettlementPayments(seven, 700)).toThrow('at most 6');
  });
});

describe('request validation', () => {
  it('only takes whole-paise amounts', () => {
    expect(updateOrderStatusSchema.safeParse({ status: 'COMPLETED', payments: [{ method: 'CASH', amountPaise: 100.5 }] }).success).toBe(false);
    expect(updateOrderStatusSchema.safeParse({ status: 'COMPLETED', payments: [{ method: 'CASH', amountPaise: -100 }] }).success).toBe(false);
    expect(updateOrderStatusSchema.safeParse({ status: 'COMPLETED', payments: [{ method: 'WALLET', amountPaise: 100 }] }).success).toBe(false);
    expect(
      updateOrderStatusSchema.safeParse({
        status: 'COMPLETED',
        payments: [{ method: 'UPI', amountPaise: 18_500, verified: true, reference: 'UTR123' }],
        idempotencyKey: 'settle-7f1c2a9e',
      }).success
    ).toBe(true);
  });
});

describe('summarizePayments', () => {
  it('reports a split bill as SPLIT with each confirmed part, ignoring voided intents', () => {
    const summary = summarizePayments(
      [
        { method: 'UPI', amountPaise: 28_500, status: 'VOID' },
        { method: 'CASH', amountPaise: 10_000, status: 'CONFIRMED' },
        { method: 'UPI', amountPaise: 18_500, status: 'CONFIRMED', reference: 'UTR9' },
      ],
      28_500
    );
    expect(summary).toMatchObject({
      paymentMethod: 'SPLIT',
      paymentStatus: 'CONFIRMED',
      isSplitPayment: true,
      paidAmount: 285,
      balanceDue: 0,
      paymentSplits: [
        { method: 'CASH', amount: 100, reference: null },
        { method: 'UPI', amount: 185, reference: 'UTR9' },
      ],
    });
  });

  it('keeps single-payment bills exactly as before', () => {
    expect(summarizePayments([{ method: 'CARD', amountPaise: 28_500, status: 'CONFIRMED' }], 28_500)).toMatchObject({
      paymentMethod: 'CARD',
      paymentStatus: 'CONFIRMED',
      isSplitPayment: false,
    });
    // Open bill with only the checkout's intent
    expect(summarizePayments([{ method: 'UPI', amountPaise: 28_500, status: 'PENDING' }], 28_500)).toMatchObject({
      paymentMethod: 'UPI',
      paymentStatus: 'PENDING',
      balanceDue: 285,
    });
  });
});

describe('settling a bill with a split payment', () => {
  const service = new OrderService();

  // Counter bill: ₹271.43 + 5% GST = ₹285.00
  const openBill = (overrides: any = {}) => ({
    id: 'order-1',
    outletId: 'outlet-1',
    source: 'COUNTER',
    status: 'SERVED',
    tableNumber: null,
    discountPaise: 0,
    subtotalPaise: 27_143,
    totalPaise: 28_500,
    serviceChargeWaived: false,
    settlementKey: null,
    cgstRate: dec(2.5),
    sgstRate: dec(2.5),
    serviceChargeRate: dec(0),
    items: [{ id: 'item-1', unitPricePaise: 27_143, quantity: 1, status: 'SERVED' }],
    outlet: { businessId: 'biz-1', cgstRateDecimal: dec(2.5), sgstRateDecimal: dec(2.5), serviceTaxRateDecimal: dec(0), gstRegistrationType: 'REGULAR' },
    payments: [{ id: 'p0', method: 'UPI', amountPaise: 28_500, status: 'PENDING' }],
    ...overrides,
  });

  const settle = (
    payments: any[] | undefined,
    idempotencyKey?: string,
    paymentMethod?: 'CASH' | 'CARD' | 'UPI',
    allowDuplicateReference?: boolean
  ) =>
    service.updateOrderStatus(
      'outlet-1', 'order-1', 'COMPLETED', undefined, 'cashier-1', paymentMethod,
      undefined, undefined, 'biz-1', 'STAFF', undefined, { payments, idempotencyKey, allowDuplicateReference }
    );

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(openBill());
    (prisma.order.findUnique as jest.Mock).mockResolvedValue(openBill());
    (prisma.order.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.order.update as jest.Mock).mockImplementation(({ data }: any) => ({ ...openBill(), ...data }));
    (prisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
  });

  it('records ₹100 cash + ₹185 UPI in one transaction and voids the checkout intent', async () => {
    await settle(
      [
        { method: 'CASH', amountPaise: 10_000 },
        { method: 'UPI', amountPaise: 18_500, reference: 'UTR42', verified: true },
      ],
      'settle-key-1'
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      data: expect.objectContaining({ status: 'COMPLETED', settlementKey: 'settle-key-1' }),
    });
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({ where: { orderId: 'order-1', status: 'PENDING' }, data: { status: 'VOID' } });

    const created = (prisma.payment.create as jest.Mock).mock.calls.map(([arg]) => arg.data);
    expect(created).toEqual([
      { orderId: 'order-1', amountPaise: 10_000, method: 'CASH', status: 'CONFIRMED', reference: null },
      expect.objectContaining({ orderId: 'order-1', amountPaise: 18_500, method: 'UPI', status: 'CONFIRMED', reference: 'UTR42', verifiedById: 'cashier-1', verifiedAt: expect.any(Date) }),
    ]);
    expect((prisma.orderStatusHistory.create as jest.Mock).mock.calls[0][0].data.comment).toContain('Paid Cash ₹100.00 + UPI ₹185.00');
  });

  it('stops when the UTR was already used on another bill of this outlet', async () => {
    (prisma.payment.findFirst as jest.Mock).mockResolvedValue({ amountPaise: 18_500, order: { orderNumber: 'ORD-41' } });
    const split = [
      { method: 'CASH', amountPaise: 10_000 },
      { method: 'UPI', amountPaise: 18_500, reference: 'UTR42', verified: true },
    ];

    await expect(settle(split)).rejects.toMatchObject({ code: 'DUPLICATE_PAYMENT_REFERENCE', statusCode: 409 });
    await expect(settle(split)).rejects.toThrow('UPI reference UTR42 was already used on bill #ORD-41 (₹185.00)');
    expect(prisma.payment.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { method: 'UPI', reference: 'UTR42', status: 'CONFIRMED', orderId: { not: 'order-1' }, order: { outletId: 'outlet-1' } },
    }));
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('settles a reused UTR once the cashier confirms', async () => {
    (prisma.payment.findFirst as jest.Mock).mockResolvedValue({ amountPaise: 18_500, order: { orderNumber: 'ORD-41' } });
    await settle(
      [
        { method: 'CASH', amountPaise: 10_000 },
        { method: 'UPI', amountPaise: 18_500, reference: 'UTR42', verified: true },
      ],
      undefined,
      undefined,
      true
    );
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    expect(prisma.payment.create).toHaveBeenCalledTimes(2);
  });

  it('stops when the same UTR is typed on two parts of one bill', async () => {
    await expect(
      settle([
        { method: 'UPI', amountPaise: 10_000, reference: 'UTR42', verified: true },
        { method: 'UPI', amountPaise: 18_500, reference: 'UTR42', verified: true },
      ])
    ).rejects.toMatchObject({ code: 'DUPLICATE_PAYMENT_REFERENCE' });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('rejects a split that does not cover the bill, before recording any payment', async () => {
    await expect(settle([{ method: 'CASH', amountPaise: 10_000 }, { method: 'UPI', amountPaise: 18_000, verified: true }])).rejects.toMatchObject({
      code: 'PAYMENT_AMOUNT_MISMATCH',
    });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('rejects an unverified UPI part', async () => {
    await expect(settle([{ method: 'CASH', amountPaise: 10_000 }, { method: 'UPI', amountPaise: 18_500 }])).rejects.toMatchObject({
      code: 'PAYMENT_NOT_VERIFIED',
    });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('only asks for the balance when part was already paid (QR UPI)', async () => {
    const partlyPaid = openBill({ payments: [{ id: 'p0', method: 'UPI', amountPaise: 8_500, status: 'CONFIRMED' }] });
    (prisma.order.findUnique as jest.Mock).mockResolvedValue(partlyPaid);
    (prisma.order.update as jest.Mock).mockImplementation(({ data }: any) => ({ ...partlyPaid, ...data }));

    await expect(settle([{ method: 'CASH', amountPaise: 28_500 }])).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' });
    jest.clearAllMocks();
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(partlyPaid);
    (prisma.order.findUnique as jest.Mock).mockResolvedValue(partlyPaid);
    (prisma.order.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.order.update as jest.Mock).mockImplementation(({ data }: any) => ({ ...partlyPaid, ...data }));
    await settle([{ method: 'CASH', amountPaise: 20_000 }]);
    expect((prisma.payment.create as jest.Mock).mock.calls[0][0].data.amountPaise).toBe(20_000);
  });

  it('a settle request retried with the same key returns the settled bill without paying twice', async () => {
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(openBill({ status: 'COMPLETED', settlementKey: 'settle-key-1' }));
    const result: any = await settle([{ method: 'CASH', amountPaise: 28_500 }], 'settle-key-1');
    expect(result.status).toBe('COMPLETED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('two simultaneous requests: the one that loses the claim records nothing', async () => {
    (prisma.order.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    // Same key (double tap): gets the settled bill
    (prisma.order.findUnique as jest.Mock).mockResolvedValue(openBill({ status: 'COMPLETED', settlementKey: 'settle-key-1' }));
    await expect(settle([{ method: 'CASH', amountPaise: 28_500 }], 'settle-key-1')).resolves.toMatchObject({ status: 'COMPLETED' });

    // Another device: told the bill is already settled
    (prisma.order.findUnique as jest.Mock).mockResolvedValue(openBill({ status: 'COMPLETED', settlementKey: 'other-device' }));
    await expect(settle([{ method: 'CASH', amountPaise: 28_500 }], 'settle-key-1')).rejects.toMatchObject({ code: 'ALREADY_SETTLED', statusCode: 409 });

    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a single UPI or card settle the cashier has not confirmed, leaving the bill open', async () => {
    await expect(settle(undefined, undefined, 'UPI')).rejects.toMatchObject({ code: 'PAYMENT_NOT_VERIFIED', statusCode: 400 });
    await expect(settle(undefined, undefined, 'CARD')).rejects.toThrow('Confirm the card payment of ₹285.00 was received before settling.');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('a confirmed single UPI payment records the UTR and who checked it', async () => {
    await settle([{ method: 'UPI', amountPaise: 28_500, reference: '412345678901', verified: true }], 'settle-key-1', 'UPI');

    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amountPaise: 28_500,
        method: 'UPI',
        status: 'CONFIRMED',
        reference: '412345678901',
        verifiedById: 'cashier-1',
        verifiedAt: expect.any(Date),
      }),
    });
  });

  it('a single cash payment still settles the whole balance as before', async () => {
    await settle(undefined, undefined, 'CASH');
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: { orderId: 'order-1', amountPaise: 28_500, method: 'CASH', status: 'CONFIRMED' },
    });
  });
});
