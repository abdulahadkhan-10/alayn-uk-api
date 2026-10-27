import { InventoryRepository } from './inventory.repository';
import { AppError } from '../../utils/AppError';
import { prisma } from '../../config/prisma';
import { Prisma } from '@prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { EmployeeActor, assertOutletsAccessible } from '../employees/employee.permissions';
import { isAllOutlets, outletScope } from '../../utils/tenantScope';
import { computeMovingAverageCost } from './costing.utils';

export class InventoryService {
  private inventoryRepository = new InventoryRepository();

  async createItem(outletId: string, data: any, actor: EmployeeActor) {
    // A stock item always belongs to one specific outlet of the caller — never "some outlet in the database"
    const targetOutletId: string | undefined = data.outletId || (isAllOutlets(outletId) ? undefined : outletId);
    if (!targetOutletId || isAllOutlets(targetOutletId)) {
      throw new AppError('OUTLET_REQUIRED', 'Please choose the branch this item belongs to.', 400);
    }
    await assertOutletsAccessible(actor, [targetOutletId]);

    const existing = await this.inventoryRepository.findItemBySku(targetOutletId, data.sku);
    if (existing) {
      throw new AppError('SKU_ALREADY_EXISTS', 'An item with this SKU already exists', 400);
    }
    return this.inventoryRepository.createItem(targetOutletId, data);
  }

  async getItemStock(outletId: string, itemId: string, businessId?: string | null) {
    const item = await this.inventoryRepository.findItemById(outletId, itemId, businessId);
    if (!item) {
      throw new AppError('ITEM_NOT_FOUND', 'Inventory item not found', 404);
    }
    const balance = await this.inventoryRepository.getStockBalance(itemId);
    return {
      itemId,
      name: item.name,
      sku: item.sku,
      currentStock: balance,
      unit: item.unit,
    };
  }

  async adjustStock(
    outletId: string,
    itemId: string,
    change: number,
    reason: 'SALE' | 'WASTE' | 'PURCHASE' | 'ADJUSTMENT',
    referenceId?: string,
    loggedById?: string,
    businessId?: string | null,
    unitCostPaise?: number
  ) {
    const item = await this.inventoryRepository.findItemById(outletId, itemId, businessId);
    if (!item) {
      throw new AppError('ITEM_NOT_FOUND', 'Inventory item not found', 404);
    }

    // Business of the item's own outlet (for notifications)
    const targetOutlet = await prisma.outlet.findUnique({
      where: { id: item.outletId },
      select: { businessId: true },
    });
    const itemBusinessId = targetOutlet?.businessId;

    // If change is negative (deduction), check current stock
    if (change < 0) {
      const currentStock = await this.inventoryRepository.getStockBalance(itemId);
      if (currentStock + change < 0) {
        throw new AppError('INSUFFICIENT_STOCK', `Insufficient stock for ${item.name}. Current: ${currentStock}, Requested deduction: ${Math.abs(change)}`, 400);
      }
    }

    let result: any;

    if (reason === 'WASTE' && change < 0) {
      const wasteQty = Math.abs(change);
      const unitCostAtLoggingPaise = item.unitCostPaise;
      const costAtLoggingPaise = Math.round(wasteQty * unitCostAtLoggingPaise);
      
      let userId = loggedById;
      if (!userId) {
        const fallbackUser = await prisma.user.findFirst();
        userId = fallbackUser?.id || "00000000-0000-0000-0000-000000000000";
      }

      result = await prisma.$transaction(async (tx) => {
        const wasteLog = await tx.wasteLog.create({
          data: {
            itemId,
            quantity: new Prisma.Decimal(wasteQty),
            unitCostAtLoggingPaise,
            costAtLoggingPaise,
            reason: 'SPOILAGE',
            outletId: item.outletId,
            loggedById: userId,
          },
        });

        // Trigger high waste notification if loss is >= ₹500 (50,000 paise)
        if (costAtLoggingPaise >= 50000) {
          NotificationService.notifyHighWasteLogged({
            id: wasteLog.id,
            itemName: item.name,
            quantity: wasteQty,
            costPaise: costAtLoggingPaise,
            outletId: item.outletId,
            businessId: itemBusinessId,
          }).catch(() => {});
        }

        return tx.stockLedgerEntry.create({
          data: {
            outletId: item.outletId,
            itemId,
            change: new Prisma.Decimal(change),
            reason: 'WASTE',
            referenceId: wasteLog.id,
          },
        });
      });
    } else if (change > 0 && typeof unitCostPaise === 'number' && unitCostPaise > 0) {
      // Re-calculate Moving Weighted Average Cost (WAC) upon positive stock addition
      const currentStock = await this.inventoryRepository.getStockBalance(itemId);
      const newCostPaise = computeMovingAverageCost({
        currentStock,
        currentUnitCostPaise: item.unitCostPaise,
        incomingQty: change,
        incomingUnitCostPaise: unitCostPaise,
      });

      result = await prisma.$transaction(async (tx) => {
        if (newCostPaise !== item.unitCostPaise) {
          await tx.item.update({
            where: { id: itemId },
            data: { unitCostPaise: newCostPaise },
          });
        }

        return tx.stockLedgerEntry.create({
          data: {
            outletId: item.outletId,
            itemId,
            change: new Prisma.Decimal(change),
            reason,
            referenceId,
          },
        });
      });
    } else {
      // Standard ledger entry
      result = await this.inventoryRepository.createLedgerEntry(item.outletId, itemId, change, reason, referenceId);
    }

    // Check post-adjustment stock balance for low stock alert
    const newStock = await this.inventoryRepository.getStockBalance(itemId);
    const threshold = item.reorderThreshold.toNumber();
    if (newStock <= threshold) {
      NotificationService.notifyStockAlert({
        id: itemId,
        itemName: item.name,
        type: 'LOW_STOCK',
        message: `Low stock alert for ${item.name}! Current stock is ${newStock} ${item.unit} (Threshold: ${threshold} ${item.unit}).`,
        outletId: item.outletId,
        businessId: itemBusinessId,
      }).catch(() => {});
    }

    return result;
  }


