import { Prisma } from '@prisma/client';
import { PurchaseOrderService } from '../src/modules/purchase-orders/purchaseOrder.service';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => {
  const prismaMock: any = {
    purchaseOrder: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
    supplier: { findFirst: jest.fn() },
    purchaseOrderItem: { update: jest.fn(), findMany: jest.fn() },
    stockBatch: { create: jest.fn() },
    stockLedgerEntry: { create: jest.fn(), aggregate: jest.fn() },
    item: { update: jest.fn(), findFirst: jest.fn() },
    outlet: { findFirst: jest.fn(), findUnique: jest.fn() },
  };
  prismaMock.$queryRaw = jest.fn();
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock));
  return { prisma: prismaMock };
});

jest.mock('../src/modules/notifications/notification.service', () => ({
  NotificationService: { notifyPOStatusChanged: jest.fn().mockResolvedValue(undefined) },
}));

const OUTLET = 'outlet-bandra';
const PO_ID = '9b1e7c2a-4f3d-4a8e-9c1b-2d3e4f5a6b7c';
const dec = (n: number) => new Prisma.Decimal(n);

// "Test Milk": ordered 10 L at ₹60 (6000 paise); item master price currently ₹50
const poItem = (overrides: any = {}) => ({
  id: 'poi-milk',
  itemId: 'item-milk',
  orderedQuantity: dec(10),
  receivedQuantity: dec(0),
  damagedQuantity: dec(0),
  unitCostPaise: 6000,
  item: { name: 'Test Milk', unitCostPaise: 5000 },
  ...overrides,
});

const mockPO = (status: string, items = [poItem()]) =>
  (prisma.purchaseOrder.findFirst as jest.Mock).mockResolvedValue({ id: PO_ID, status, outletId: OUTLET, items });

// After the receive, the reloaded PO items reflect what was just written
const mockReloadedItems = (received: number, damaged: number) =>
  (prisma.purchaseOrderItem.findMany as jest.Mock).mockResolvedValue([
    { orderedQuantity: dec(10), receivedQuantity: dec(received), damagedQuantity: dec(damaged) },
  ]);

const receive = (receivedQuantity: number, damagedQuantity = 0) =>
  new PurchaseOrderService().receivePO(OUTLET, PO_ID, [
    { itemId: 'item-milk', receivedQuantity, damagedQuantity, batchNumber: 'BCH-1', expiryDate: new Date('2026-10-10') },
  ]);

