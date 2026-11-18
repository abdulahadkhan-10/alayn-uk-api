import { Prisma } from '@prisma/client';
import { calculateBill } from '../src/modules/orders/billing';
import { OrderService } from '../src/modules/orders/order.service';
import { DashboardService } from '../src/modules/analytics/dashboard.service';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => {
  const prismaMock: any = {
    order: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderItem: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    payment: { create: jest.fn(), updateMany: jest.fn() },
    recipe: { findMany: jest.fn().mockResolvedValue([]) },
    table: { updateMany: jest.fn() },
    orderStatusHistory: { create: jest.fn() },
    wasteLog: { findMany: jest.fn().mockResolvedValue([]) },
    employee: { count: jest.fn().mockResolvedValue(0) },
  };
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock));
  return { prisma: prismaMock };
});
jest.mock('../src/modules/notifications/notification.service', () => ({
  NotificationService: { notifyOrderPlaced: jest.fn().mockResolvedValue(undefined), notifyOrderReady: jest.fn().mockResolvedValue(undefined) },
}));


const dec = (n: number) => new Prisma.Decimal(n);
const RATES = { vatRate: 20, serviceChargeRate: 10 };

// Table 1: Chicken Burger £12 + Fries £4. Menu prices include VAT.
const TABLE_1_ITEMS = [
  { unitPricePence: 1_200, quantity: 1 },
  { unitPricePence: 400, quantity: 1 },
];

describe('calculateBill — the single bill calculation (prices include VAT)', () => {
  it('Table 1: VAT is the part of the price already paid; service charge is added on top', () => {
    const bill = calculateBill(TABLE_1_ITEMS, RATES, { dineIn: true });
    expect(bill).toMatchObject({
      subtotalPence: 1_600,
      vatPence: 267, // £16 × 20/120 = £2.67
      netOfVatPence: 1_333,
      serviceChargePence: 160, // 10% of £16
      roundOffPence: 0,
      totalPence: 1_760, // £16 + £1.60 service charge (no VAT on a voluntary service charge)
    });
  });

  it('no service charge on counter / takeaway orders, and the total is the menu price', () => {
    const bill = calculateBill(TABLE_1_ITEMS, RATES, { dineIn: false });
    expect(bill.serviceChargePence).toBe(0);
    expect(bill.vatPence).toBe(267);
    expect(bill.totalPence).toBe(1_600);
    expect(bill.appliedRates.serviceChargeRate).toBe(0);
  });

  it('removes the service charge when the customer declines it', () => {
    const bill = calculateBill(TABLE_1_ITEMS, RATES, { dineIn: true, serviceChargeWaived: true });
    expect(bill.serviceChargePence).toBe(0);
    expect(bill.totalPence).toBe(1_600);
  });

  it('outlets that are not VAT-registered show no VAT; the price is unchanged', () => {
    const bill = calculateBill(TABLE_1_ITEMS, RATES, { dineIn: true, vatRegistered: false });
    expect(bill.vatPence).toBe(0);
    expect(bill.appliedRates.vatRate).toBe(0);
    expect(bill.serviceChargePence).toBe(160);
    expect(bill.totalPence).toBe(1_760);
  });

  it('rounds VAT to the nearest penny', () => {
    // £0.99 × 20/120 = 16.5p → 17p
    expect(calculateBill([{ unitPricePence: 99, quantity: 1 }], RATES, { dineIn: false }).vatPence).toBe(17);
    // £0.98 × 20/120 = 16.33p → 16p
    expect(calculateBill([{ unitPricePence: 98, quantity: 1 }], RATES, { dineIn: false }).vatPence).toBe(16);
  });

  it('applies a discount before service charge and VAT', () => {
    const bill = calculateBill([{ unitPricePence: 1_200, quantity: 1 }], RATES, { dineIn: true, discountPence: 200 });
    expect(bill.serviceChargePence).toBe(100); // 10% of £10
    expect(bill.vatPence).toBe(167); // £10 × 20/120
    expect(bill.totalPence).toBe(1_100);
  });
});

