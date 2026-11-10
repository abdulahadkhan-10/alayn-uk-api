import { prisma } from '../../config/prisma';

export class SupplierRepository {
  async findSupplierByUserId(userId: string) {
    return (prisma as any).supplier.findFirst({
      where: { userId, deletedAt: null },
      include: {
        user: { select: { id: true, name: true, email: true, phoneNo: true } },
      },
    });
  }

  async findSupplierById(id: string) {
    return (prisma as any).supplier.findFirst({
      where: { id, deletedAt: null },
      include: {
        user: { select: { id: true, name: true, email: true, phoneNo: true } },
      },
    });
  }

  async updateSupplierProfile(id: string, data: any) {
    return (prisma as any).supplier.update({
      where: { id },
      data,
    });
  }

  async createSupplierItem(supplierId: string, data: any) {
    return (prisma as any).supplierItem.create({
      data: {
        supplierId,
        name: data.name,
        sku: data.sku || null,
        category: data.category,
        unit: data.unit,
        pricePaise: data.pricePaise,
        minOrderQty: data.minOrderQty ?? 1,
        inStock: data.inStock ?? true,
        leadTimeHours: data.leadTimeHours ?? 24,
        description: data.description || null,
      },
    });
  }

  async findSupplierItems(supplierId: string) {
    return (prisma as any).supplierItem.findMany({
      where: {
        supplierId,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findSupplierItemById(id: string, supplierId: string) {
    return (prisma as any).supplierItem.findFirst({
      where: {
        id,
        supplierId,
        deletedAt: null,
      },
    });
  }

  async updateSupplierItem(id: string, supplierId: string, data: any) {
    return (prisma as any).supplierItem.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.sku !== undefined ? { sku: data.sku } : {}),
        ...(data.category !== undefined ? { category: data.category } : {}),
        ...(data.unit !== undefined ? { unit: data.unit } : {}),
        ...(data.pricePaise !== undefined ? { pricePaise: data.pricePaise } : {}),
        ...(data.minOrderQty !== undefined ? { minOrderQty: data.minOrderQty } : {}),
        ...(data.inStock !== undefined ? { inStock: data.inStock } : {}),
        ...(data.leadTimeHours !== undefined ? { leadTimeHours: data.leadTimeHours } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
      },
    });
  }

  async deleteSupplierItem(id: string, supplierId: string) {
    return (prisma as any).supplierItem.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async findMarketCatalog(params: {
    search?: string;
    category?: string;
    inStockOnly?: boolean;
    maxPricePaise?: number;
  }) {
    const where: any = {
      deletedAt: null,
      supplier: {
        deletedAt: null,
      },
    };

    if (params.inStockOnly) {
      where.inStock = true;
    }

    if (params.category && params.category !== 'All') {
      where.category = { equals: params.category, mode: 'insensitive' };
    }

    if (params.search && params.search.trim()) {
      const q = params.search.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
        { supplier: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    if (params.maxPricePaise && params.maxPricePaise > 0) {
      where.pricePaise = { lte: params.maxPricePaise };
    }

    return (prisma as any).supplierItem.findMany({
      where,
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            contactPerson: true,
            phone: true,
            email: true,
            address: true,
            rating: true,
            deliveryTerms: true,
            type: true,
          },
        },
      },
      orderBy: [{ inStock: 'desc' }, { pricePaise: 'asc' }],
    });
  }

  // ---------- Paged marketplace (one row per supplier) ----------

  /** Items that make a supplier show up for this search + category. */
  marketplaceItemWhere(search?: string, category?: string) {
    const where: any = {
      deletedAt: null,
      supplier: { deletedAt: null },
    };
    if (category) {
      where.category = { equals: category, mode: 'insensitive' };
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
        { supplier: { name: { contains: search, mode: 'insensitive' } } },
        { supplier: { address: { contains: search, mode: 'insensitive' } } },
      ];
    }
    return where;
  }

  async countMarketplaceSuppliers(itemWhere: any) {
    return (prisma as any).supplier.count({
      where: { deletedAt: null, items: { some: itemWhere } },
    });
  }

