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
        unitCostAtLoggingPaise:
          log.unitCostAtLoggingPaise ??
          (qtyNum > 0 ? Math.round(log.costAtLoggingPaise / qtyNum) : 0),
        notes: log.notes ?? null,
        item: itemMap.get(log.itemId) || null,
      };
    });

    return { data: mappedData, total };
  }

  async getWasteSummary(outletId: string, businessId?: string) {
    const groupWhere = outletScope(outletId, businessId);
    const now = new Date();
    // The 1st of this month at midnight India time (the server clock is UTC, 5h30m behind)
    const { year, month } = businessParts(now);
    const startOfMonth = businessDayStart(year, month, 1);

    const aggregate = await prisma.wasteLog.groupBy({
      by: ['reason'],
      where: groupWhere,
      _sum: {
        quantity: true,
        costAtLoggingPaise: true,
      },
      _count: {
        id: true,
      },
    });

    const currentMonthWhere = { ...outletScope(outletId, businessId), createdAt: { gte: startOfMonth } };

    const currentMonthAggregate = await prisma.wasteLog.aggregate({
      where: currentMonthWhere,
      _sum: {
        costAtLoggingPaise: true,
      },
    });

    const currentMonthWastePaise = currentMonthAggregate._sum.costAtLoggingPaise || 0;

    const byReason = aggregate.map((group) => ({
      reason: group.reason,
      count: group._count.id,
      totalQuantity: group._sum.quantity ? group._sum.quantity.toNumber() : 0,
      totalCostPaise: group._sum.costAtLoggingPaise || 0,
    }));

    return {
      currentMonthWastePaise,
      byReason,
    };
  }
}
export default WasteRepository;

