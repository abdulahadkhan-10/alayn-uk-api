import { AppError } from '../../utils/AppError';
import { SupplierRepository } from './supplier.repository';

const MAX_MATCHED_ITEMS = 3;

export interface MarketplaceQuery {
  search?: string;
  category?: string;
  /** BEST = cheapest when searching, otherwise alphabetical */
  sort: 'BEST' | 'PRICE' | 'DELIVERY' | 'NAME';
  page: number;
  limit: number;
}

export interface MarketplaceSupplierRow {
  supplier: {
    id: string;
    name: string;
    contactPerson: string;
    phone: string;
    email: string;
    address: string;
    rating: number | null;
    deliveryTerms: string | null;
  };
  categories: string[];
  totalItems: number;
  fastestLeadTimeHours: number;
  /** Cheapest item among those matching the search/category */
  minPricePence: number;
  /** Cheapest products whose name matches the search (up to 3) */
  matchedItems: { id: string; supplierId: string; name: string; unit: string; pricePence: number; inStock: boolean }[];
  matchedCount: number;
}

export interface MarketplacePage {
  suppliers: MarketplaceSupplierRow[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  /** Category tabs, only on page 1 */
  categories?: { name: string; supplierCount: number }[];
  /** Suppliers in the whole marketplace (the "All" tab), only on page 1 */
  totalSuppliers?: number;
}

function summariseCategories(pairs: { category: string; supplierId: string }[]) {
  const counts = new Map<string, number>();
  for (const p of pairs) {
    const name = p.category || 'General';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([name, supplierCount]) => ({ name, supplierCount })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

export class SupplierService {
  private supplierRepository = new SupplierRepository();

  private async getSupplierOrThrow(userId: string) {
    const supplier = await this.supplierRepository.findSupplierByUserId(userId);
    if (!supplier) {
      throw new AppError('SUPPLIER_NOT_FOUND', 'Supplier profile not found for this account', 404);
    }
    return supplier;
  }

  async getMyProfile(userId: string) {
    return this.getSupplierOrThrow(userId);
  }

  async updateMyProfile(userId: string, data: any) {
    const supplier = await this.getSupplierOrThrow(userId);
    return this.supplierRepository.updateSupplierProfile(supplier.id, data);
  }

  async getMyCatalog(userId: string) {
    const supplier = await this.getSupplierOrThrow(userId);
    return this.supplierRepository.findSupplierItems(supplier.id);
  }

  async createMyItem(userId: string, data: any) {
    const supplier = await this.getSupplierOrThrow(userId);
    return this.supplierRepository.createSupplierItem(supplier.id, data);
  }

  async updateMyItem(userId: string, itemId: string, data: any) {
    const supplier = await this.getSupplierOrThrow(userId);
    const existing = await this.supplierRepository.findSupplierItemById(itemId, supplier.id);
    if (!existing) {
      throw new AppError('ITEM_NOT_FOUND', 'Catalog item not found', 404);
    }
    return this.supplierRepository.updateSupplierItem(itemId, supplier.id, data);
  }

  async deleteMyItem(userId: string, itemId: string) {
    const supplier = await this.getSupplierOrThrow(userId);
    const existing = await this.supplierRepository.findSupplierItemById(itemId, supplier.id);
    if (!existing) {
      throw new AppError('ITEM_NOT_FOUND', 'Catalog item not found', 404);
    }
    return this.supplierRepository.deleteSupplierItem(itemId, supplier.id);
  }

  /**
   * One page of marketplace suppliers, a row each. Search and sort run in the
   * database so this stays fast with thousands of suppliers. Category tabs are
   * only computed for page 1; "show more" pages reuse them.
   */
  async getMarketplaceSuppliers(params: MarketplaceQuery): Promise<MarketplacePage> {
    const search = params.search?.trim() || undefined;
    const category = params.category && params.category !== 'All' ? params.category : undefined;
    const sort = params.sort === 'BEST' ? (search ? 'PRICE' : 'NAME') : params.sort;
    const skip = (params.page - 1) * params.limit;
    const repo = this.supplierRepository;

    const itemWhere = repo.marketplaceItemWhere(search, category);

    const [total, ids, categoryPairs] = await Promise.all([
      repo.countMarketplaceSuppliers(itemWhere),
      sort === 'NAME'
        ? repo.pageSupplierIdsByName(itemWhere, skip, params.limit)
        : repo.pageSupplierIdsByItemStat(itemWhere, sort, skip, params.limit),
      params.page === 1 ? repo.marketplaceCategoryPairs() : Promise.resolve(null),
    ]);

    const base = {
      total,
      page: params.page,
      limit: params.limit,
      hasMore: skip + ids.length < total,
      ...(categoryPairs
        ? {
            categories: summariseCategories(categoryPairs),
            totalSuppliers: new Set(categoryPairs.map((p: { supplierId: string }) => p.supplierId)).size,
          }
        : {}),
    };

    if (ids.length === 0) return { ...base, suppliers: [] };

    const [suppliers, minPrices, stats, matches] = await Promise.all([
      repo.findMarketplaceSuppliersByIds(ids),
      repo.minMatchingPriceBySupplier(itemWhere, ids),
      repo.catalogStatsBySupplier(ids),
      search ? repo.findMatchingProducts(ids, search, category) : Promise.resolve([]),
    ]);

    const supplierById = new Map<string, any>(suppliers.map((s: any) => [s.id, s]));
    const minPriceById = new Map<string, number>(
      minPrices.map((g: any) => [g.supplierId, g._min.pricePence ?? 0])
    );

    const statsById = new Map<string, { categories: string[]; totalItems: number; fastest: number }>();
    for (const row of stats) {
      const entry = statsById.get(row.supplierId) ?? { categories: [], totalItems: 0, fastest: Infinity };
      entry.categories.push(row.category || 'General');
      entry.totalItems += row._count._all;
      entry.fastest = Math.min(entry.fastest, row._min.leadTimeHours ?? 24);
      statsById.set(row.supplierId, entry);
    }

    const matchesById = new Map<string, any[]>();
    for (const item of matches) {
      const list = matchesById.get(item.supplierId) ?? [];
      list.push(item);
      matchesById.set(item.supplierId, list);
    }

    const rows: MarketplaceSupplierRow[] = [];
    for (const id of ids) {
      const supplier = supplierById.get(id);
      if (!supplier) continue;
      const s = statsById.get(id) ?? { categories: [], totalItems: 0, fastest: 24 };
      const matched = matchesById.get(id) ?? [];
      rows.push({
        supplier: { ...supplier, rating: supplier.rating != null ? Number(supplier.rating) : null },
        categories: s.categories.sort((a, b) => a.localeCompare(b)),
        totalItems: s.totalItems,
        fastestLeadTimeHours: Number.isFinite(s.fastest) ? s.fastest : 24,
        minPricePence: minPriceById.get(id) ?? 0,
        matchedItems: matched.slice(0, MAX_MATCHED_ITEMS),
        matchedCount: matched.length,
      });
    }

    return { ...base, suppliers: rows };
  }

  /** Full catalog of one marketplace supplier, for the order dialog. */
  async getMarketplaceSupplierItems(supplierId: string) {
    const supplier = await this.supplierRepository.findSupplierById(supplierId);
    if (!supplier) {
      throw new AppError('SUPPLIER_NOT_FOUND', 'Supplier not found', 404);
    }
    return this.supplierRepository.findMarketplaceSupplierItems(supplierId);
  }

  async getMarketCatalog(params: {
    search?: string;
    category?: string;
    inStockOnly?: boolean;
    maxPricePence?: number;
  }) {
    return this.supplierRepository.findMarketCatalog(params);
  }

  async compareSuppliers(params: {
    itemName?: string;
    category?: string;
    currentUnitCostPence?: number;
    unit?: string;
  }) {
    const items = await this.supplierRepository.findItemsForComparison(params.itemName, params.category);

    if (items.length === 0) {
      return {
        summary: {
          totalSuppliersFound: 0,
          lowestPricePence: 0,
          highestSavingsPercent: 0,
          fastestDeliveryHours: 0,
        },
        recommendations: {
          cheapest: null,
          bestQuality: null,
          fastestDelivery: null,
        },
        allOptions: [],
      };
    }

    const currentCost = params.currentUnitCostPence || 0;

    // Process options with computed metrics
    const processed = items.map((item: any) => {
      const pricePence = item.pricePence;
      let savingsPence = 0;
      let savingsPercent = 0;
      let isCheaper = false;

      if (currentCost > 0) {
        savingsPence = currentCost - pricePence;
        savingsPercent = Math.round((savingsPence / currentCost) * 100);
        isCheaper = savingsPence > 0;
      }

      const rating = Number(item.supplier?.rating || 5.0);

      return {
        id: item.id,
        supplierId: item.supplier.id,
        supplierName: item.supplier.name,
        contactPerson: item.supplier.contactPerson,
        phone: item.supplier.phone,
        email: item.supplier.email,
        rating,
        deliveryTerms: item.supplier.deliveryTerms,
        itemName: item.name,
        category: item.category,
        unit: item.unit,
        pricePence: item.pricePence,
        pricePounds: item.pricePence / 100,
        minOrderQty: Number(item.minOrderQty || 1),
        inStock: item.inStock,
        leadTimeHours: item.leadTimeHours || 24,
        description: item.description,
        savingsPence,
        savingsPercent,
        isCheaper,
      };
    });

    // Pick Cheapest (In-stock first)
    const inStockItems = processed.filter((i: any) => i.inStock);
    const pool = inStockItems.length > 0 ? inStockItems : processed;

    const cheapest = [...pool].sort((a, b) => a.pricePence - b.pricePence)[0] || null;

    // Pick Top Rated Wholesaler (highest rating)
    const bestQuality = [...pool].sort((a, b) => b.rating - a.rating)[0] || null;

    // Pick Fastest Delivery (lowest leadTimeHours)
    const fastestDelivery = [...pool].sort((a, b) => a.leadTimeHours - b.leadTimeHours)[0] || null;

    const lowestPrice = cheapest ? cheapest.pricePence : 0;
    const highestSavings = Math.max(0, ...processed.map((p: any) => p.savingsPercent));
    const fastestHours = fastestDelivery ? fastestDelivery.leadTimeHours : 24;

    return {
      summary: {
        totalSuppliersFound: processed.length,
        lowestPricePence: lowestPrice,
        lowestPricePounds: lowestPrice / 100,
        highestSavingsPercent: highestSavings,
        fastestDeliveryHours: fastestHours,
      },
      recommendations: {
        cheapest,
        bestQuality,
        fastestDelivery,
      },
      allOptions: processed.sort((a: any, b: any) => a.pricePence - b.pricePence),
    };
  }
}
