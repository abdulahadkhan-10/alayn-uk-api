import bcrypt from 'bcrypt';
import { PurchaseOrderRepository } from './purchaseOrder.repository';
import { AppError } from '../../utils/AppError';
import { prisma } from '../../config/prisma';
import { Prisma, POStatus } from '@prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { NO_MATCH_UUID } from '../../utils/tenantScope';
import { normalizeEmail } from '../../utils/identity';
import { generateTemporaryPassword } from '../../utils/password';
import { generatePONumber } from '../../utils/poNumber';
import { DOCUMENT_NUMBER_TX_OPTIONS } from '../../utils/documentNumber';


// Statuses after which a PO can no longer be received, cancelled or closed
const FINAL_PO_STATUSES: POStatus[] = ['RECEIVED', 'CLOSED', 'CANCELLED'];

/**
 * Every change to an existing PO (supplier status, receive, cancel, close) runs in a transaction that
 * first row-locks the PO, then re-reads it and checks its status. Two people acting on the same PO at
 * the same moment are therefore handled one after the other: the second waits a few milliseconds and
 * sees what the first did (e.g. "already cancelled"), instead of both acting on a stale copy.
 * Other POs are never blocked.
 */
async function lockPO(tx: Prisma.TransactionClient, poId: string): Promise<void> {
  // The id comes straight from the URL; a malformed one is "not found", not a database cast error
  if (!UUID_PATTERN.test(poId)) {
    throw new AppError('PO_NOT_FOUND', 'Purchase order not found', 404);
  }
  await tx.$queryRaw`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${poId}::uuid FOR UPDATE`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wait up to 10 s for a busy PO instead of Prisma's 2 s default. */
const PO_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

function decimalToNumber(value: { toNumber: () => number } | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : value.toNumber();
}

/** A unique-constraint violation on `field` (Prisma P2002). */
function isUniqueClash(err: unknown, field: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    String(err.meta?.target ?? '').includes(field)
  );
}

/** Has anything on this PO arrived yet, accepted or rejected as damaged? */
function anythingReceived(po: { items: { receivedQuantity: Prisma.Decimal; damagedQuantity: Prisma.Decimal | null }[] }): boolean {
  return po.items.some((i) => i.receivedQuantity.toNumber() > 0 || decimalToNumber(i.damagedQuantity) > 0);
}

function parseValidExpiryDate(inputDate?: any): Date {
  const fallback = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  if (!inputDate) return fallback;
  const parsed = new Date(inputDate);
  if (isNaN(parsed.getTime())) return fallback;
  return parsed;
}

export class PurchaseOrderService {
  private poRepository = new PurchaseOrderRepository();

