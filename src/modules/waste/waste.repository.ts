import { prisma } from '../../config/prisma';
import { outletScope } from '../../utils/tenantScope';
import { businessDayStart, businessParts } from '../../utils/outletTime';

export class WasteRepository {
  async findMany(outletId: string, limit: number, offset: number, businessId?: string) {
    const where = outletScope(outletId, businessId);

    const [data, total] = await Promise.all([
      prisma.wasteLog.findMany({
        where,
        include: { outlet: { select: { id: true, name: true } } },
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.wasteLog.count({ where }),
    ]);

    // Fetch items for the waste logs
    const itemIds = Array.from(new Set(data.map((log) => log.itemId)));
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      include: { outlet: { select: { id: true, name: true } } },
    });
    const itemMap = new Map(items.map((i) => [i.id, i]));

    const mappedData = data.map((log) => {
      const qtyNum = log.quantity.toNumber();
      return {
        ...log,
        quantity: qtyNum,
        unitCostAtLoggingPence:
          log.unitCostAtLoggingPence ??
          (qtyNum > 0 ? Math.round(log.costAtLoggingPence / qtyNum) : 0),
        notes: log.notes ?? null,
        item: itemMap.get(log.itemId) || null,
      };
    });

    return { data: mappedData, total };
  }

  async getWasteSummary(outletId: string, businessId?: string) {
    const groupWhere = outletScope(outletId, businessId);
    const now = new Date();
    // The 1st of this month at midnight UK time (the server clock is UTC)
    const { year, month } = businessParts(now);
    const startOfMonth = businessDayStart(year, month, 1);

    const aggregate = await prisma.wasteLog.groupBy({
      by: ['reason'],
      where: groupWhere,
      _sum: {
        quantity: true,
        costAtLoggingPence: true,
      },
      _count: {
        id: true,
      },
    });

    const currentMonthWhere = { ...outletScope(outletId, businessId), createdAt: { gte: startOfMonth } };

    const currentMonthAggregate = await prisma.wasteLog.aggregate({
      where: currentMonthWhere,
      _sum: {
        costAtLoggingPence: true,
      },
    });

    const currentMonthWastePence = currentMonthAggregate._sum.costAtLoggingPence || 0;

    const byReason = aggregate.map((group) => ({
      reason: group.reason,
      count: group._count.id,
      totalQuantity: group._sum.quantity ? group._sum.quantity.toNumber() : 0,
      totalCostPence: group._sum.costAtLoggingPence || 0,
    }));

    return {
      currentMonthWastePence,
      byReason,
    };
  }
}
export default WasteRepository;

