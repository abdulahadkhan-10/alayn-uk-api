import { prisma } from '../../config/prisma';
import { Prisma } from '@prisma/client';
import { outletScope } from '../../utils/tenantScope';
import { ONE_DAY_MS, businessDayStart, businessStartOfDay } from '../../utils/outletTime';
import { PaymentMethodCode } from './splitPayment';

/** Start (5 AM UK time) of the business day for a "YYYY-MM-DD" string; other formats use the instant's business day. */
function businessStartOfDateString(dateStr: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (match) return businessDayStart(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return businessStartOfDay(new Date(dateStr));
}

export class OrderRepository {
  async createOrder(outletId: string, data: {
    orderNumber?: string;
    tableNumber?: number;
    source: 'TABLE' | 'COUNTER' | 'QR' | 'DELIVERY';
    status: 'SENT_TO_KITCHEN';
    subtotalPence: number;
    vatPence: number;
    serviceTaxPence?: number;
    taxPence: number;
    totalPence: number;
    discountPence?: number;
    roundOffPence?: number;
    vatRate?: Prisma.Decimal;
    serviceChargeRate?: Prisma.Decimal;
    placedByName?: string;
    placedByRole?: string;
    customerName?: string;
    customerPhone?: string;
    couponId?: string;
    couponCode?: string;
    items: { menuItemId: string; quantity: number; unitPricePence: number; subtotalPence: number; notes?: string }[];
  }, client: Prisma.TransactionClient = prisma) {
    const orderData = {
      outletId,
      orderNumber: data.orderNumber,
      tableNumber: isNaN(data.tableNumber as number) ? null : data.tableNumber,
      source: data.source,
      status: data.status as any,
      subtotalPence: data.subtotalPence,
      vatPence: data.vatPence,
      serviceTaxPence: data.serviceTaxPence || 0,
      taxPence: data.taxPence,
      totalPence: data.totalPence,
      discountPence: data.discountPence || 0,
      roundOffPence: data.roundOffPence || 0,
      vatRate: data.vatRate,
      serviceChargeRate: data.serviceChargeRate,
      placedByName: data.placedByName,
      placedByRole: data.placedByRole,
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      couponId: data.couponId || null,
      couponCode: data.couponCode || null,
      items: {
        create: data.items.map(item => ({
          menuItemId: item.menuItemId,
          quantity: item.quantity,
          unitPricePence: item.unitPricePence,
          subtotalPence: item.subtotalPence,
          notes: item.notes,
          modifiersJson: (item as any).modifiersJson || null,
        })),
      },
      statusHistory: {
        create: {
          status: 'SENT_TO_KITCHEN' as any,
          comment: 'Order created and sent to kitchen',
        },
      },
    };

    const order = await client.order.create({
      data: orderData as any,
      include: {
        items: {
          include: {
            menuItem: true,
          },
        },
        statusHistory: true,
      },
    });

    return order;
  }

  /**
   * Adds a new round (KOT) of items to a running bill. Does NOT touch the bill amounts — the caller
   * recalculates the whole bill from all items afterwards (OrderService.recalculateOrder).
   */
  async appendItemsToOrder(
    activeOrderId: string,
    newItems: { menuItemId: string; quantity: number; unitPricePence: number; subtotalPence: number; notes?: string; modifiersJson?: string | null }[],
    client: Prisma.TransactionClient = prisma
  ) {
    const existingOrder = await client.order.findUnique({
      where: { id: activeOrderId },
      include: { items: true },
    });

    if (!existingOrder) throw new Error("Order not found");

    const maxKotNo = existingOrder.items.reduce((max: number, item: any) => Math.max(max, item.kotNo || 1), 1);
    const nextKotNo = maxKotNo + 1;

    for (const newItem of newItems) {
      await (client.orderItem as any).create({
        data: {
          orderId: activeOrderId,
          menuItemId: newItem.menuItemId,
          quantity: newItem.quantity,
          unitPricePence: newItem.unitPricePence,
          subtotalPence: newItem.subtotalPence,
          notes: newItem.notes,
          modifiersJson: newItem.modifiersJson || null,
          status: 'SENT_TO_KITCHEN',
          kotNo: nextKotNo,
        },
      });
    }

    const updatedOrder = await client.order.update({
      where: { id: activeOrderId },
      data: {
        status: 'SENT_TO_KITCHEN' as any,
        statusHistory: {
          create: {
            status: 'SENT_TO_KITCHEN' as any,
            comment: `Added ${newItems.reduce((acc, i) => acc + i.quantity, 0)} new item(s) to table order`,
          },
        },
      },
      include: {
        items: {
          include: {
            menuItem: true,
          },
        },
        statusHistory: true,
      },
    });

    return updatedOrder;
  }

  async findOrderById(outletId: string, id: string, businessId?: string | null) {
    // In "all outlets" mode, only orders of the caller's own business
    const where = { id, deletedAt: null, ...outletScope(outletId, businessId) };
    return prisma.order.findFirst({
      where,
      include: {
        items: {
          include: {
            menuItem: true,
          },
        },
        payments: true,
        statusHistory: true,
        outlet: true,
      },
    });
  }

  async findOrders(
    outletId?: string,
    status?: string,
    filters?: {
      excludeCompleted?: boolean;
      startDate?: string;
      endDate?: string;
      placedByName?: string;
      source?: string;
      paymentMethod?: string;
      businessId?: string;
    }
  ) {
    const isAll = !outletId || outletId === 'all';
    const where: any = { deletedAt: null };
    if (!isAll) {
      where.outletId = outletId;
    } else if (filters?.businessId) {
      where.outlet = { businessId: filters.businessId };
    }
    if (status && status !== 'ALL') {
      where.status = status;
    } else if (filters?.excludeCompleted) {
      where.status = { not: 'COMPLETED' };
    }

    if (filters?.source && filters.source !== 'ALL') {
      where.source = filters.source;
    }

    if (filters?.placedByName) {
      where.placedByName = { contains: filters.placedByName, mode: 'insensitive' };
    }

    if (filters?.startDate || filters?.endDate) {
      where.createdAt = {};
      // Business days (5 AM to 5 AM UK time), like reports: the end date includes that night after midnight
      if (filters.startDate) {
        where.createdAt.gte = businessStartOfDateString(filters.startDate);
      }
      if (filters.endDate) {
        where.createdAt.lte = new Date(businessStartOfDateString(filters.endDate).getTime() + ONE_DAY_MS - 1);
      }
    }

    if (filters?.paymentMethod && filters.paymentMethod !== 'ALL') {
      // Money actually taken in this method — a split bill matches each method it was paid with
      where.payments = {
        some: {
          method: filters.paymentMethod,
          status: 'CONFIRMED',
        },
      };
    }

    return prisma.order.findMany({
      where,
      include: {
        items: {
          include: {
            menuItem: true,
          },
        },
        payments: true,
        statusHistory: true,
        outlet: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findKitchenOrders(outletId: string, businessId?: string) {
    const isAll = !outletId || outletId === 'all';
    // Retain cancelled orders on kitchen screens for 5 minutes
    const cancelCutoff = new Date(Date.now() - 5 * 60 * 1000);

    const statusCondition = {
      OR: [
        { status: { in: ['SENT_TO_KITCHEN', 'PREPARING', 'READY'] as any } },
        {
          status: 'CANCELLED' as any,
          updatedAt: { gte: cancelCutoff },
        },
      ],
    };

    const where: any = isAll
      ? { ...statusCondition, deletedAt: null }
      : { outletId, ...statusCondition, deletedAt: null };

    if (isAll && businessId) {
      where.outlet = { businessId };
    }

    return prisma.order.findMany({
      where,
      include: {
        items: {
          include: {
            menuItem: true,
          },
        },
        statusHistory: true,
        outlet: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  async createPayment(orderId: string, amountPence: number, method: PaymentMethodCode, status: 'PENDING' | 'CONFIRMED' | 'FAILED') {
    return prisma.payment.create({
      data: {
        orderId,
        amountPence,
        method,
        status,
      },
    });
  }

  async addStatusHistory(orderId: string, status: any, changedById?: string, comment?: string) {
    return prisma.orderStatusHistory.create({
      data: {
        orderId,
        status,
        changedById,
        comment,
      },
    });
  }
}
export default OrderRepository;