  async createSupplier(outletId: string, businessId: string | undefined, data: any) {
    const { type = 'OFFLINE', password, name, contactPerson, phone, address, category, outletId: overrideOutletId } = data;
    const email = typeof data.email === 'string' && data.email.trim() ? normalizeEmail(data.email) : data.email;

    let targetOutletId = overrideOutletId || outletId;
    if (!targetOutletId || targetOutletId === 'all') {
      const firstOutlet = await prisma.outlet.findFirst({
        where: {
          businessId: businessId || NO_MATCH_UUID,
          deletedAt: null,
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!firstOutlet) {
        throw new AppError('OUTLET_NOT_FOUND', 'No valid outlet found under your business for supplier registration', 400);
      }
      targetOutletId = firstOutlet.id;
    }

    const outlet = await prisma.outlet.findFirst({
      where: {
        id: targetOutletId,
        businessId: businessId || NO_MATCH_UUID,
        deletedAt: null,
      },
    });
    if (!outlet) {
      throw new AppError('OUTLET_NOT_FOUND', 'Target outlet not found or does not belong to your business', 404);
    }

    if (type === 'ONLINE') {
      if (!email) {
        throw new AppError('EMAIL_REQUIRED', 'Email is required for ONLINE supplier account registration', 400);
      }

      const existingUser = await prisma.user.findUnique({
        where: { email },
      });
      if (existingUser) {
        throw new AppError('EMAIL_ALREADY_EXISTS', 'A user with this email already exists', 409);
      }

      // No shared default: when the owner does not choose one, a random password is generated and
      // returned once (as initialPassword) so it can be handed to the supplier.
      const rawPassword = password || generateTemporaryPassword();
      const passwordHash = await bcrypt.hash(rawPassword, 12);

      return prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email,
            passwordHash,
            name: name || contactPerson,
            role: 'SUPPLIER',
            phoneNo: phone || '',
            businessId: outlet.businessId,
          },
        });

        const supplier = await tx.supplier.create({
          data: {
            name,
            contactPerson,
            phone,
            email,
            address,
            category,
            type: 'ONLINE',
            userId: user.id,
            outletId: targetOutletId,
          },
          include: {
            user: { select: { id: true, email: true, name: true, role: true } },
            outlet: { select: { id: true, name: true } },
          },
        });

        return {
          ...supplier,
          initialPassword: password ? undefined : rawPassword,
        };
      });
    }

    return this.poRepository.createSupplier(targetOutletId, {
      name,
      contactPerson,
      phone,
      email,
      address,
      category,
      type: 'OFFLINE',
    });
  }

  async getSuppliers(outletId: string, businessId?: string) {
    return this.poRepository.findSuppliers(outletId, businessId);
  }

  async deleteSupplier(outletId: string, id: string, businessId?: string | null) {
    const supplier = await this.poRepository.findSupplierById(outletId, id, businessId);
    if (!supplier) {
      throw new AppError('SUPPLIER_NOT_FOUND', 'Supplier not found', 404);
    }
    return this.poRepository.deleteSupplier(outletId, id);
  }

  async updateSupplier(outletId: string, id: string, data: any, businessId?: string | null) {
    const supplier = await this.poRepository.findSupplierById(outletId, id, businessId);
    if (!supplier) {
      throw new AppError('SUPPLIER_NOT_FOUND', 'Supplier not found', 404);
    }
    // Only contact details can be edited — never which outlet or login account the supplier belongs to
    const { name, contactPerson, phone, email, address, category } = data || {};
    const editable = Object.fromEntries(
      Object.entries({ name, contactPerson, phone, email, address, category }).filter(([, v]) => v !== undefined)
    );
    return this.poRepository.updateSupplier(outletId, id, editable);
  }

  async getPurchaseOrders(outletId: string, businessId?: string) {
    return this.poRepository.findPOs(outletId, businessId);
  }

  async createPO(
    outletId: string,
    supplierId: string,
    items: { itemId: string; orderedQuantity: number; unitCostPence: number }[],
    businessId?: string | null,
    clientRequestId?: string
  ) {
    // The same attempt sent again (double-click, retry after a lost reply): return the PO it already made
    if (clientRequestId) {
      const existing = await this.poRepository.findPOByClientRequestId(outletId, clientRequestId, businessId);
      if (existing) return existing;
    }

    const supplier = await this.poRepository.findOrderableSupplier(outletId, supplierId, businessId);
    if (!supplier) {
      throw new AppError('SUPPLIER_NOT_FOUND', 'Supplier not found', 404);
    }

    let targetOutletId: string | null = outletId;
    if (!targetOutletId || targetOutletId === 'all') {
      targetOutletId = supplier.outletId;
    }

    if (!targetOutletId) {
      throw new AppError('OUTLET_REQUIRED', 'An outlet must be specified to create a purchase order', 400);
    }

    if (businessId) {
      const ownedOutlet = await prisma.outlet.findFirst({
        where: { id: targetOutletId, businessId, deletedAt: null },
        select: { id: true },
      });
      if (!ownedOutlet) {
        throw new AppError('FORBIDDEN', 'Select a valid branch of your business before creating a purchase order.', 403);
      }
    }

    let totalAmountPence = 0;
    for (const item of items) {
      // Stock items must belong to the outlet receiving the delivery
      const itemRecord = await prisma.item.findFirst({
        where: { id: item.itemId, outletId: targetOutletId, deletedAt: null },
      });
      if (!itemRecord) {
        throw new AppError(
          'ITEM_NOT_FOUND',
          `This stock item isn't stocked at the supplier's branch. Pick a supplier from the same branch as the item.`,
          404
        );
      }
      totalAmountPence += Math.round(item.orderedQuantity * item.unitCostPence);
    }

    // Number and order are created together: if the insert fails, the PO number is released
    const outletForPO = targetOutletId;
    let updatedPO;
    try {
      updatedPO = await prisma.$transaction(
        async (tx) => {
          const poNumber = await generatePONumber(tx, outletForPO);
          return this.poRepository.createPO(outletForPO, supplierId, poNumber, totalAmountPence, items, clientRequestId, tx);
        },
        DOCUMENT_NUMBER_TX_OPTIONS
      );
    } catch (err) {
      // Two copies of the same attempt arrived at the same instant: both passed the check above, the
      // database let only one save. Hand the other one that PO (its own number was released on rollback).
      if (clientRequestId && isUniqueClash(err, 'clientRequestId')) {
        const winner = await this.poRepository.findPOByClientRequestId(outletId, clientRequestId, businessId);
        if (winner) return winner;
        throw new AppError('DUPLICATE_REQUEST', 'This request was already used. Refresh and try again.', 409);
      }
      throw err;
    }

    NotificationService.notifyPOStatusChanged({
      id: updatedPO.id,
      poNumber: updatedPO.poNumber,
      supplierId: updatedPO.supplierId,
      supplierUserId: updatedPO.actualSupplier?.userId,
      status: 'SENT',
      totalAmountPence: updatedPO.totalAmountPence,
      outletId: updatedPO.outletId,
    }).catch(() => {});

    return updatedPO;
  }

  // --- Supplier Portal Methods ---

  async getSupplierPortalOrders(userId: string) {
    const supplier = await this.poRepository.findSupplierByUserId(userId);
    if (!supplier) {
      throw new AppError('SUPPLIER_NOT_FOUND', 'No supplier profile associated with this user account', 404);
    }
    const orders = await this.poRepository.findPOsBySupplierId(supplier.id);
    return orders.map((po: any) => {
      const outletInfo = po.supplier
        ? {
            id: po.supplier.id,
            name: po.supplier.name,
            restaurantName: po.supplier.business?.name || po.supplier.name,
            address: po.supplier.address,
            city: po.supplier.city,
            phone: po.supplier.phone,
          }
        : null;
      return {
        ...po,
        outlet: outletInfo,
      };
    });
  }

  async updateSupplierPOStatus(
    userId: string,
    poId: string,
    data: {
      status: POStatus;
      supplierNotes?: string;
      expectedNextDeliveryDate?: Date | string;
      items?: { itemId: string; dispatchedQuantity: number }[];
    }
  ) {
    const supplier = await this.poRepository.findSupplierByUserId(userId);
    if (!supplier) {
      throw new AppError('SUPPLIER_NOT_FOUND', 'No supplier profile associated with this user account', 404);
    }

    const updatedPO = await prisma.$transaction(async (tx) => {
      // Lock, then read fresh: a restaurant cancelling or receiving this PO right now goes first or waits
      await lockPO(tx, poId);
      const po = await this.poRepository.findSupplierPOById(supplier.id, poId, tx);
      if (!po) {
        throw new AppError('PO_NOT_FOUND', 'Purchase order not found or not assigned to you', 404);
      }

      if (po.status === 'RECEIVED' || po.status === 'CLOSED' || po.status === 'CANCELLED') {
        throw new AppError('PO_CLOSED', `Cannot modify purchase order in ${po.status} status`, 400);
      }

      const validStatuses: POStatus[] = ['PACKING', 'OUT_OF_STOCK', 'PARTIALLY_DISPATCHED', 'DISPATCHED'];
      if (!validStatuses.includes(data.status)) {
        throw new AppError('INVALID_STATUS', `Invalid supplier status: ${data.status}`, 400);
      }

      let targetStatus = data.status;

      if (data.status === 'DISPATCHED' || data.status === 'PARTIALLY_DISPATCHED') {
        if (!data.items || data.items.length === 0) {
          throw new AppError('INVALID_DISPATCH', 'Item dispatch quantities are required', 400);
        }

        let totalDispatched = 0;
        let isPartial = false;

        for (const itemInput of data.items) {
          const qty = Number(itemInput.dispatchedQuantity) || 0;
          if (qty < 0) {
            throw new AppError('INVALID_DISPATCH_QTY', 'Dispatched quantity cannot be negative', 400);
          }
          totalDispatched += qty;

          const poItem = po.items.find((i: any) => i.itemId === itemInput.itemId);
          if (poItem) {
            const ordered = poItem.orderedQuantity.toNumber();
            if (qty < ordered) {
              isPartial = true;
            }
          }
        }

        if (totalDispatched <= 0) {
          throw new AppError('INVALID_DISPATCH_QTY', 'Total dispatched quantity must be greater than 0', 400);
        }

        if (isPartial) {
          targetStatus = 'PARTIALLY_DISPATCHED';
        }
      }

      if (data.items && data.items.length > 0 && po.items) {
        for (const itemToUpdate of data.items) {
          const poItem = po.items.find((i: any) => i.itemId === itemToUpdate.itemId);
          if (poItem) {
            await tx.purchaseOrderItem.update({
              where: { id: poItem.id },
              data: {
                dispatchedQuantity: new Prisma.Decimal(Math.max(0, itemToUpdate.dispatchedQuantity)),
              },
            });
          }
        }
      }

      const dispatchDate =
        targetStatus === 'DISPATCHED' || targetStatus === 'PARTIALLY_DISPATCHED' ? new Date() : po.dispatchDate;

      const nextDelivery = data.expectedNextDeliveryDate ? new Date(data.expectedNextDeliveryDate) : null;

      const result = await tx.purchaseOrder.update({
        where: { id: poId },
        data: {
          status: targetStatus,
          supplierNotes: data.supplierNotes || po.supplierNotes,
          dispatchDate,
          expectedNextDeliveryDate: nextDelivery,
        },
        include: {
          supplier: { select: { id: true, name: true } },
          items: { include: { item: true } },
        },
      });
      return result;
    }, PO_TX_OPTIONS);

    NotificationService.notifyPOStatusChanged({
      id: updatedPO.id,
      poNumber: updatedPO.poNumber,
      supplierId: updatedPO.supplierId,
      status: updatedPO.status,
      totalAmountPence: updatedPO.totalAmountPence,
      outletId: updatedPO.outletId,
    }).catch(() => {});

    return updatedPO;
  }

  // --- Manager Receiving Method ---

  async receivePO(
    outletId: string,
    poId: string,
    receivedItems: {
      itemId: string;
      receivedQuantity: number;
      damagedQuantity?: number;
      batchNumber: string;
      expiryDate: Date;
    }[],
    businessId?: string | null
  ) {
    // Deduplicate receivedItems by itemId so repeated itemId entries in one request cannot multiply stock
    const mergedItemsMap = new Map<string, typeof receivedItems[number]>();
    for (const entry of receivedItems) {
      const existing = mergedItemsMap.get(entry.itemId);
      if (existing) {
        existing.receivedQuantity = (existing.receivedQuantity || 0) + (entry.receivedQuantity || 0);
        existing.damagedQuantity = (existing.damagedQuantity || 0) + (entry.damagedQuantity || 0);
      } else {
        mergedItemsMap.set(entry.itemId, { ...entry });
      }
    }
    const deduplicatedItems = Array.from(mergedItemsMap.values());

    const updatedPO = await prisma.$transaction(async (tx) => {
      // Lock, then read fresh. Without this, two receives at the same moment (double-click, two staff)
      // both read "0 received", both pass the over-order check and both add stock.
      await lockPO(tx, poId);
      const po = await this.poRepository.findPOById(outletId, poId, businessId, tx);
      if (!po) {
        throw new AppError('PO_NOT_FOUND', 'Purchase order not found', 404);
      }
      if (FINAL_PO_STATUSES.includes(po.status)) {
        throw new AppError('PO_ALREADY_COMPLETED', `Cannot receive items on a ${po.status.toLowerCase()} purchase order`, 400);
      }

      for (const itemToReceive of deduplicatedItems) {
        const poItem = po.items.find((i) => i.itemId === itemToReceive.itemId);
        if (!poItem) {
          throw new AppError('ITEM_NOT_IN_PO', `Item ${itemToReceive.itemId} is not in this purchase order`, 400);
        }

        const currentReceived = poItem.receivedQuantity.toNumber();
        const currentDamaged = decimalToNumber(poItem.damagedQuantity);
        const ordered = poItem.orderedQuantity.toNumber();
        const newlyReceived = itemToReceive.receivedQuantity || 0;
        const newlyDamaged = itemToReceive.damagedQuantity || 0;

        const totalReceived = currentReceived + newlyReceived;
        const totalDamaged = currentDamaged + newlyDamaged;

        // Accepted + rejected (damaged) together can't exceed what was ordered
        if (totalReceived + totalDamaged > ordered) {
          throw new AppError(
            'RECEIVE_OVER_ORDER',
            `Cannot record ${newlyReceived} received + ${newlyDamaged} damaged for ${poItem.item.name}. Total (${totalReceived + totalDamaged}) would exceed ordered (${ordered})`,
            400
          );
        }

        // Update in-memory tracker as well
        poItem.receivedQuantity = new Prisma.Decimal(totalReceived);
        poItem.damagedQuantity = new Prisma.Decimal(totalDamaged);

        // 1. Update received / damaged quantities in PurchaseOrderItem
        await tx.purchaseOrderItem.update({
          where: { id: poItem.id },
          data: {
            receivedQuantity: new Prisma.Decimal(totalReceived),
            damagedQuantity: new Prisma.Decimal(totalDamaged),
          },
        });

        // 2. Create StockBatch for valid accepted items (newlyReceived > 0). Damaged goods never enter stock.
        if (newlyReceived > 0) {
          let targetOutlet = outletId;
          if (!targetOutlet || targetOutlet === 'all') {
            targetOutlet = po.outletId;
          }

          // Update the item's cost to the weighted average of stock on hand and this delivery,
          // so food cost / waste cost / Smart PO reflect the latest purchase prices.
          const ledgerSum = await tx.stockLedgerEntry.aggregate({
            where: { itemId: poItem.itemId },
            _sum: { change: true },
          });
          const stockOnHand = Math.max(0, decimalToNumber(ledgerSum._sum.change));
          const previousCostPence = poItem.item.unitCostPence;
          const newCostPence =
            stockOnHand > 0 && typeof previousCostPence === 'number'
              ? Math.round(
                  (stockOnHand * previousCostPence + newlyReceived * poItem.unitCostPence) /
                    (stockOnHand + newlyReceived)
                )
              : poItem.unitCostPence;
          if (newCostPence !== previousCostPence) {
            await tx.item.update({
              where: { id: poItem.itemId },
              data: { unitCostPence: newCostPence },
            });
          }

          await tx.stockBatch.create({
            data: {
              outletId: targetOutlet,
              itemId: poItem.itemId,
              quantity: new Prisma.Decimal(newlyReceived),
              expiryDate: parseValidExpiryDate(itemToReceive.expiryDate),
              batchNumber: itemToReceive.batchNumber || `BCH-${Date.now()}`,
              unitCostPence: poItem.unitCostPence,
            },
          });

          // 3. Create positive PURCHASE StockLedgerEntry
          await tx.stockLedgerEntry.create({
            data: {
              outletId: targetOutlet,
              itemId: poItem.itemId,
              change: new Prisma.Decimal(newlyReceived),
              reason: 'PURCHASE',
              referenceId: poId,
            },
          });
        }
      }

      // Reload PO items inside transaction to compute overall status
      const updatedPOItems = await tx.purchaseOrderItem.findMany({
        where: { purchaseOrderId: poId },
      });

      let allFullyReceived = true;
      let anyReceived = false;

      for (const item of updatedPOItems) {
        const received = item.receivedQuantity.toNumber();
        const damaged = decimalToNumber(item.damagedQuantity);
        const ordered = item.orderedQuantity.toNumber();

        // An item is fully delivered once everything ordered is either accepted or rejected as damaged
        if (received + damaged < ordered) {
          allFullyReceived = false;
        }
        if (received > 0 || damaged > 0) {
          anyReceived = true;
        }
      }

      let newStatus: POStatus = po.status;
      if (allFullyReceived) {
        newStatus = 'RECEIVED';
      } else if (anyReceived) {
        newStatus = 'PARTIALLY_RECEIVED';
      }

      return tx.purchaseOrder.update({
        where: { id: poId },
        data: {
          status: newStatus,
        },
        include: {
          actualSupplier: true,
          supplier: { select: { id: true, name: true } },
          items: { include: { item: true } },
        },
      });
    }, PO_TX_OPTIONS);

    NotificationService.notifyPOStatusChanged({
      id: updatedPO.id,
      poNumber: updatedPO.poNumber,
      supplierId: updatedPO.supplierId,
      status: updatedPO.status,
      totalAmountPence: updatedPO.totalAmountPence,
      outletId: updatedPO.outletId,
    }).catch(() => {});

    return updatedPO;
  }

  /**
   * Cancel a PO that hasn't been received at all (wrong order, supplier changed, etc.).
   * Once anything has been received, use closePO instead.
   */
  async cancelPO(outletId: string, poId: string, reason: string | undefined, businessId?: string | null) {
    return this.finalizePO(outletId, poId, businessId, 'CANCELLED', reason?.trim() || 'Cancelled by manager', (po) => {
      if (anythingReceived(po)) {
        throw new AppError(
          'PO_PARTIALLY_RECEIVED',
          'Some items on this order were already received. Use "Close order" to stop expecting the rest.',
          400
        );
      }
    });
  }

  /**
   * Close a partially received PO when the remaining quantity will not arrive (short delivery).
   */
  async closePO(outletId: string, poId: string, reason: string | undefined, businessId?: string | null) {
    return this.finalizePO(
      outletId,
      poId,
      businessId,
      'CLOSED',
      reason?.trim() || 'Closed short — remaining quantity not expected',
      (po) => {
        if (!anythingReceived(po)) {
          throw new AppError(
            'PO_NOTHING_RECEIVED',
            'Nothing has been received on this order yet. Use "Cancel order" instead.',
            400
          );
        }
      }
    );
  }

  /**
   * Cancel or close a PO. Locks it and re-reads it first, so a supplier dispatching or a manager
   * receiving at the same moment can't be overwritten by (or overwrite) the cancel.
   */
  private async finalizePO(
    outletId: string,
    poId: string,
    businessId: string | null | undefined,
    status: 'CANCELLED' | 'CLOSED',
    reason: string,
    check: (po: NonNullable<Awaited<ReturnType<PurchaseOrderRepository['findPOById']>>>) => void
  ) {
    const updatedPO = await prisma.$transaction(async (tx) => {
      await lockPO(tx, poId);
      const po = await this.poRepository.findPOById(outletId, poId, businessId, tx);
      if (!po) {
        throw new AppError('PO_NOT_FOUND', 'Purchase order not found', 404);
      }
      if (FINAL_PO_STATUSES.includes(po.status)) {
        throw new AppError('PO_ALREADY_COMPLETED', `This purchase order is already ${po.status.toLowerCase()}`, 400);
      }
      check(po);

      return tx.purchaseOrder.update({
        where: { id: po.id },
        data: { status, closedReason: reason, closedAt: new Date() },
        include: {
          actualSupplier: true,
          supplier: { select: { id: true, name: true } },
          items: { include: { item: true } },
        },
      });
    }, PO_TX_OPTIONS);

    NotificationService.notifyPOStatusChanged({
      id: updatedPO.id,
      poNumber: updatedPO.poNumber,
      supplierId: updatedPO.supplierId,
      supplierUserId: updatedPO.actualSupplier?.userId,
      status: updatedPO.status,
      totalAmountPence: updatedPO.totalAmountPence,
      outletId: updatedPO.outletId,
    }).catch(() => {});

    return updatedPO;
  }
}

export default PurchaseOrderService;
