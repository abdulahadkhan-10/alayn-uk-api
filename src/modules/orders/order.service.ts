import { OrderRepository } from './order.repository';
import { AppError } from '../../utils/AppError';
import { prisma } from '../../config/prisma';
import { Prisma } from '@prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { outletDateKey, outletStartOfDay } from '../../utils/outletTime';
import { outletScope } from '../../utils/tenantScope';
import { BillRates, BillTotals, calculateBill, isDineIn } from './billing';
import { priceItemWithModifiers } from './modifierPricing';
import {
  SettlementPaymentInput,
  confirmedPaidPaise,
  describePayments,
  formatRupees,
  isOnlineMethod,
  summarizePayments,
  validateSettlementPayments,
} from './splitPayment';

type DecimalLike = { toNumber: () => number } | number | null | undefined;
const toRate = (value: DecimalLike, fallback = 0) =>
  value === null || value === undefined ? fallback : typeof value === 'number' ? value : value.toNumber();

/** The outlet's currently configured rates (service charge % is stored in the historical serviceTaxRateDecimal column). */
function outletBillRates(outlet: { cgstRateDecimal: DecimalLike; sgstRateDecimal: DecimalLike; serviceTaxRateDecimal?: DecimalLike }): BillRates {
  return {
    cgstRate: toRate(outlet.cgstRateDecimal),
    sgstRate: toRate(outlet.sgstRateDecimal),
    serviceChargeRate: toRate(outlet.serviceTaxRateDecimal),
  };
}

/** Bill amounts + the configured rate snapshot, in Order column names. */
function billToOrderFields(bill: BillTotals, rates: BillRates) {
  return {
    subtotalPaise: bill.subtotalPaise,
    discountPaise: bill.discountPaise,
    serviceTaxPaise: bill.serviceChargePaise,
    cgstPaise: bill.cgstPaise,
    sgstPaise: bill.sgstPaise,
    taxPaise: bill.cgstPaise + bill.sgstPaise + bill.serviceChargePaise,
    roundOffPaise: bill.roundOffPaise,
    totalPaise: bill.totalPaise,
    cgstRate: new Prisma.Decimal(rates.cgstRate),
    sgstRate: new Prisma.Decimal(rates.sgstRate),
    serviceChargeRate: new Prisma.Decimal(rates.serviceChargeRate),
  };
}

/** "Dum Biryani (Half)": the menu name plus the chosen variant, as the removal was punched */
function removalItemName(item: { menuItem?: { name?: string } | null; modifiersJson?: string | null }): string {
  const name = item.menuItem?.name || 'Item';
  try {
    const mods = item.modifiersJson ? JSON.parse(item.modifiersJson) : [];
    const variant = Array.isArray(mods) ? mods.find((m: any) => m?.isVariant)?.name : undefined;
    return variant ? `${name} (${variant})` : name;
  } catch {
    return name;
  }
}

const ORDER_INCLUDE = {
  items: { include: { menuItem: true } },
  statusHistory: true,
  payments: true,
  outlet: true,
} as const;

export class OrderService {
  private orderRepository = new OrderRepository();

