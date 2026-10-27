import { prisma } from '../../config/prisma';
import { Prisma } from '@prisma/client';
import { outletScope } from '../../utils/tenantScope';

export class InventoryRepository {
  /** `targetOutletId` must already be verified as belonging to the caller (see InventoryService.createItem). */
  async createItem(targetOutletId: string, data: any) {
    const { currentStock, outletId: _bodyOutletId, ...itemData } = data;

    return prisma.$transaction(async (tx) => {
      const item = await tx.item.create({
        data: {
          ...itemData,
          outletId: targetOutletId,
        },
      });

      if (currentStock && currentStock > 0) {
        await tx.stockLedgerEntry.create({
          data: {
            outletId: targetOutletId,
            itemId: item.id,
            change: new Prisma.Decimal(currentStock),
            reason: 'ADJUSTMENT',
          },
        });
      }

      return {
        ...item,
        reorderThreshold: item.reorderThreshold.toNumber(),
        currentStock: currentStock || 0,
      };
    });
  }

  async findItemById(outletId: string, id: string, businessId?: string | null) {
    // In "all outlets" mode, only items of the caller's own business
    return prisma.item.findFirst({
      where: { id, deletedAt: null, ...outletScope(outletId, businessId) },
    });
  }

  /** SKUs are unique per outlet. Without a real outlet this matches nothing, never a search of every business. */
  async findItemBySku(outletId: string, sku: string) {
    return prisma.item.findFirst({
      where: { sku, ...outletScope(outletId, undefined), deletedAt: null },
    });
  }

  async getStockBalance(itemId: string): Promise<number> {
    const aggregate = await prisma.stockLedgerEntry.aggregate({
      where: { itemId },
      _sum: {
        change: true,
      },
    });
    return aggregate._sum.change ? aggregate._sum.change.toNumber() : 0;
  }

  async createLedgerEntry(outletId: string, itemId: string, change: number, reason: 'SALE' | 'WASTE' | 'PURCHASE' | 'ADJUSTMENT', referenceId?: string) {
    let targetOutletId = outletId;
    if (!targetOutletId || targetOutletId === 'all') {
      const item = await prisma.item.findUnique({ where: { id: itemId }, select: { outletId: true } });
      if (item) targetOutletId = item.outletId;
    }
    return prisma.stockLedgerEntry.create({
      data: {
        outletId: targetOutletId,
        itemId,
        change: new Prisma.Decimal(change),
        reason,
        referenceId,
      },
    });
  }

  async findManyItems(outletId: string, businessId?: string) {
    // One outlet, or every outlet of the caller's business. "All outlets" without a business matches
    // nothing; it must never fall back to every business's stock.
    const itemWhere: Prisma.ItemWhereInput = { ...outletScope(outletId, businessId), deletedAt: null };
    const ledgerWhere: Prisma.StockLedgerEntryWhereInput = outletScope(outletId, businessId);

    const items = await prisma.item.findMany({
      where: itemWhere,
      include: { outlet: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const ledgerAggregates = await prisma.stockLedgerEntry.groupBy({
      by: ['itemId'],
      where: ledgerWhere,
      _sum: { change: true },
    });

    const stockMap = new Map<string, number>();
    for (const agg of ledgerAggregates) {
      stockMap.set(agg.itemId, agg._sum.change ? agg._sum.change.toNumber() : 0);
    }

    return items.map((item) => ({
      ...item,
      reorderThreshold: item.reorderThreshold.toNumber(),
      currentStock: stockMap.get(item.id) || 0,
    }));
  }

  async getLowStockAndExpiryAlerts(outletId: string, businessId?: string) {
    const items = await this.findManyItems(outletId, businessId);
    const lowStockItems = items.filter((item) => item.currentStock <= item.reorderThreshold);

    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const expiringBatches = await prisma.stockBatch.findMany({
      where: {
        ...outletScope(outletId, businessId),
        expiryDate: {
          lte: thirtyDaysFromNow,
        },
      },
      include: {
        item: true,
      },
      orderBy: {
        expiryDate: 'asc',
      },
    });

    return {
      lowStockItems,
      expiringBatches: expiringBatches.map((b) => ({
        ...b,
        quantity: b.quantity.toNumber(),
      })),
    };
  }
}
export default InventoryRepository;

