import { InventoryRepository } from '../src/modules/inventory/inventory.repository';
import { prisma } from '../src/config/prisma';
import { NO_MATCH_UUID } from '../src/utils/tenantScope';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    item: { findMany: jest.fn(), findFirst: jest.fn() },
    stockLedgerEntry: { groupBy: jest.fn() },
    stockBatch: { findMany: jest.fn() },
  },
}));

const whereOf = (mock: unknown) => (mock as jest.Mock).mock.calls[0][0].where;

describe('Inventory never reaches into other businesses', () => {
  const repo = new InventoryRepository();

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.item.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.stockLedgerEntry.groupBy as jest.Mock).mockResolvedValue([]);
    (prisma.stockBatch.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.item.findFirst as jest.Mock).mockResolvedValue(null);
  });

  describe('"All outlets" with no business (e.g. an owner whose login has no business yet, or a super admin)', () => {
    it('lists no stock items, instead of every business\'s', async () => {
      await repo.findManyItems('all', undefined);
      expect(whereOf(prisma.item.findMany)).toMatchObject({ outlet: { businessId: NO_MATCH_UUID } });
      expect(whereOf(prisma.stockLedgerEntry.groupBy)).toMatchObject({ outlet: { businessId: NO_MATCH_UUID } });
    });

    it('returns no low-stock or expiry alerts, instead of every business\'s', async () => {
      await repo.getLowStockAndExpiryAlerts('all', undefined);
      expect(whereOf(prisma.stockBatch.findMany)).toMatchObject({ outlet: { businessId: NO_MATCH_UUID } });
    });

    it('never looks up a SKU across all businesses', async () => {
      await repo.findItemBySku('all', 'MILK-1');
      expect(whereOf(prisma.item.findFirst)).toMatchObject({ sku: 'MILK-1', outlet: { businessId: NO_MATCH_UUID } });
    });
  });

  describe('normal use is unchanged', () => {
    it('"All outlets" for a business covers only that business', async () => {
      await repo.findManyItems('all', 'biz-1');
      expect(whereOf(prisma.item.findMany)).toMatchObject({ deletedAt: null, outlet: { businessId: 'biz-1' } });
      expect(whereOf(prisma.stockLedgerEntry.groupBy)).toEqual({ outlet: { businessId: 'biz-1' } });

      jest.clearAllMocks();
      (prisma.item.findMany as jest.Mock).mockResolvedValue([]);
      await repo.getLowStockAndExpiryAlerts('all', 'biz-1');
      expect(whereOf(prisma.stockBatch.findMany)).toMatchObject({ outlet: { businessId: 'biz-1' } });
    });

    it('one outlet covers only that outlet', async () => {
      await repo.findManyItems('outlet-1', 'biz-1');
      expect(whereOf(prisma.item.findMany)).toEqual({ outletId: 'outlet-1', deletedAt: null });
      expect(whereOf(prisma.stockLedgerEntry.groupBy)).toEqual({ outletId: 'outlet-1' });

      await repo.findItemBySku('outlet-1', 'MILK-1');
      expect(whereOf(prisma.item.findFirst)).toEqual({ sku: 'MILK-1', outletId: 'outlet-1', deletedAt: null });
    });
  });
});
