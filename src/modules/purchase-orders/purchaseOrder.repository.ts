import { prisma } from '../../config/prisma';
import { Prisma } from '@prisma/client';
import { NO_MATCH_UUID, outletScope } from '../../utils/tenantScope';

export class PurchaseOrderRepository {
  async createSupplier(outletId: string, data: any) {
    return prisma.supplier.create({
      data: {
        ...data,
        outletId,
      },
    });
  }

  async findSupplierById(outletId: string, id: string, businessId?: string | null) {
    // Supplier of the selected outlet, or in "all outlets" mode of the caller's business
    return prisma.supplier.findFirst({
      where: { id, deletedAt: null, ...outletScope(outletId, businessId) },
      include: {
        outlet: { select: { id: true, name: true, businessId: true } },
        user: { select: { id: true, email: true, name: true, role: true } },
      },
    });
  }

  /**
   * A supplier the caller may send a purchase order to: one of its own vendors, or any supplier who
   * signed up on the supplier portal (those sell to every restaurant through the marketplace).
   * Editing and deleting still go through findSupplierById, so only a business's own vendors can change.
   */
  async findOrderableSupplier(outletId: string, id: string, businessId?: string | null) {
    return prisma.supplier.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [outletScope(outletId, businessId), { type: 'ONLINE', userId: { not: null } }],
      },
      include: {
        outlet: { select: { id: true, name: true, businessId: true } },
        user: { select: { id: true, email: true, name: true, role: true } },
      },
    });
  }

  async deleteSupplier(outletId: string, id: string) {
    return prisma.supplier.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async updateSupplier(outletId: string, id: string, data: any) {
    return prisma.supplier.updateMany({
      where: { id, deletedAt: null },
      data,
    });
  }

  /** Creates a PO already sent to the supplier. Pass the transaction that generated `poNumber`. */
  async createPO(
    outletId: string,
    supplierId: string,
    poNumber: string,
    totalAmountPence: number,
    items: { itemId: string; orderedQuantity: number; unitCostPence: number }[],
    clientRequestId: string | undefined,
    client: Prisma.TransactionClient = prisma
  ) {
    return client.purchaseOrder.create({
      data: {
        outletId,
        supplierId,
        poNumber,
        clientRequestId,
        status: 'SENT',
        totalAmountPence,
        items: {
          create: items.map(item => ({
            itemId: item.itemId,
            orderedQuantity: new Prisma.Decimal(item.orderedQuantity),
            unitCostPence: item.unitCostPence,
          })),
        },
      },
      include: {
        actualSupplier: true,
        supplier: { select: { id: true, name: true } },
        items: { include: { item: true } },
      },
    });
  }

  /** The PO an earlier "Create PO" attempt with this key made, if the caller is allowed to see it. */
  async findPOByClientRequestId(outletId: string, clientRequestId: string, businessId?: string | null) {
    const isAll = !outletId || outletId === 'all';
    const scope = isAll ? { supplier: { businessId: businessId || NO_MATCH_UUID } } : { outletId };
    return prisma.purchaseOrder.findFirst({
      where: { clientRequestId, deletedAt: null, ...scope },
      include: {
        actualSupplier: true,
        supplier: { select: { id: true, name: true } },
        items: { include: { item: true } },
      },
    });
  }

  async findPOById(outletId: string, id: string, businessId?: string | null, client: Prisma.TransactionClient = prisma) {
    const isAll = !outletId || outletId === 'all';
    // Only find POs of the current outlet (or, in "all outlets" mode, of the caller's business)
    const scope = isAll ? { supplier: { businessId: businessId || NO_MATCH_UUID } } : { outletId };
    return client.purchaseOrder.findFirst({
      where: { id, deletedAt: null, ...scope },
      include: {
        items: {
          include: {
            item: true,
          },
        },
      },
    });
  }

  async findSupplierByUserId(userId: string) {
    return prisma.supplier.findFirst({
      where: { userId, deletedAt: null },
      include: { outlet: { select: { id: true, name: true, businessId: true } } },
    });
  }

  async findSuppliers(outletId: string, businessId?: string) {
    let targetBusinessId = businessId;
    if (!targetBusinessId && outletId && outletId !== 'all') {
      const outlet = await prisma.outlet.findUnique({
        where: { id: outletId },
        select: { businessId: true },
      });
      if (outlet?.businessId) {
        targetBusinessId = outlet.businessId;
      }
    }

    if (targetBusinessId) {
      const businessOutlets = await prisma.outlet.findMany({
        where: { businessId: targetBusinessId, deletedAt: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      const firstOutletId = businessOutlets[0]?.id;
      const outletIds = businessOutlets.map((o) => o.id);

      // Auto-heal: If any supplier is linked to a user of this business but has an invalid/foreign outletId, repair it
      if (firstOutletId) {
        await prisma.supplier.updateMany({
          where: {
            user: { businessId: targetBusinessId },
            outletId: { notIn: outletIds },
          },
          data: {
            outletId: firstOutletId,
          },
        });
      }

      return prisma.supplier.findMany({
        where: {
          deletedAt: null,
          OR: [
            { outlet: { businessId: targetBusinessId } },
            { user: { businessId: targetBusinessId } },
            { outletId: { in: outletIds } },
          ],
        },
        include: {
          outlet: { select: { id: true, name: true, businessId: true } },
          user: { select: { id: true, email: true, name: true, role: true } },
        },
        orderBy: { name: 'asc' },
      });
    }

    return prisma.supplier.findMany({
      where: {
        deletedAt: null,
        ...(outletId && outletId !== 'all' ? { outletId } : {}),
      },
      include: {
        outlet: { select: { id: true, name: true, businessId: true } },
        user: { select: { id: true, email: true, name: true, role: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findPOs(outletId: string, businessId?: string) {
    const isAll = !outletId || outletId === 'all';
    const where = isAll
      ? { deletedAt: null, supplier: { businessId: businessId || NO_MATCH_UUID } }
      : { outletId, deletedAt: null };
    return prisma.purchaseOrder.findMany({
      where,
      include: {
        actualSupplier: {
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
        },
        supplier: {
          select: {
            id: true,
            name: true,
            address: true,
            city: true,
            phone: true,
            business: { select: { id: true, name: true } },
          },
        },
        items: {
          include: {
            item: { include: { outlet: { select: { id: true, name: true } } } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findPOsBySupplierId(supplierId: string) {
    return prisma.purchaseOrder.findMany({
      where: { supplierId, deletedAt: null },
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            address: true,
            city: true,
            phone: true,
            business: { select: { id: true, name: true } },
          },
        },
        items: {
          include: {
            item: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findSupplierPOById(supplierId: string, id: string, client: Prisma.TransactionClient = prisma) {
    return client.purchaseOrder.findFirst({
      where: { id, supplierId, deletedAt: null },
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            address: true,
            city: true,
            phone: true,
            business: { select: { id: true, name: true } },
          },
        },
        items: {
          include: {
            item: true,
          },
        },
      },
    });
  }
}
export default PurchaseOrderRepository;

