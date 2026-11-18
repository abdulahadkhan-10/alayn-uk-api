import { SupplierService } from '../src/modules/suppliers/supplier.service';
import { marketplaceQuerySchema } from '../src/modules/suppliers/supplier.schema';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    supplier: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    supplierItem: { groupBy: jest.fn(), findMany: jest.fn() },
  },
}));

const p = prisma as any;

const SUP_A = { id: 'sup-a', name: 'Akshat Dairy', contactPerson: 'Akshat', phone: '1', email: 'a@x', address: 'Santa Cruz, Mumbai', rating: '4.50', deliveryTerms: null };
const SUP_B = { id: 'sup-b', name: 'Good Luck Supplier', contactPerson: 'Aquib', phone: '2', email: 'b@x', address: 'Bandra, Mumbai', rating: null, deliveryTerms: null };

/**
 * groupBy is used for several queries; route each call by its `by` fields.
 * pageIds: the supplier ids the paging query returns, in order.
 */
function mockGroupBy(pageIds: string[]) {
  p.supplierItem.groupBy.mockImplementation((args: any) => {
    const by = args.by.join(',');
    if (by === 'supplierId' && args.skip !== undefined) {
      return Promise.resolve(pageIds.map((supplierId) => ({ supplierId, _min: {} })));
    }
    if (by === 'supplierId') {
      return Promise.resolve([
        { supplierId: 'sup-a', _min: { pricePence: 6000 } },
        { supplierId: 'sup-b', _min: { pricePence: 20000 } },
      ]);
    }
    if (by === 'supplierId,category') {
      return Promise.resolve([
        { supplierId: 'sup-a', category: 'Dairy', _count: { _all: 7 }, _min: { leadTimeHours: 24 } },
        { supplierId: 'sup-b', category: 'Meat & Poultry', _count: { _all: 4 }, _min: { leadTimeHours: 12 } },
        { supplierId: 'sup-b', category: 'Dairy', _count: { _all: 1 }, _min: { leadTimeHours: 48 } },
      ]);
    }
    if (by === 'category,supplierId') {
      return Promise.resolve([
        { category: 'Dairy', supplierId: 'sup-a' },
        { category: 'Dairy', supplierId: 'sup-b' },
        { category: 'Meat & Poultry', supplierId: 'sup-b' },
      ]);
    }
    throw new Error(`unexpected groupBy ${by}`);
  });
}

const query = (overrides: any = {}) => marketplaceQuerySchema.parse(overrides);

describe('Marketplace supplier paging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    p.supplier.count.mockResolvedValue(2);
    p.supplier.findMany.mockImplementation((args: any) =>
      Promise.resolve(args.select?.name ? [SUP_B, SUP_A] : [{ id: 'sup-a' }, { id: 'sup-b' }])
    );
    p.supplierItem.findMany.mockResolvedValue([]);
    mockGroupBy(['sup-b', 'sup-a']);
  });

  it('lists alphabetically when not searching, with one row per supplier', async () => {
    const page = await new SupplierService().getMarketplaceSuppliers(query());

    const pagingCall = p.supplier.findMany.mock.calls.find((c: any[]) => c[0].orderBy);
    expect(pagingCall[0]).toMatchObject({ skip: 0, take: 20, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    expect(page.suppliers.map((r) => r.supplier.id)).toEqual(['sup-a', 'sup-b']);

    const b = page.suppliers[1];
    expect(b.categories).toEqual(['Dairy', 'Meat & Poultry']);
    expect(b.totalItems).toBe(5);
    expect(b.fastestLeadTimeHours).toBe(12);
    expect(page.suppliers[0].supplier.rating).toBe(4.5);
    expect(page.hasMore).toBe(false);
  });

  it('puts the cheapest supplier for the searched product first', async () => {
    p.supplierItem.findMany.mockResolvedValue([
      { id: 'i1', supplierId: 'sup-b', name: 'Chicken', unit: 'kg', pricePence: 20000, inStock: true },
      { id: 'i2', supplierId: 'sup-b', name: 'Chicken Breast', unit: 'kg', pricePence: 32000, inStock: true },
      { id: 'i3', supplierId: 'sup-b', name: 'Chicken Wings', unit: 'kg', pricePence: 34000, inStock: true },
      { id: 'i4', supplierId: 'sup-b', name: 'Chicken Mince', unit: 'kg', pricePence: 36000, inStock: false },
    ]);

    const page = await new SupplierService().getMarketplaceSuppliers(query({ search: ' chicken ' }));

    const pagingCall = p.supplierItem.groupBy.mock.calls.find((c: any[]) => c[0].skip !== undefined)[0];
    expect(pagingCall.orderBy[0]).toEqual({ _min: { pricePence: 'asc' } });
    expect(JSON.stringify(pagingCall.where)).toContain('"contains":"chicken"');

    expect(page.suppliers[0].supplier.id).toBe('sup-b');
    expect(page.suppliers[0].matchedItems).toHaveLength(3);
    expect(page.suppliers[0].matchedCount).toBe(4);
    expect(page.suppliers[0].minPricePence).toBe(20000);
  });

  it('sorts by delivery time when asked', async () => {
    await new SupplierService().getMarketplaceSuppliers(query({ sort: 'DELIVERY' }));
    const pagingCall = p.supplierItem.groupBy.mock.calls.find((c: any[]) => c[0].skip !== undefined)[0];
    expect(pagingCall.orderBy[0]).toEqual({ _min: { leadTimeHours: 'asc' } });
  });

  it('filters by category case-insensitively', async () => {
    await new SupplierService().getMarketplaceSuppliers(query({ category: 'dairy' }));
    expect(p.supplier.count.mock.calls[0][0].where.items.some.category).toEqual({ equals: 'dairy', mode: 'insensitive' });
  });

  it('returns category tabs on page 1 only, and pages with skip', async () => {
    p.supplier.count.mockResolvedValue(45);

    const first = await new SupplierService().getMarketplaceSuppliers(query());
    expect(first.categories).toEqual([
      { name: 'Dairy', supplierCount: 2 },
      { name: 'Meat & Poultry', supplierCount: 1 },
    ]);
    expect(first.totalSuppliers).toBe(2);

    jest.clearAllMocks();
    p.supplier.count.mockResolvedValue(45);
    const second = await new SupplierService().getMarketplaceSuppliers(query({ page: '3' }));
    const pagingCall = p.supplier.findMany.mock.calls.find((c: any[]) => c[0].orderBy);
    expect(pagingCall[0].skip).toBe(40);
    expect(second.categories).toBeUndefined();
    // 40 skipped + 2 on this page = 42 of 45
    expect(second.hasMore).toBe(true);
    expect(p.supplierItem.groupBy.mock.calls.some((c: any[]) => c[0].by.join() === 'category,supplierId')).toBe(false);
  });

  it('skips the detail queries when the page is empty', async () => {
    p.supplier.count.mockResolvedValue(0);
    p.supplier.findMany.mockResolvedValue([]);
    const page = await new SupplierService().getMarketplaceSuppliers(query({ page: '2' }));
    expect(page.suppliers).toEqual([]);
    expect(p.supplierItem.findMany).not.toHaveBeenCalled();
  });

  it('rejects oversized pages', () => {
    expect(() => marketplaceQuerySchema.parse({ limit: '500' })).toThrow();
    expect(query({}).limit).toBe(20);
  });

  it('404s for an unknown supplier catalog', async () => {
    p.supplier.findFirst.mockResolvedValue(null);
    await expect(new SupplierService().getMarketplaceSupplierItems('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});
