import { WasteRepository } from './waste.repository';
import { AppError } from '../../utils/AppError';
import { prisma } from '../../config/prisma';
import { Prisma } from '@prisma/client';
import { outletScope } from '../../utils/tenantScope';
import { NotificationService } from '../notifications/notification.service';

export class WasteService {
  private wasteRepository = new WasteRepository();

  async createWasteLog(
    outletId: string,
    loggedById: string,
    data: {
      itemId: string;
      quantity: number;
      reason: 'SPOILAGE' | 'OVER_PREP' | 'RETURN' | 'ERROR';
      notes?: string;
    },
    businessId?: string | null
  ) {
    // 1. Item must belong to the selected outlet (or, in "all outlets" mode, to the caller's business)
    const item = await prisma.item.findFirst({
      where: {
        id: data.itemId,
        ...outletScope(outletId, businessId),
        deletedAt: null,
      },
    });
    if (!item) {
      throw new AppError('ITEM_NOT_FOUND', 'Inventory item not found', 404);
    }

    const targetOutletId = item.outletId;

    // 2. Validate current stock
    const ledgerSum = await prisma.stockLedgerEntry.aggregate({
      where: { itemId: data.itemId },
      _sum: { change: true },
    });
    const currentStock = ledgerSum._sum.change ? ledgerSum._sum.change.toNumber() : 0;

    if (currentStock < data.quantity) {
      throw new AppError(
        'INSUFFICIENT_STOCK',
        `Insufficient stock for item ${item.name} to log waste. Current stock: ${currentStock}, Waste quantity: ${data.quantity}`,
        400
      );
    }

    // 3. Authoritative Moving Weighted Average Cost
    const unitCostAtLoggingPaise = item.unitCostPaise;
    const costAtLoggingPaise = Math.round(data.quantity * unitCostAtLoggingPaise);

    // 4. Transaction to create waste log and ledger entries using real targetOutletId
    const wasteLog = await prisma.$transaction(async (tx) => {
      const log = await tx.wasteLog.create({
        data: {
          itemId: data.itemId,
          quantity: new Prisma.Decimal(data.quantity),
          unitCostAtLoggingPaise,
          costAtLoggingPaise,
          reason: data.reason,
          notes: data.notes?.trim() || null,
          loggedById,
          outletId: targetOutletId,
        },
      });

      await tx.stockLedgerEntry.create({
        data: {
          outletId: targetOutletId,
          itemId: data.itemId,
          change: new Prisma.Decimal(-data.quantity),
          reason: 'WASTE',
          referenceId: log.id,
        },
      });

      return log;
    });

    // 5. High-waste alert for loss >= ₹500 (50,000 paise)
    if (costAtLoggingPaise >= 50000) {
      // Find businessId if not passed in
      let resolvedBusinessId = businessId;
      if (!resolvedBusinessId) {
        const outlet = await prisma.outlet.findUnique({
          where: { id: targetOutletId },
          select: { businessId: true },
        });
        resolvedBusinessId = outlet?.businessId;
      }

      NotificationService.notifyHighWasteLogged({
        id: wasteLog.id,
        itemName: item.name,
        quantity: data.quantity,
        costPaise: costAtLoggingPaise,
        outletId: targetOutletId,
        businessId: resolvedBusinessId || undefined,
      }).catch(() => {});
    }

    return wasteLog;
  }

  async getWasteLogs(outletId: string, limit: number, offset: number, businessId?: string) {
    return this.wasteRepository.findMany(outletId, limit, offset, businessId);
  }

  async getWasteSummary(outletId: string, businessId?: string) {
    return this.wasteRepository.getWasteSummary(outletId, businessId);
  }
}
export default WasteService;