  /**
   * Recalculate a bill from ALL its items using the rates snapshotted on the order (so a settings change
   * mid-service never splits a bill). Called after every change to the bill and once more at settlement.
   */
  async recalculateOrder(orderId: string, tx: Prisma.TransactionClient = prisma) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true, outlet: true },
    });
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }

    // Older bills created before rate snapshots existed take the outlet's current rates once
    const configured = outletBillRates(order.outlet);
    const rates: BillRates = {
      cgstRate: toRate(order.cgstRate, configured.cgstRate),
      sgstRate: toRate(order.sgstRate, configured.sgstRate),
      serviceChargeRate: toRate(order.serviceChargeRate, configured.serviceChargeRate),
    };

    const billableItems = order.items.filter((item) => item.status !== 'CANCELLED');
    const bill = calculateBill(billableItems, rates, {
      dineIn: isDineIn(order.source),
      serviceChargeWaived: order.serviceChargeWaived,
      discountPaise: order.discountPaise,
      gstRegistrationType: order.outlet.gstRegistrationType,
    });

    return tx.order.update({
      where: { id: orderId },
      data: billToOrderFields(bill, rates),
      include: ORDER_INCLUDE,
    });
  }

  /**
   * A UPI UTR / card approval code identifies one transaction, so seeing it on a second bill usually means
   * a typo or the same customer payment being counted twice. Stops the settle unless the cashier confirms.
   */
  private async assertReferencesUnused(
    tx: Prisma.TransactionClient,
    payments: { method: string; reference: string | null }[],
    orderId: string,
    outletId: string
  ) {
    const seen = new Set<string>();
    for (const p of payments) {
      if (!p.reference) continue;
      const label = p.method === 'CARD' ? 'Card approval code' : `${p.method} reference`;
      const key = `${p.method}:${p.reference}`;
      if (seen.has(key)) {
        throw new AppError(
          'DUPLICATE_PAYMENT_REFERENCE',
          `${label} ${p.reference} is entered on two payments of this bill. Check it, or settle anyway if it is correct.`,
          409
        );
      }
      seen.add(key);

      const earlier = await tx.payment.findFirst({
        where: {
          method: p.method as any,
          reference: p.reference,
          status: 'CONFIRMED',
          orderId: { not: orderId },
          order: { outletId },
        },
        select: { amountPaise: true, order: { select: { orderNumber: true } } },
      });
      if (earlier) {
        const bill = earlier.order?.orderNumber ? `bill #${earlier.order.orderNumber}` : 'another bill';
        throw new AppError(
          'DUPLICATE_PAYMENT_REFERENCE',
          `${label} ${p.reference} was already used on ${bill} (${formatRupees(earlier.amountPaise)}). Check it, or settle anyway if it is correct.`,
          409
        );
      }
    }
  }

  /**
   * Remove (or restore) the service charge on an open dine-in bill. Service charge is voluntary in India
   * (CCPA guidelines, upheld by the Delhi High Court in 2025): the customer may ask for it to be removed.
   */
  async setServiceChargeWaiver(
    outletId: string,
    orderId: string,
    waive: boolean,
    reason: string | undefined,
    changedById: string,
    businessId?: string | null
  ) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null, ...outletScope(outletId, businessId) },
    });
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    if (order.status === 'COMPLETED' || order.status === 'CANCELLED') {
      throw new AppError('BILL_CLOSED', 'This bill is already closed and can no longer be changed.', 400);
    }
    if (!isDineIn(order.source)) {
      throw new AppError('NOT_DINE_IN', 'Service charge only applies to dine-in orders.', 400);
    }
    const trimmedReason = reason?.trim();
    if (waive && !trimmedReason) {
      throw new AppError('VALIDATION_ERROR', 'Please give a reason for removing the service charge.', 400);
    }

    await prisma.order.update({
      where: { id: orderId },
      data: {
        serviceChargeWaived: waive,
        serviceChargeWaivedById: waive ? changedById : null,
        serviceChargeWaiveReason: waive ? trimmedReason : null,
        statusHistory: {
          create: {
            status: order.status,
            changedById,
            comment: waive ? `Service charge removed: ${trimmedReason}` : 'Service charge restored',
          },
        },
      },
    });

    return this.transformOrder(await this.recalculateOrder(orderId));
  }

  private async generateCustomOrderId(outletId: string): Promise<string> {
    // Only ever called with the specific outlet the order belongs to (validated in createOrder)
    const outlet = await prisma.outlet.findUnique({
      where: { id: outletId },
      include: { business: true },
    });

    const restaurantName = outlet?.name || outlet?.business?.name || 'ALAYN';
    const prefix = restaurantName.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X');

    // Date and daily sequence use India time, so numbering restarts at local midnight (not 5:30 AM)
    const now = new Date();
    const dateKey = outletDateKey(now);

    // Count today's orders for this outlet to generate atomic sequential number
    const todayStart = outletStartOfDay(now);
    const countToday = await prisma.order.count({
      where: {
        outletId,
        createdAt: { gte: todayStart },
      },
    });

    let seqNum = countToday + 1;
    let candidate = `${prefix}${dateKey}${String(seqNum).padStart(4, '0')}`;

    // Increment sequentially if there is a collision to guarantee clean, elegant order IDs
    while (true) {
      const existing = await prisma.order.findFirst({
        where: { orderNumber: candidate },
        select: { id: true },
      });
      if (!existing) {
        break;
      }
      seqNum++;
      candidate = `${prefix}${dateKey}${String(seqNum).padStart(4, '0')}`;
    }

    return candidate;
  }


  async createOrder(
    outletId: string,
    data: { tableNumber?: number | string; tableNo?: number | string; source?: 'TABLE' | 'COUNTER' | 'QR' | 'DELIVERY'; orderSource?: 'TABLE' | 'COUNTER' | 'QR' | 'DELIVERY'; tableToken?: string; items: { menuItemId: string; quantity: number; notes?: string }[] },
    user?: { id?: string; name?: string; role?: string }
  ) {
    const isUuid = (id: string) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
    // An order always belongs to one specific outlet — never fall back to "some outlet in the database"
    if (!isUuid(outletId)) {
      throw new AppError('OUTLET_REQUIRED', 'Please select a specific branch before placing an order.', 400);
    }
    // 1. Fetch Outlet tax rates
    const outlet = await prisma.outlet.findFirst({
      where: { id: outletId, deletedAt: null },
    });
    if (!outlet) {
      throw new AppError('OUTLET_NOT_FOUND', 'Outlet not found', 404);
    }

    const resolvedSource = data.source || data.orderSource || 'COUNTER';
    const rawTable = data.tableNumber ?? data.tableNo;
    let resolvedTableNumber = typeof rawTable === 'number' ? rawTable : (typeof rawTable === 'string' ? parseInt(rawTable, 10) || undefined : undefined);

    if (resolvedSource === 'TABLE' && !resolvedTableNumber) {
      throw new AppError('TABLE_NUMBER_REQUIRED', 'Please select a table number for table orders', 400);
    }

    // Validate QR ordering TableToken if provided
    if (data.source === 'QR' && data.tableToken) {
      const tokenRecord = await prisma.tableToken.findUnique({
        where: { token: data.tableToken },
      });

      if (!tokenRecord) {
        throw new AppError('INVALID_TOKEN', 'Table token is invalid', 400);
      }

      if (new Date() > tokenRecord.expiresAt) {
        throw new AppError('EXPIRED_TOKEN', 'Table token has expired', 400);
      }

      if (tokenRecord.outletId !== outletId) {
        throw new AppError('FORBIDDEN', 'Table token belongs to a different outlet', 403);
      }

      resolvedTableNumber = tokenRecord.tableNumber;
    }

    // A diner ordering from the table QR (table-token auth, see order.routes). Their phone is never trusted
    // with payment, discounts or coupons. Ordering records no payment at all: the diner says how they'll pay
    // once, for the whole bill, when they ask for it (requestTableBill). Older pages that still send a
    // payment method with each round (they picked UPI by default) are ignored, so they can't flag a bill
    // as "UPI to verify" when nobody paid.
    const isCustomerOrder = data.source === 'QR' && !!data.tableToken;

    // Check if outlet permits direct customer ordering via QR
    if (resolvedSource === 'QR' && (outlet as any).tableOrderMode === 'WAITER_SERVICE') {
      throw new AppError(
        'ORDER_MODE_NOT_ALLOWED',
        'Direct online ordering is disabled for this restaurant. Please place your order directly with your waiter.',
        400
      );
    }

    // 2. Fetch all menu items to price the incoming items
    const itemDetails: {
      menuItemId: string;
      quantity: number;
      unitPricePaise: number;
      subtotalPaise: number;
      notes?: string;
      modifiersJson?: string | null;
    }[] = [];

    for (const item of data.items) {
      const menuItem = await prisma.menuItem.findFirst({
        where: { id: item.menuItemId, deletedAt: null },
        include: {
          outlets: {
            where: { outletId }
          },
          modifierGroups: {
            where: { modifierGroup: { isActive: true, deletedAt: null } },
            orderBy: { sortOrder: 'asc' },
            include: {
              modifierGroup: {
                include: {
                  modifiers: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
                },
              },
            },
          },
        }
      });
      if (!menuItem || menuItem.outlets.length === 0) {
        throw new AppError('MENU_ITEM_NOT_FOUND', `Menu item ${item.menuItemId} not found or not assigned to this outlet`, 404);
      }
      const isItemActive = menuItem.isActive && menuItem.outlets[0].isActive;
      if (!isItemActive) {
        throw new AppError('MENU_ITEM_INACTIVE', `Menu item ${menuItem.name} is inactive`, 400);
      }

      // Price from the database only: the client just names the options it picked
      const incomingModifiers = (item as any).modifiers || (item as any).selectedModifiers || [];
      const selectedModifierIds: string[] = incomingModifiers.map((m: any) => m.id).filter(Boolean);
      if (selectedModifierIds.length !== incomingModifiers.length) {
        throw new AppError('MODIFIER_NOT_AVAILABLE', `An add-on chosen for ${menuItem.name} is not recognised`, 400);
      }
      const priced = priceItemWithModifiers(
        menuItem,
        menuItem.modifierGroups.map((link) => link.modifierGroup),
        selectedModifierIds,
      );
      const effectiveUnitPrice = priced.unitPricePaise;
      const modifiersSnapshot = priced.modifiers;

      itemDetails.push({
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        unitPricePaise: effectiveUnitPrice,
        subtotalPaise: effectiveUnitPrice * item.quantity,
        notes: item.notes,
        modifiersJson: modifiersSnapshot.length > 0 ? JSON.stringify(modifiersSnapshot) : null,
      });
    }

    // 3. Price a new bill with the outlet's current rates (snapshotted on the order)
    const rawDiscount = isCustomerOrder ? undefined : (data as any).discountAmount;
    const discountPaise = isCustomerOrder ? 0 : (data as any).discountPaise ?? (rawDiscount ? Math.round(rawDiscount * 100) : 0);
    const couponCode = !isCustomerOrder && (data as any).couponCode ? String((data as any).couponCode).trim().toUpperCase() : undefined;
    const couponId = isCustomerOrder ? undefined : (data as any).couponId || undefined;

    const rates = outletBillRates(outlet);
    const bill = calculateBill(itemDetails, rates, {
      dineIn: isDineIn(resolvedSource),
      discountPaise,
      gstRegistrationType: outlet.gstRegistrationType,
    });

    // How the diner says they paid lives on their payment record (method, amount, UTR), not in this name
    const placedByName = isCustomerOrder ? 'Customer (QR)' : user?.name || (resolvedSource === 'QR' ? 'Customer (QR)' : 'Staff');
    const placedByRole = isCustomerOrder ? 'QR' : user?.role || (resolvedSource === 'QR' ? 'QR' : 'STAFF');

    // The order, its items and its payment are saved together: a failure part-way leaves nothing behind
    const saved = await this.withOrderNumberRetry(() =>
      prisma.$transaction(async (tx) => {
        if (resolvedTableNumber) {
          // Marking the table occupied first locks its row, so two first orders from one table at the same
          // moment can't both open a bill: the second waits, then finds the first and joins it
          await tx.table.updateMany({
            where: { outletId, tableNumber: resolvedTableNumber },
            data: { status: 'OCCUPIED' },
          });

          const activeOrder = await tx.order.findFirst({
            where: {
              outletId,
              tableNumber: resolvedTableNumber,
              status: { notIn: ['COMPLETED', 'CANCELLED'] },
              deletedAt: null,
            },
          });

          if (activeOrder) {
            // New round (KOT) on the table's running bill: add the items, then recalculate the WHOLE bill
            await this.orderRepository.appendItemsToOrder(activeOrder.id, itemDetails, tx);
            await this.recalculateOrder(activeOrder.id, tx);
            return { order: await tx.order.findUnique({ where: { id: activeOrder.id }, include: ORDER_INCLUDE }), isNew: false };
          }
        }

        // Generate custom order number (e.g. ALA2026072200001) for new order
        const orderNumber = await this.generateCustomOrderId(outletId);
        const createdOrder = await this.orderRepository.createOrder(
          outletId,
          {
            orderNumber,
            tableNumber: resolvedTableNumber,
            source: resolvedSource,
            status: 'SENT_TO_KITCHEN',
            ...billToOrderFields(bill, rates),
            placedByName,
            placedByRole,
            customerName: (data as any).customerName,
            customerPhone: (data as any).customerPhone,
            couponId,
            couponCode,
            items: itemDetails,
          },
          tx
        );

        if (couponId) {
          // updateMany: a coupon deleted in the meantime must not fail the order
          await tx.restaurantCoupon.updateMany({
            where: { id: couponId },
            data: { usageCount: { increment: 1 } },
          });
        }

        if (!isCustomerOrder && (data as any).paymentMethod) {
          // Staff checkout that recorded its payment while placing the order
          await tx.payment.create({
            data: {
              orderId: createdOrder.id,
              amountPaise: createdOrder.totalPaise,
              method: (data as any).paymentMethod,
              status: (data as any).paymentStatus || 'PENDING',
            },
          });
        }

        return { order: await tx.order.findUnique({ where: { id: createdOrder.id }, include: ORDER_INCLUDE }), isNew: true };
      }, { maxWait: 10000, timeout: 15000 })
    );

    if (saved.isNew && saved.order) {
      // Trigger real-time notifications to Kitchen, Manager, and Staff
      NotificationService.notifyOrderPlaced({
        id: saved.order.id,
        orderNumber: saved.order.orderNumber,
        totalPaise: saved.order.totalPaise,
        outletId: saved.order.outletId,
        businessId: outlet.businessId,
      }).catch(() => { });
    }

    return this.transformOrder(saved.order);
  }

  /** Two orders placed at the same moment can pick the same daily number: the one that loses retries with the next */
  private async withOrderNumberRetry<T>(save: () => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await save();
      } catch (err) {
        const isNumberClash =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          String(err.meta?.target ?? '').includes('orderNumber');
        if (!isNumberClash || attempt >= attempts) throw err;
      }
    }
  }

  public transformOrder(order: any) {
    if (!order) return order;
    const formattedOrderNo = order.orderNumber || `#${order.id.slice(0, 8).toUpperCase()}`;
    return {
      ...order,
      branchName: order.outlet?.name || order.outletId,
      orderNo: formattedOrderNo,
      orderNumber: formattedOrderNo,
      orderSource: order.source,
      tableNo: order.tableNumber !== null && order.tableNumber !== undefined ? String(order.tableNumber) : undefined,
      subtotal: (order.subtotalPaise || 0) / 100,
      taxAmount: (order.taxPaise || 0) / 100,
      cgstAmount: (order.cgstPaise || 0) / 100,
      sgstAmount: (order.sgstPaise || 0) / 100,
      serviceTaxAmount: (order.serviceTaxPaise || 0) / 100, // kept for older screens
      serviceChargeAmount: (order.serviceTaxPaise || 0) / 100,
      discountAmount: (order.discountPaise || 0) / 100,
      couponCode: order.couponCode || null,
      couponId: order.couponId || null,
      roundOffAmount: (order.roundOffPaise || 0) / 100,
      totalAmount: (order.totalPaise || 0) / 100,
      // Rates used on THIS bill (null on bills created before snapshots existed)
      cgstRate: order.cgstRate !== null && order.cgstRate !== undefined ? Number(order.cgstRate) : null,
      sgstRate: order.sgstRate !== null && order.sgstRate !== undefined ? Number(order.sgstRate) : null,
      serviceChargeRate:
        order.serviceChargeRate !== null && order.serviceChargeRate !== undefined ? Number(order.serviceChargeRate) : null,
      serviceChargeWaived: !!order.serviceChargeWaived,
      serviceChargeWaiveReason: order.serviceChargeWaiveReason || null,
      isDineIn: isDineIn(order.source),
      gstRegistrationType: order.outlet?.gstRegistrationType || 'REGULAR',
      placedByName: order.placedByName || (order.source === 'QR' ? 'Customer (QR)' : 'Staff'),
      placedByRole: order.placedByRole || (order.source === 'QR' ? 'QR' : 'STAFF'),
      // paymentMethod, paymentStatus, paymentSplits, paidAmount, balanceDue
      ...summarizePayments(order.payments || [], order.totalPaise || 0),
      items: (order.items || []).map((item: any) => ({
        ...item,
        unitPrice: (item.unitPricePaise || 0) / 100,
        subtotal: (item.subtotalPaise || 0) / 100,
        modifiers: item.modifiers || (item.modifiersJson ? (() => {
          try { return typeof item.modifiersJson === 'string' ? JSON.parse(item.modifiersJson) : item.modifiersJson; } catch { return []; }
        })() : []),
      })),
      orderItems: (order.items || []).map((item: any) => ({
        ...item,
        unitPrice: (item.unitPricePaise || 0) / 100,
        subtotal: (item.subtotalPaise || 0) / 100,
        modifiers: item.modifiers || (item.modifiersJson ? (() => {
          try { return typeof item.modifiersJson === 'string' ? JSON.parse(item.modifiersJson) : item.modifiersJson; } catch { return []; }
        })() : []),
      })),
    };
  }

  async getOrders(
    outletId: string,
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
    const orders = await this.orderRepository.findOrders(outletId, status, filters);
    return (await this.withSettledBy(orders)).map((o) => this.transformOrder(o));
  }

  /**
   * Adds `settledByName`: the staff member who settled the bill, printed as the cashier on the receipt.
   * (placedByName is who took the order, e.g. "Customer (QR)" for a table-QR order, so it can't be used.)
   */
  private async withSettledBy<T extends { statusHistory?: { status: string; changedById: string | null }[] }>(
    orders: T[],
    client: Prisma.TransactionClient = prisma
  ): Promise<(T & { settledByName: string | null })[]> {
    const settledById = (order: T) =>
      order.statusHistory?.filter((h) => h.status === 'COMPLETED' && h.changedById).pop()?.changedById ?? null;
    const ids = [...new Set(orders.map(settledById).filter((id): id is string => !!id))];
    const users = ids.length > 0 ? await client.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return orders.map((order) => ({ ...order, settledByName: names.get(settledById(order) ?? '') ?? null }));
  }

  async getKitchenOrders(outletId: string, businessId?: string) {
    const orders = await this.orderRepository.findKitchenOrders(outletId, businessId);
    return orders.map((o) => this.transformOrder(o));
  }

  async createPayment(
    outletId: string,
    orderId: string,
    data: { amountPaise: number; method: 'UPI' | 'CARD' | 'CASH'; status: 'PENDING' | 'CONFIRMED' | 'FAILED' },
    businessId?: string | null
  ) {
    const order = await this.orderRepository.findOrderById(outletId, orderId, businessId);
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    if (order.status === 'CANCELLED') {
      throw new AppError('INVALID_STATE_TRANSITION', 'Cannot record payment for a cancelled order', 400);
    }
    return this.orderRepository.createPayment(orderId, data.amountPaise, data.method, data.status);
  }

  async updateOrderStatus(
    outletId: string,
    orderId: string,
    status: 'SENT_TO_KITCHEN' | 'PREPARING' | 'READY' | 'SERVED' | 'DISPATCHED' | 'COMPLETED' | 'CANCELLED',
    comment?: string,
    changedById?: string,
    paymentMethod?: 'CASH' | 'CARD' | 'UPI' | 'SWIGGY' | 'ZOMATO' | 'EAZYDINER',
    customerName?: string,
    customerPhone?: string,
    businessId?: string | null,
    userRole?: string,
    couponData?: {
      couponCode?: string;
      couponId?: string;
      discountAmount?: number;
      discountPaise?: number;
    },
    settlement?: {
      payments?: SettlementPaymentInput[];
      idempotencyKey?: string;
      allowDuplicateReference?: boolean;
    }
  ) {
    const order = await this.orderRepository.findOrderById(outletId, orderId, businessId);
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }

    // A retried settle request (lost response, double tap) gets the settled bill back instead of an error
    const settlementKey = settlement?.idempotencyKey;
    if (status === 'COMPLETED' && settlementKey && order.status === 'COMPLETED' && order.settlementKey === settlementKey) {
      return this.transformOrder(order);
    }

    // Basic state transitions checks
    const current = order.status;
    if (current === 'COMPLETED' || current === 'CANCELLED') {
      throw new AppError('INVALID_STATE_TRANSITION', `Cannot change status of a ${current} order`, 400);
    }

    if (status === 'CANCELLED') {
      // 1. Anti-fraud check: Only a Manager or Business Owner is authorized to void / cancel an order
      if (userRole && !['BUSINESS_OWNER', 'MANAGER', 'SUPER_ADMIN'].includes(userRole)) {
        throw new AppError(
          'FORBIDDEN',
          'Only a Manager or Business Owner is authorized to cancel an order.',
          403
        );
      }

      // 2. Anti-fraud check: Prevent cancelling an order that already has recorded confirmed payments
      const hasConfirmedPayments = order.payments?.some((p) => p.status === 'CONFIRMED');
      if (hasConfirmedPayments) {
        throw new AppError(
          'ORDER_ALREADY_PAID',
          'This order has recorded payments and cannot be cancelled directly.',
          400
        );
      }
    }

    if (status === 'COMPLETED') {
      let appliedCouponId: string | null = null;
      const rawCode = couponData?.couponCode?.trim().toUpperCase();
      let discountPaise = couponData?.discountPaise ?? (couponData?.discountAmount ? Math.round(couponData.discountAmount * 100) : null);
      let couponId = couponData?.couponId || null;

      if (rawCode) {
        const coupon = await prisma.restaurantCoupon.findFirst({
          where: {
            businessId: order.outlet.businessId,
            code: rawCode,
            isActive: true,
          },
        });
        if (coupon) {
          couponId = coupon.id;
          appliedCouponId = coupon.id;
          if (discountPaise == null) {
            if (coupon.discountType === 'PERCENTAGE') {
              const rate = Number(coupon.discountValue);
              discountPaise = Math.round((order.subtotalPaise * rate) / 100);
              if (coupon.maxDiscountPaise != null) {
                discountPaise = Math.min(discountPaise, coupon.maxDiscountPaise);
              }
            } else {
              discountPaise = Math.round(Number(coupon.discountValue) * 100);
            }
            discountPaise = Math.min(discountPaise, order.subtotalPaise);
          }
        }
      }

      const splitPayments = settlement?.payments;

      // Everything below commits together: a rejected payment leaves the open bill exactly as it was
      return prisma.$transaction(async (tx) => {
        // Claim the bill first. The conditional update takes the row lock, so of two simultaneous settle
        // requests only one gets past here; the other sees count 0 and records no payments.
        const claimed = await tx.order.updateMany({
          where: { id: orderId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          data: {
            status: 'COMPLETED',
            settlementKey: settlementKey || null,
            ...(discountPaise != null || rawCode || couponId
              ? { discountPaise: discountPaise ?? order.discountPaise, couponCode: rawCode || null, couponId: couponId || null }
              : {}),
            ...(customerName ? { customerName } : {}),
            ...(customerPhone ? { customerPhone } : {}),
          },
        });
        if (claimed.count === 0) {
          const latest = await tx.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
          if (latest && settlementKey && latest.settlementKey === settlementKey) {
            return this.transformOrder(latest);
          }
          throw new AppError('ALREADY_SETTLED', 'This bill was already settled or cancelled on another device.', 409);
        }

        // 0. Final bill calculation — after settlement the bill is frozen
        const finalBill = await this.recalculateOrder(orderId, tx);
        const balanceDuePaise = finalBill.totalPaise - confirmedPaidPaise(finalBill.payments);

        // Pending intents (POS checkout choice, QR "pay at counter") are replaced by what was actually taken
        await tx.payment.updateMany({
          where: { orderId, status: 'PENDING' },
          data: { status: 'VOID' },
        });

        // 1. Record the payments that settle the balance
        let paymentNote: string | undefined;
        if (splitPayments) {
          const toRecord = validateSettlementPayments(splitPayments, balanceDuePaise);
          if (!settlement?.allowDuplicateReference) {
            await this.assertReferencesUnused(tx, toRecord, orderId, order.outletId);
          }
          const verifiedAt = new Date();
          for (const p of toRecord) {
            await tx.payment.create({
              data: {
                orderId,
                amountPaise: p.amountPaise,
                method: p.method,
                status: 'CONFIRMED',
                reference: p.reference,
                ...(p.isOnline ? { verifiedById: changedById || null, verifiedAt } : {}),
              },
            });
          }
          paymentNote = `Paid ${describePayments(toRecord)}`;
        } else if (balanceDuePaise > 0) {
          // Single payment (original flow): the whole remaining balance in one method
          let method: 'CASH' | 'CARD' | 'UPI' | 'SWIGGY' | 'ZOMATO' | 'EAZYDINER' = paymentMethod || 'CASH';
          if (!paymentMethod && comment) {
            const methodCandidate = comment.toUpperCase();
            if (methodCandidate.includes('CARD')) method = 'CARD';
            else if (methodCandidate.includes('UPI')) method = 'UPI';
            else if (methodCandidate.includes('SWIGGY')) method = 'SWIGGY';
            else if (methodCandidate.includes('ZOMATO')) method = 'ZOMATO';
            else if (methodCandidate.includes('EAZYDINER')) method = 'EAZYDINER';
          }

          // UPI / card money lands outside the till, so it is only recorded once the cashier confirms it
          // arrived: those settle through `payments` with verified: true (who and when are saved there)
          if (isOnlineMethod(method)) {
            throw new AppError(
              'PAYMENT_NOT_VERIFIED',
              `Confirm the ${method === 'UPI' ? 'UPI' : 'card'} payment of ${formatRupees(balanceDuePaise)} was received before settling.`,
              400
            );
          }

          await tx.payment.create({
            data: { orderId, amountPaise: balanceDuePaise, method, status: 'CONFIRMED' },
          });
        }

        // 2. Release Table back to AVAILABLE (menu items are not linked to stock, so inventory is untouched)
        if (order.tableNumber !== null && order.tableNumber !== undefined) {
          const targetOutletId = order.outletId || outletId;
          if (targetOutletId && targetOutletId !== 'all') {
            await tx.table.updateMany({
              where: { outletId: targetOutletId, tableNumber: order.tableNumber },
              data: { status: 'AVAILABLE' },
            });
          }
        }

        // Add history entry
        await tx.orderStatusHistory.create({
          data: {
            orderId,
            status: 'COMPLETED',
            changedById,
            comment: paymentNote
              ? `Order completed and table freed — ${paymentNote}`
              : comment || 'Order completed, payment settled, and table freed',
          },
        });

        // Increment coupon usage count if coupon was applied
        if (appliedCouponId) {
          await tx.restaurantCoupon.update({
            where: { id: appliedCouponId },
            data: { usageCount: { increment: 1 } },
          }).catch(() => {});
        }

        // Same shape as every other order response — the final bill is printed from this, so
        // items must carry their menu item (name) just like the pre-bill does
        const settled = await tx.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
        return this.transformOrder(settled && (await this.withSettledBy([settled], tx))[0]);
      }, { maxWait: 10000, timeout: 15000 });
    }

    // Free table if order is cancelled
    if (status === 'CANCELLED' && order.tableNumber !== null && order.tableNumber !== undefined) {
      const targetOutletId = order.outletId || outletId;
      if (targetOutletId && targetOutletId !== 'all') {
        await prisma.table.updateMany({
          where: { outletId: targetOutletId, tableNumber: order.tableNumber },
          data: { status: 'AVAILABLE' },
        });
      }
    }

    // Normal status transition (not COMPLETED)
    if (status === 'PREPARING') {
      await (prisma.orderItem as any).updateMany({
        where: { orderId, status: 'SENT_TO_KITCHEN' },
        data: { status: 'PREPARING' },
      });
    } else if (status === 'READY') {
      await (prisma.orderItem as any).updateMany({
        where: { orderId, status: 'PREPARING' },
        data: { status: 'READY' },
      });
    } else if (status === 'SERVED') {
      await (prisma.orderItem as any).updateMany({
        where: { orderId, status: 'READY' },
        data: { status: 'SERVED' },
      });
    }

    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: status as any,
        ...(customerName ? { customerName } : {}),
        ...(customerPhone ? { customerPhone } : {}),
      },
    });

    await this.orderRepository.addStatusHistory(orderId, status, changedById, comment);

    const updated = await this.orderRepository.findOrderById(outletId, orderId, businessId);

    if (status === 'READY') {
      NotificationService.notifyOrderReady({
        id: order.id,
        orderNumber: order.orderNumber,
        tableNumber: order.tableNumber,
        outletId: order.outletId,
      }).catch(() => { });
    }

    return this.transformOrder(updated);
  }

  async cancelOrderItem(
    outletId: string,
    orderId: string,
    itemId: string,
    cancelQuantity?: number,
    reason?: string,
    removedBy?: { id: string; name: string; role: string },
    businessId?: string | null
  ) {
    const order = await this.orderRepository.findOrderById(outletId, orderId, businessId);
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }

    if (order.status === 'COMPLETED' || order.status === 'CANCELLED') {
      throw new AppError(
        'ORDER_FINALIZED',
        `Cannot cancel items on an order that is already ${order.status.toLowerCase()}.`,
        400
      );
    }

    // Money already taken would then exceed the bill, and there is no refund step: same rule as cancelling an order
    const hasConfirmedPayments = order.payments?.some((p: any) => p.status === 'CONFIRMED');
    if (hasConfirmedPayments) {
      throw new AppError(
        'ORDER_ALREADY_PAID',
        'A payment has already been recorded on this bill, so items cannot be removed.',
        400
      );
    }

    const item = (order.items || []).find((i: any) => i.id === itemId);
    if (!item) {
      throw new AppError('ITEM_NOT_FOUND', 'Item not found on this order', 404);
    }

    if (item.status === 'CANCELLED') {
      throw new AppError('ITEM_ALREADY_CANCELLED', 'This item has already been cancelled from the bill.', 400);
    }

    const activeItems = (order.items || []).filter((i: any) => i.status !== 'CANCELLED');
    const isSingleActiveItem = activeItems.length === 1 && activeItems[0].id === itemId;
    const qtyToCancel = cancelQuantity && cancelQuantity > 0 && cancelQuantity < item.quantity
      ? cancelQuantity
      : item.quantity;

    if (isSingleActiveItem && qtyToCancel >= item.quantity) {
      throw new AppError(
        'CANNOT_EMPTY_ORDER',
        'Cannot remove the only item on the bill. Please cancel the entire order instead.',
        400
      );
    }

    const remainingQty = item.quantity - qtyToCancel;
    const itemName = item.menuItem?.name || 'Item';
    const auditComment = `Removed ${qtyToCancel}x ${itemName} · Reason: ${reason || 'Punched by mistake'}`;

    const cancelledAt = new Date();

    await prisma.$transaction(async (tx) => {
      // Only applies if the item is still as we read it, so two devices removing at once can't both succeed
      const unchanged = { id: itemId, quantity: item.quantity, status: item.status };
      const { count } = remainingQty === 0
        ? await tx.orderItem.updateMany({
          where: unchanged,
          data: {
            status: 'CANCELLED',
            cancelledQuantity: { increment: qtyToCancel },
            cancelledAt,
            cancelledFromStatus: item.status,
          },
        })
        : await tx.orderItem.updateMany({
          where: unchanged,
          data: {
            quantity: remainingQty,
            subtotalPaise: remainingQty * item.unitPricePaise,
            cancelledQuantity: { increment: qtyToCancel },
            cancelledAt,
          },
        });
      if (count === 0) {
        throw new AppError(
          'ITEM_CHANGED',
          'This item was just changed on another device. Please refresh and try again.',
          409
        );
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          status: order.status as any,
          changedById: removedBy?.id || null,
          comment: auditComment,
        },
      });

      await tx.orderItemRemoval.create({
        data: {
          orderId,
          orderItemId: itemId,
          outletId: order.outletId,
          itemName: removalItemName(item),
          quantity: qtyToCancel,
          amountPaise: qtyToCancel * item.unitPricePaise,
          reason: reason || 'Punched by mistake',
          itemStage: item.status,
          removedById: removedBy?.id || null,
          removedByName: removedBy?.name || 'Unknown',
          removedByRole: removedBy?.role || 'UNKNOWN',
        },
      });

      await this.recalculateOrder(orderId, tx);
    });

    const updated = await this.orderRepository.findOrderById(outletId, orderId, businessId);
    return this.transformOrder(updated);
  }

  async getTableMenu(token: string) {
    const tokenRecord = await prisma.tableToken.findUnique({
      where: { token },
      include: {
        outlet: {
          include: { business: true }
        }
      }
    });
    if (!tokenRecord) {
      throw new AppError('INVALID_TOKEN', 'Table token is invalid', 400);
    }
    if (new Date() > tokenRecord.expiresAt) {
      throw new AppError('EXPIRED_TOKEN', 'Table token has expired', 400);
    }

    const categories = await prisma.menuCategory.findMany({
      where: {
        outletId: tokenRecord.outletId,
        isActive: true,
        deletedAt: null,
      },
      include: {
        menuItems: {
          where: {
            isActive: true,
            deletedAt: null,
            // Same rule as order creation: the item must be assigned to THIS outlet and not marked
            // unavailable here (Menu Manager's per-branch "Unavailable" toggle sets MenuItemOutlet.isActive)
            outlets: {
              some: {
                outletId: tokenRecord.outletId,
                isActive: true,
              },
            },
          },
          include: {
            modifierGroups: {
              where: { modifierGroup: { isActive: true, deletedAt: null } },
              orderBy: { sortOrder: 'asc' },
              include: {
                modifierGroup: {
                  include: {
                    modifiers: {
                      where: { isActive: true },
                      orderBy: { sortOrder: 'asc' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const transformedCategories = categories
      .map((cat) => ({
        ...cat,
        menuItems: cat.menuItems.map((item) => ({
          ...item,
          modifierGroups: (item.modifierGroups || []).map((rel) => rel.modifierGroup),
        })),
      }))
      .filter((category) => category.menuItems.length > 0);

    return {
      businessName: tokenRecord.outlet?.business?.name || 'Alayn Dining',
      outletName: tokenRecord.outlet?.name,
      outletId: tokenRecord.outletId,
      tableNumber: tokenRecord.tableNumber,
      tableOrderMode: (tokenRecord.outlet as any)?.tableOrderMode || 'WAITER_SERVICE',
      allowPayAtCounter: (tokenRecord.outlet as any)?.allowPayAtCounter ?? true,
      upiId: tokenRecord.outlet?.upiId,
      currency: 'INR',
      taxRates: {
        cgstRate: Number(tokenRecord.outlet?.cgstRateDecimal ?? 2.5),
        sgstRate: Number(tokenRecord.outlet?.sgstRateDecimal ?? 2.5),
        serviceChargeRate: Number(tokenRecord.outlet?.serviceTaxRateDecimal ?? 0),
        gstRegistrationType: tokenRecord.outlet?.gstRegistrationType ?? 'REGULAR',
      },
      // Don't show category tabs that have nothing orderable right now
      categories: transformedCategories,
    };
  }

  private async findTableToken(token: string) {
    const tokenRecord = await prisma.tableToken.findUnique({
      where: { token },
      include: { outlet: true },
    });
    if (!tokenRecord) {
      throw new AppError('INVALID_TOKEN', 'Table token is invalid', 400);
    }
    if (new Date() > tokenRecord.expiresAt) {
      throw new AppError('EXPIRED_TOKEN', 'Table token has expired', 400);
    }
    return tokenRecord;
  }

  async getActiveTableOrder(token: string) {
    const tokenRecord = await this.findTableToken(token);

    const activeOrder = await prisma.order.findFirst({
      where: {
        outletId: tokenRecord.outletId,
        tableNumber: tokenRecord.tableNumber,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
        deletedAt: null,
      },
      include: {
        items: {
          include: {
            menuItem: true,
          },
        },
        payments: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return activeOrder ? this.transformOrder(activeOrder) : null;
  }

  /**
   * The diner is done and asks for the bill from the table QR, saying how they'll pay: UPI from their phone
   * (with the UTR if they have it), or card / cash at the counter. Recorded as one PENDING payment for the
   * whole amount due, replacing any earlier choice, and the floor staff are alerted to print the bill and
   * collect. Nothing is marked paid: the cashier confirms the money when settling.
   */
  async requestTableBill(token: string, data: { paymentMethod: 'UPI' | 'CARD' | 'CASH'; paymentRef?: string }) {
    const tokenRecord = await this.findTableToken(token);
    const outlet = tokenRecord.outlet as any;
    if (data.paymentMethod !== 'UPI' && outlet?.allowPayAtCounter === false) {
      throw new AppError('PAY_AT_COUNTER_DISABLED', 'This restaurant takes payment by UPI from your phone only.', 400);
    }
    if (data.paymentMethod === 'UPI' && !outlet?.upiId) {
      throw new AppError('UPI_NOT_AVAILABLE', 'This restaurant has not set up UPI payments. Please pay at the counter.', 400);
    }
    const reference = data.paymentMethod === 'UPI' && data.paymentRef ? data.paymentRef.trim().slice(0, 64) || null : null;

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: {
          outletId: tokenRecord.outletId,
          tableNumber: tokenRecord.tableNumber,
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
          deletedAt: null,
        },
        include: { payments: true },
        orderBy: { createdAt: 'desc' },
      });
      if (!order) {
        throw new AppError('NO_ACTIVE_ORDER', 'There is no open bill on this table.', 404);
      }

      const duePaise = order.totalPaise - confirmedPaidPaise(order.payments);
      if (duePaise > 0) {
        // The diner's latest choice replaces what they (or the till) said before
        await tx.payment.updateMany({
          where: { orderId: order.id, status: 'PENDING' },
          data: { status: 'VOID' },
        });
        await tx.payment.create({
          data: { orderId: order.id, amountPaise: duePaise, method: data.paymentMethod, status: 'PENDING', reference },
        });
      }

      const updated = await tx.order.findUnique({
        where: { id: order.id },
        include: { items: { include: { menuItem: true } }, payments: true },
      });
      return { order: updated, duePaise };
    });

    if (result.order && result.duePaise > 0) {
      NotificationService.notifyBillRequested({
        id: result.order.id,
        orderNumber: result.order.orderNumber,
        tableNumber: result.order.tableNumber,
        outletId: result.order.outletId,
        businessId: outlet?.businessId,
        amountPaise: result.duePaise,
        method: data.paymentMethod,
        reference,
      }).catch(() => { });
    }

    return this.transformOrder(result.order);
  }
}
export default OrderService;