describe('Purchase orders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.purchaseOrder.update as jest.Mock).mockImplementation(({ data }: any) => ({ id: PO_ID, ...data }));
    (prisma.stockLedgerEntry.aggregate as jest.Mock).mockResolvedValue({ _sum: { change: dec(0) } });
  });

  it('only finds POs belonging to the current outlet', async () => {
    mockPO('SENT');
    mockReloadedItems(10, 0);
    await receive(10);
    expect((prisma.purchaseOrder.findFirst as jest.Mock).mock.calls[0][0].where).toMatchObject({ id: PO_ID, outletId: OUTLET });
  });

  describe('ordering from a marketplace supplier', () => {
    const createFor = (supplier: any, clientRequestId?: string) => {
      (prisma.supplier.findFirst as jest.Mock).mockResolvedValue(supplier);
      (prisma.item.findFirst as jest.Mock).mockResolvedValue({ id: 'item-buff', outletId: OUTLET });
      (prisma.outlet.findFirst as jest.Mock).mockResolvedValue({ id: OUTLET });
      (prisma.outlet.findUnique as jest.Mock).mockResolvedValue({ name: 'Sea Breeze Bandra', business: { name: 'Sea Breeze' } });
      ((prisma as any).$queryRaw as jest.Mock).mockResolvedValue([{ value: 7 }]);
      (prisma.purchaseOrder.create as jest.Mock).mockImplementation(({ data }: any) => ({ id: 'po-new', ...data }));
      (prisma.purchaseOrder.findFirst as jest.Mock).mockResolvedValue(null); // no earlier attempt with this key
      return new PurchaseOrderService().createPO(
        OUTLET,
        'sup-ali',
        [{ itemId: 'item-buff', orderedQuantity: 3, unitCostPaise: 35000 }],
        'biz-1',
        clientRequestId
      );
    };

    it('accepts a supplier who signed up on the portal, even though no outlet owns them', async () => {
      const po = await createFor({ id: 'sup-ali', outletId: null, type: 'ONLINE', userId: 'user-ali' });
      expect(po.status).toBe('SENT');
      // The order is delivered to the restaurant's outlet, not the supplier's
      expect((prisma.purchaseOrder.create as jest.Mock).mock.calls[0][0].data.outletId).toBe(OUTLET);
    });

    it('looks the supplier up as "own vendor OR portal supplier", never any supplier at all', async () => {
      await createFor({ id: 'sup-ali', outletId: null, type: 'ONLINE', userId: 'user-ali' });
      const where = (prisma.supplier.findFirst as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ id: 'sup-ali', deletedAt: null });
      expect(where.OR).toEqual([{ outletId: OUTLET }, { type: 'ONLINE', userId: { not: null } }]);
    });

    it('creates the PO already sent, with a restaurant-style PO number, in one transaction', async () => {
      const po: any = await createFor({ id: 'sup-ali', outletId: null, type: 'ONLINE', userId: 'user-ali' });
      expect(po.poNumber).toMatch(/^PO-SEA-\d{8}-007$/);
      expect((prisma.purchaseOrder.create as jest.Mock).mock.calls[0][0].data).toMatchObject({ status: 'SENT', poNumber: po.poNumber });
      expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
      expect((prisma as any).$transaction).toHaveBeenCalled();
    });

    describe('double-click / retried "Create PO"', () => {
      const KEY = '0f8e2d4c-6b1a-4c3e-9d7f-5a2b1c0e9f8d';
      const portalSupplier = { id: 'sup-ali', outletId: null, type: 'ONLINE', userId: 'user-ali' };

      it('saves the one-time key with the new PO', async () => {
        await createFor(portalSupplier, KEY);
        expect((prisma.purchaseOrder.create as jest.Mock).mock.calls[0][0].data.clientRequestId).toBe(KEY);
      });

      it('a repeat of the same key returns the PO already created, without creating or notifying again', async () => {
        const already = { id: 'po-first', poNumber: 'PO-SEA-20261102-003', outletId: OUTLET };
        (prisma.purchaseOrder.findFirst as jest.Mock).mockResolvedValueOnce(already);

        const po = await createFor(portalSupplier, KEY);

        expect(po).toBe(already);
        expect((prisma.purchaseOrder.findFirst as jest.Mock).mock.calls[0][0].where).toMatchObject({ clientRequestId: KEY, outletId: OUTLET });
        expect(prisma.purchaseOrder.create).not.toHaveBeenCalled();
        const { NotificationService } = jest.requireMock('../src/modules/notifications/notification.service');
        expect(NotificationService.notifyPOStatusChanged).not.toHaveBeenCalled();
      });

      it("two copies at the same instant: the one the database rejects gets the winner's PO", async () => {
        const winner = { id: 'po-winner', poNumber: 'PO-SEA-20261102-004', outletId: OUTLET };
        (prisma.purchaseOrder.findFirst as jest.Mock)
          .mockResolvedValueOnce(null) // not there yet when this copy checked
          .mockResolvedValueOnce(winner); // there once the other copy committed
        (prisma.purchaseOrder.create as jest.Mock).mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['clientRequestId'] },
          })
        );

        const po = await createFor(portalSupplier, KEY);
        expect(po).toBe(winner);
        expect(prisma.purchaseOrder.create).toHaveBeenCalledTimes(1);
      });

      it('a key used by someone outside this outlet is refused, never returned', async () => {
        (prisma.purchaseOrder.create as jest.Mock).mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['clientRequestId'] },
          })
        );
        await expect(createFor(portalSupplier, KEY)).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
      });
    });

    it('still refuses a supplier that is neither', async () => {
      await expect(createFor(null)).rejects.toMatchObject({ code: 'SUPPLIER_NOT_FOUND' });
    });
  });

  describe('13c — damaged goods', () => {
    it('records damaged quantity, keeps it out of stock, and completes the PO when everything is accounted for', async () => {
      mockPO('SENT');
      mockReloadedItems(8, 2);

      const result: any = await receive(8, 2);

      expect(prisma.purchaseOrderItem.update).toHaveBeenCalledWith({
        where: { id: 'poi-milk' },
        data: { receivedQuantity: dec(8), damagedQuantity: dec(2) },
      });
      // Only the 8 accepted litres enter stock
      expect((prisma.stockLedgerEntry.create as jest.Mock).mock.calls[0][0].data.change).toEqual(dec(8));
      expect(result.status).toBe('RECEIVED');
    });

    it('rejects received + damaged that exceeds the ordered quantity', async () => {
      mockPO('SENT');
      await expect(receive(8, 3)).rejects.toThrow('would exceed ordered (10)');
    });
  });

  describe('13d — purchase price', () => {
    it('updates the item cost to the weighted average of stock on hand and the new delivery', async () => {
      mockPO('SENT');
      mockReloadedItems(10, 0);
      // 10 L already in stock at ₹50, receiving 10 L at ₹60 → ₹55
      (prisma.stockLedgerEntry.aggregate as jest.Mock).mockResolvedValue({ _sum: { change: dec(10) } });

      await receive(10);

      expect(prisma.item.update).toHaveBeenCalledWith({ where: { id: 'item-milk' }, data: { unitCostPaise: 5500 } });
    });

    it('uses the purchase price directly when there is no stock on hand', async () => {
      mockPO('SENT');
      mockReloadedItems(10, 0);

      await receive(10);

      expect(prisma.item.update).toHaveBeenCalledWith({ where: { id: 'item-milk' }, data: { unitCostPaise: 6000 } });
    });
  });

  describe('13a — cancel', () => {
    it('cancels an order that has not been received, with a reason', async () => {
      mockPO('SENT');
      const result: any = await new PurchaseOrderService().cancelPO(OUTLET, PO_ID, 'Found a cheaper supplier');
      expect(result.status).toBe('CANCELLED');
      expect(result.closedReason).toBe('Found a cheaper supplier');
      expect(result.closedAt).toBeInstanceOf(Date);
    });

    it('refuses to cancel once something was received (use close instead)', async () => {
      mockPO('PARTIALLY_RECEIVED', [poItem({ receivedQuantity: dec(3) })]);
      await expect(new PurchaseOrderService().cancelPO(OUTLET, PO_ID, undefined)).rejects.toThrow('Use "Close order"');
    });

    it('does not allow receiving stock on a cancelled order', async () => {
      mockPO('CANCELLED');
      await expect(receive(5)).rejects.toThrow('Cannot receive items on a cancelled purchase order');
    });
  });

  describe('two people acting on the same PO at the same moment', () => {
    const lockCalls = () =>
      ((prisma as any).$queryRaw as jest.Mock).mock.calls.filter((c: any[]) => c[0].join('?').includes('FOR UPDATE'));
    const lockedBeforeRead = () =>
      ((prisma as any).$queryRaw as jest.Mock).mock.invocationCallOrder[0] <
      (prisma.purchaseOrder.findFirst as jest.Mock).mock.invocationCallOrder[0];

    it('receive locks the PO row, then reads it inside the same transaction', async () => {
      mockPO('SENT');
      mockReloadedItems(5, 0);
      await receive(5);
      expect(lockCalls()).toHaveLength(1);
      expect(lockCalls()[0]).toContain(PO_ID);
      expect(lockedBeforeRead()).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('cancel and close lock the PO row before checking its status', async () => {
      mockPO('SENT');
      await new PurchaseOrderService().cancelPO(OUTLET, PO_ID, undefined);
      expect(lockCalls()).toHaveLength(1);
      expect(lockedBeforeRead()).toBe(true);
    });

    it('a receive that waited behind a cancel sees the cancel and adds no stock', async () => {
      // What the second request reads once the first (the cancel) has committed and released the lock
      mockPO('CANCELLED');
      await expect(receive(5)).rejects.toMatchObject({ code: 'PO_ALREADY_COMPLETED' });
      expect(prisma.stockBatch.create).not.toHaveBeenCalled();
      expect(prisma.stockLedgerEntry.create).not.toHaveBeenCalled();
    });

    it('a second receive that waited behind the first counts what the first already received', async () => {
      // First receive took 6 of 10; the second, also for 6, now reads 6 received and is refused
      mockPO('PARTIALLY_RECEIVED', [poItem({ receivedQuantity: dec(6) })]);
      await expect(receive(6)).rejects.toMatchObject({ code: 'RECEIVE_OVER_ORDER' });
      expect(prisma.stockBatch.create).not.toHaveBeenCalled();
    });

    it("a supplier's dispatch that waited behind a cancel is refused, so the order stays cancelled", async () => {
      (prisma.supplier.findFirst as jest.Mock).mockResolvedValue({ id: 'sup-1', userId: 'user-sup' });
      mockPO('CANCELLED');
      await expect(
        new PurchaseOrderService().updateSupplierPOStatus('user-sup', PO_ID, {
          status: 'DISPATCHED',
          items: [{ itemId: 'item-milk', dispatchedQuantity: 10 }],
        })
      ).rejects.toMatchObject({ code: 'PO_CLOSED' });
      expect(lockedBeforeRead()).toBe(true);
      expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
    });

    it('a malformed PO id is "not found" and never reaches the database', async () => {
      await expect(new PurchaseOrderService().cancelPO(OUTLET, 'not-a-uuid', undefined)).rejects.toMatchObject({
        code: 'PO_NOT_FOUND',
      });
      expect((prisma as any).$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('13b — close short', () => {
    it('closes a partially received order so the rest is no longer expected', async () => {
      mockPO('PARTIALLY_RECEIVED', [poItem({ receivedQuantity: dec(3) })]);
      const result: any = await new PurchaseOrderService().closePO(OUTLET, PO_ID, 'Rest out of stock at supplier');
      expect(result.status).toBe('CLOSED');
      expect(result.closedReason).toBe('Rest out of stock at supplier');
    });

    it('refuses to close an order where nothing was received (use cancel instead)', async () => {
      mockPO('SENT');
      await expect(new PurchaseOrderService().closePO(OUTLET, PO_ID, undefined)).rejects.toThrow('Use "Cancel order"');
    });

    it('refuses to close an order that is already completed', async () => {
      mockPO('RECEIVED', [poItem({ receivedQuantity: dec(10) })]);
      await expect(new PurchaseOrderService().closePO(OUTLET, PO_ID, undefined)).rejects.toThrow('already received');
    });
  });
});