describe('OrderService bill lifecycle', () => {
  const service = new OrderService();

  const openTable1 = (overrides: any = {}) => ({
    id: 'order-1',
    outletId: 'outlet-1',
    source: 'TABLE',
    status: 'SENT_TO_KITCHEN',
    tableNumber: 1,
    discountPence: 0,
    serviceChargeWaived: false,
    // Snapshot taken when the bill was opened
    vatRate: dec(20),
    serviceChargeRate: dec(10),
    items: TABLE_1_ITEMS.map((i, idx) => ({ ...i, id: `item-${idx}`, status: 'SENT_TO_KITCHEN' })),
    outlet: { vatRateDecimal: dec(20), serviceTaxRateDecimal: dec(10), vatRegistered: true },
    payments: [],
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.order.update as jest.Mock).mockImplementation(({ data }: any) => ({ ...openTable1(), ...data }));
  });

  it('recalculates the whole bill after a new round', async () => {
    (prisma.order.findUnique as jest.Mock).mockResolvedValue(openTable1());
    await service.recalculateOrder('order-1');
    const saved = (prisma.order.update as jest.Mock).mock.calls[0][0].data;
    expect(saved).toMatchObject({
      subtotalPence: 1_600,
      serviceTaxPence: 160,
      vatPence: 267,
      taxPence: 267 + 160,
      roundOffPence: 0,
      totalPence: 1_760,
    });
    expect(Number(saved.vatRate)).toBe(20);
  });

  it('keeps the rates of the open bill even if outlet settings change mid-service', async () => {
    (prisma.order.findUnique as jest.Mock).mockResolvedValue(
      openTable1({ outlet: { vatRateDecimal: dec(5), serviceTaxRateDecimal: dec(0), vatRegistered: true } })
    );
    await service.recalculateOrder('order-1');
    const saved = (prisma.order.update as jest.Mock).mock.calls[0][0].data;
    expect(saved.serviceTaxPence).toBe(160);
    expect(saved.vatPence).toBe(267);
  });

  it('bills created before snapshots existed take the outlet rates once', async () => {
    (prisma.order.findUnique as jest.Mock).mockResolvedValue(openTable1({ vatRate: null, serviceChargeRate: null }));
    await service.recalculateOrder('order-1');
    const saved = (prisma.order.update as jest.Mock).mock.calls[0][0].data;
    expect(Number(saved.serviceChargeRate)).toBe(10);
    expect(Number(saved.vatRate)).toBe(20);
    expect(saved.totalPence).toBe(1_760);
  });

  it('settlement records a payment for the final recalculated total', async () => {
    // findOrderById (old, wrongly-added amounts) → recalculation → payment of the correct total
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({ ...openTable1(), totalPence: 1_700 });
    (prisma.order.findUnique as jest.Mock).mockResolvedValue(openTable1());

    // Cash: card settles only with the cashier's "received" confirmation (tests/split-payment.test.ts)
    await service.updateOrderStatus('outlet-1', 'order-1', 'COMPLETED', undefined, 'user-1', 'CASH');

    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: { orderId: 'order-1', amountPence: 1_760, method: 'CASH', status: 'CONFIRMED' },
    });
  });

  describe('removing the service charge', () => {
    it('needs a reason, and recalculates the bill without it', async () => {
      (prisma.order.findFirst as jest.Mock).mockResolvedValue(openTable1());
      await expect(service.setServiceChargeWaiver('outlet-1', 'order-1', true, '  ', 'user-1')).rejects.toThrow(
        'Please give a reason'
      );

      (prisma.order.findUnique as jest.Mock).mockResolvedValue(openTable1({ serviceChargeWaived: true }));
      await service.setServiceChargeWaiver('outlet-1', 'order-1', true, 'Customer declined', 'user-1');

      const waiverUpdate = (prisma.order.update as jest.Mock).mock.calls[0][0].data;
      expect(waiverUpdate).toMatchObject({
        serviceChargeWaived: true,
        serviceChargeWaivedById: 'user-1',
        serviceChargeWaiveReason: 'Customer declined',
      });
      const recalculated = (prisma.order.update as jest.Mock).mock.calls[1][0].data;
      expect(recalculated.serviceTaxPence).toBe(0);
    });

    it('is refused on a settled bill', async () => {
      (prisma.order.findFirst as jest.Mock).mockResolvedValue(openTable1({ status: 'COMPLETED' }));
      await expect(service.setServiceChargeWaiver('outlet-1', 'order-1', true, 'x', 'user-1')).rejects.toMatchObject({
        code: 'BILL_CLOSED',
      });
    });

    it('is refused on counter orders (no service charge there)', async () => {
      (prisma.order.findFirst as jest.Mock).mockResolvedValue(openTable1({ source: 'COUNTER' }));
      await expect(service.setServiceChargeWaiver('outlet-1', 'order-1', true, 'x', 'user-1')).rejects.toMatchObject({
        code: 'NOT_DINE_IN',
      });
    });

    it("can't reach another business's bill", async () => {
      (prisma.order.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(
        service.setServiceChargeWaiver('all', 'order-1', true, 'x', 'user-1', 'biz-other')
      ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
      expect((prisma.order.findFirst as jest.Mock).mock.calls[0][0].where.outlet).toEqual({ businessId: 'biz-other' });
    });
  });
});

describe('Dashboard: VAT collected excludes service charge', () => {
  it('reports VAT and service charge separately', async () => {
    (prisma.order.findMany as jest.Mock).mockImplementation(({ where }: any) =>
      where.status === 'COMPLETED' && where.createdAt.gte > new Date('2026-01-01')
        ? [{ id: 'o1', subtotalPence: 160_000, discountPence: 0, vatPence: 26_667, serviceTaxPence: 16_000 }]
        : []
    );
    const kpis: any = await new DashboardService().getKpis('outlet-1', 'biz-1', 'TODAY');
    expect(kpis.taxCollected.value).toBe('£267'); // £266.67 → shown rounded
    expect(kpis.serviceCharge.value).toBe('£160');
  });
});