  /** One page of supplier ids, alphabetically. */
  async pageSupplierIdsByName(itemWhere: any, skip: number, take: number): Promise<string[]> {
    const rows = await (prisma as any).supplier.findMany({
      where: { deletedAt: null, items: { some: itemWhere } },
      select: { id: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip,
      take,
    });
    return rows.map((r: { id: string }) => r.id);
  }

  /** One page of supplier ids, by cheapest matching item or fastest delivery. */
  async pageSupplierIdsByItemStat(
    itemWhere: any,
    sort: 'PRICE' | 'DELIVERY',
    skip: number,
    take: number
  ): Promise<string[]> {
    const orderBy =
      sort === 'PRICE'
        ? [{ _min: { pricePaise: 'asc' } }, { supplierId: 'asc' }]
        : [{ _min: { leadTimeHours: 'asc' } }, { _min: { pricePaise: 'asc' } }, { supplierId: 'asc' }];
    const groups = await (prisma as any).supplierItem.groupBy({
      by: ['supplierId'],
      where: itemWhere,
      _min: { pricePaise: true, leadTimeHours: true },
      orderBy,
      skip,
      take,
    });
    return groups.map((g: { supplierId: string }) => g.supplierId);
  }

  async findMarketplaceSuppliersByIds(ids: string[]) {
    return (prisma as any).supplier.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: {
        id: true,
        name: true,
        contactPerson: true,
        phone: true,
        email: true,
        address: true,
        rating: true,
        deliveryTerms: true,
      },
    });
  }

  /** Cheapest price among the items that matched, per supplier. */
  async minMatchingPriceBySupplier(itemWhere: any, ids: string[]) {
    return (prisma as any).supplierItem.groupBy({
      by: ['supplierId'],
      where: { ...itemWhere, supplierId: { in: ids } },
      _min: { pricePaise: true },
    });
  }

  /** Product counts, categories and delivery time per supplier, over their whole catalog. */
  async catalogStatsBySupplier(ids: string[]) {
    return (prisma as any).supplierItem.groupBy({
      by: ['supplierId', 'category'],
      where: { deletedAt: null, supplierId: { in: ids } },
      _count: { _all: true },
      _min: { leadTimeHours: true },
    });
  }

  /** Products whose name matches the search, cheapest first. */
  async findMatchingProducts(ids: string[], search: string, category?: string) {
    return (prisma as any).supplierItem.findMany({
      where: {
        deletedAt: null,
        supplierId: { in: ids },
        name: { contains: search, mode: 'insensitive' },
        ...(category ? { category: { equals: category, mode: 'insensitive' } } : {}),
      },
      select: {
        id: true,
        supplierId: true,
        name: true,
        unit: true,
        pricePaise: true,
        inStock: true,
      },
      orderBy: [{ pricePaise: 'asc' }, { id: 'asc' }],
    });
  }

  /** Category tabs: every category with at least one active supplier. */
  async marketplaceCategoryPairs() {
    return (prisma as any).supplierItem.groupBy({
      by: ['category', 'supplierId'],
      where: { deletedAt: null, supplier: { deletedAt: null } },
    });
  }

  async findMarketplaceSupplierItems(supplierId: string) {
    return (prisma as any).supplierItem.findMany({
      where: { supplierId, deletedAt: null, supplier: { deletedAt: null } },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  }

  async findItemsForComparison(itemName?: string, category?: string) {
    const where: any = {
      deletedAt: null,
      supplier: { deletedAt: null },
    };

    const conditions: any[] = [];
    if (itemName && itemName.trim()) {
      const terms = itemName.trim().split(/\s+/).filter(Boolean);
      for (const t of terms) {
        conditions.push({ name: { contains: t, mode: 'insensitive' } });
      }
    }
    if (category && category.trim() && category !== 'All') {
      conditions.push({ category: { contains: category.trim(), mode: 'insensitive' } });
    }

    if (conditions.length > 0) {
      where.OR = conditions;
    }

    return (prisma as any).supplierItem.findMany({
      where,
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            contactPerson: true,
            phone: true,
            email: true,
            address: true,
            rating: true,
            deliveryTerms: true,
          },
        },
      },
      orderBy: { pricePaise: 'asc' },
    });
  }
}