  /**
   * Saves a stock count. Each counted item gets a COUNT ledger entry that sets its stock to the counted
   * amount (an entry is written even when nothing changed: it records that the item was counted, which
   * is what usage, run-out dates and food cost are measured from).
   */
  async recordCount(outletId: string, counts: { itemId: string; counted: number }[], businessId?: string | null) {
    const ids = [...new Set(counts.map((c) => c.itemId))];
    const items = await prisma.item.findMany({
      where: { id: { in: ids }, deletedAt: null, ...outletScope(outletId, businessId) },
      select: { id: true, name: true, unit: true, outletId: true },
    });
    if (items.length !== ids.length) {
      throw new AppError('ITEM_NOT_FOUND', 'Some of these stock items were not found in this branch.', 404);
    }
    const balances = await prisma.stockLedgerEntry.groupBy({
      by: ['itemId'],
      where: { itemId: { in: ids } },
      _sum: { change: true },
    });
    const before = new Map(balances.map((b) => [b.itemId, b._sum.change?.toNumber() ?? 0]));
    const counted = new Map(counts.map((c) => [c.itemId, c.counted])); // the last entry wins for repeats

    const rows = items.map((item) => {
      const was = before.get(item.id) ?? 0;
      const now = counted.get(item.id)!;
      return { item, was, now, difference: +(now - was).toFixed(4) };
    });
    await prisma.$transaction(
      rows.map((r) =>
        prisma.stockLedgerEntry.create({
          data: { outletId: r.item.outletId, itemId: r.item.id, change: new Prisma.Decimal(r.difference), reason: 'COUNT' },
        }),
      ),
    );
    return {
      counted: rows.length,
      items: rows.map((r) => ({ itemId: r.item.id, name: r.item.name, unit: r.item.unit, expected: r.was, counted: r.now, difference: r.difference })),
    };
  }

  async getAllItems(outletId: string, businessId?: string) {
    const items = await this.inventoryRepository.findManyItems(outletId, businessId);
    return { items, total: items.length };
  }

  async getAlerts(outletId: string, businessId?: string) {
    return this.inventoryRepository.getLowStockAndExpiryAlerts(outletId, businessId);
  }
}
export default InventoryService;

