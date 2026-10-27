import { aggregate, autoGranularity, RawOrder, RawWaste, Lookups, ReportFilters } from '../src/modules/reports/aggregate';
import { DateRange } from '../src/modules/reports/periods';
import { businessDayStart } from '../src/utils/outletTime';

// Build an instant from an India-time wall clock (October 2026).
const ist = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute) - 330 * 60 * 1000);
const days = (from: number, to: number): DateRange => ({
  start: businessDayStart(2026, 9, from),
  end: new Date(businessDayStart(2026, 9, to + 1).getTime() - 1),
});

const CURRENT = days(17, 18); // Sat 17 - Sun 18 Oct
const PREVIOUS = days(15, 16); // Thu 15 - Fri 16 Oct

let n = 0;
function order(o: Partial<RawOrder> & Pick<RawOrder, 'outletId' | 'createdAt' | 'source' | 'subtotalPaise' | 'items'>): RawOrder {
  n += 1;
  return {
    id: `o${n}`, status: 'COMPLETED', discountPaise: 0, cgstPaise: 0, sgstPaise: 0, serviceTaxPaise: 0, payments: [], ...o,
  };
}

const lookups: Lookups = {
  items: new Map([
    ['A', { name: 'Paneer Tikka', categoryId: 'c1', categoryName: 'Starters' }],
    ['B', { name: 'Butter Naan', categoryId: 'c1', categoryName: 'Starters' }],
    ['C', { name: 'Dal Makhani', categoryId: 'c2', categoryName: 'Mains' }],
  ]),
  outlets: new Map([['o1', 'Indiranagar'], ['o2', 'Koramangala']]),
};

const currentOrders: RawOrder[] = [
  order({ outletId: 'o1', createdAt: ist(17, 13), source: 'TABLE', subtotalPaise: 100000, discountPaise: 10000,
    cgstPaise: 2250, sgstPaise: 2250, serviceTaxPaise: 5000,
    items: [{ menuItemId: 'A', quantity: 2, subtotalPaise: 60000 }, { menuItemId: 'C', quantity: 1, subtotalPaise: 40000 }],
    payments: [{ method: 'UPI', amountPaise: 60000 }, { method: 'CASH', amountPaise: 40000 }] }),
  order({ outletId: 'o1', createdAt: ist(17, 19), source: 'QR', subtotalPaise: 50000, cgstPaise: 1250, sgstPaise: 1250,
    items: [{ menuItemId: 'B', quantity: 2, subtotalPaise: 50000 }],
    payments: [{ method: 'CARD', amountPaise: 52500 }] }),
  order({ outletId: 'o2', createdAt: ist(17, 14), source: 'COUNTER', subtotalPaise: 80000, cgstPaise: 2000, sgstPaise: 2000,
    items: [{ menuItemId: 'A', quantity: 1, subtotalPaise: 30000 }, { menuItemId: 'B', quantity: 1, subtotalPaise: 50000 }],
    payments: [{ method: 'CASH', amountPaise: 84000 }] }),
  order({ outletId: 'o1', createdAt: ist(18, 12, 30), source: 'DELIVERY', subtotalPaise: 120000, discountPaise: 20000,
    items: [{ menuItemId: 'C', quantity: 3, subtotalPaise: 120000 }],
    payments: [{ method: 'UPI', amountPaise: 100000 }] }),
  order({ outletId: 'o2', createdAt: ist(18, 15), source: 'TABLE', subtotalPaise: 60000,
    items: [{ menuItemId: 'A', quantity: 2, subtotalPaise: 60000 }],
    payments: [{ method: 'UPI', amountPaise: 60000 }] }),
  order({ outletId: 'o1', createdAt: ist(18, 21), source: 'QR', subtotalPaise: 30000,
    items: [{ menuItemId: 'B', quantity: 1, subtotalPaise: 30000 }],
    payments: [{ method: 'UPI', amountPaise: 30000 }] }),
  order({ outletId: 'o1', createdAt: ist(18, 18), source: 'TABLE', status: 'CANCELLED', subtotalPaise: 40000, discountPaise: 5000,
    items: [{ menuItemId: 'A', quantity: 1, subtotalPaise: 40000 }] }),
];

const previousOrders: RawOrder[] = [
  order({ outletId: 'o1', createdAt: ist(15, 13), source: 'DELIVERY', subtotalPaise: 100000,
    items: [{ menuItemId: 'A', quantity: 2, subtotalPaise: 60000 }, { menuItemId: 'C', quantity: 1, subtotalPaise: 40000 }] }),
  order({ outletId: 'o2', createdAt: ist(16, 20), source: 'TABLE', subtotalPaise: 230000,
    items: [{ menuItemId: 'A', quantity: 1, subtotalPaise: 30000 }, { menuItemId: 'B', quantity: 4, subtotalPaise: 200000 }] }),
  order({ outletId: 'o1', createdAt: ist(16, 14), source: 'COUNTER', subtotalPaise: 50000,
    items: [{ menuItemId: 'C', quantity: 1, subtotalPaise: 50000 }] }),
];

const currentWaste: RawWaste[] = [
  { outletId: 'o1', createdAt: ist(17, 10), reason: 'SPOILAGE', costAtLoggingPaise: 8000 },
  { outletId: 'o2', createdAt: ist(18, 16), reason: 'RETURN', costAtLoggingPaise: 2000 },
];
const previousWaste: RawWaste[] = [{ outletId: 'o1', createdAt: ist(16, 11), reason: 'ERROR', costAtLoggingPaise: 5000 }];

const labels = { period: 'Sat 17 - Sun 18 Oct 2026', comparison: 'vs 15–16 Oct 2026', compareLabel: 'vs 15–16 Oct 2026' };
const baseFilters: ReportFilters = { outletIds: ['o1', 'o2'] };

function run(filters: ReportFilters = baseFilters, withPrevious = true) {
  return aggregate({
    current: { range: CURRENT, orders: currentOrders, waste: currentWaste },
    previous: withPrevious ? { range: PREVIOUS, orders: previousOrders, waste: previousWaste } : null,
    filters,
    lookups,
    labels: withPrevious ? labels : { period: labels.period, comparison: null, compareLabel: '' },
  });
}

describe('aggregate', () => {
  it('totals match the dashboard rule', () => {
    const t = run().totals.current;
    expect(t.netSalesPaise).toBe(410000);
    expect(t.orders).toBe(6);
    expect(t.avgOrderPaise).toBe(68333);
    expect(t.discountPaise).toBe(30000);
    expect(t.taxPaise).toBe(11000); // cgst + sgst only
    expect(t.serviceChargePaise).toBe(5000);
    expect(t.itemsSold).toBe(13);
    expect(t.wastePaise).toBe(10000);
    expect(run().totals.previous?.netSalesPaise).toBe(380000);
    expect(run().totals.changePct.netSalesPaise).toBe(7.9);
  });

  it('cancelled orders are counted separately', () => {
    const t = run().totals.current;
    expect(t.cancelledOrders).toBe(1);
    expect(t.cancelledPaise).toBe(35000);
    expect(t.orders).toBe(6);
  });

  it('change is null when the comparison has no sales', () => {
    const r = aggregate({
      current: { range: CURRENT, orders: currentOrders, waste: currentWaste },
      previous: { range: PREVIOUS, orders: [], waste: [] },
      filters: baseFilters, lookups, labels,
    });
    expect(r.totals.changePct.netSalesPaise).toBeNull();
    expect(r.channels[0].changePct).toBeNull();
  });

  it('channel shares add to 100', () => {
    const r = run();
    expect(r.channels.map((c) => c.label)).toEqual(['Dine-in (table)', 'Delivery', 'Counter', 'QR order']);
    const sum = r.channels.reduce((s, c) => s + c.sharePct, 0);
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.1);
    expect(r.channels[0].current.netSalesPaise).toBe(150000);
    expect(r.channels[0].previous?.netSalesPaise).toBe(230000);
  });

  it('split payments count each method', () => {
    const r = run();
    const upi = r.payments.find((p) => p.key === 'UPI')!;
    const cash = r.payments.find((p) => p.key === 'CASH')!;
    expect(upi.current).toEqual({ netSalesPaise: 250000, orders: 4 });
    expect(cash.current).toEqual({ netSalesPaise: 124000, orders: 2 });
    expect(r.notes).toContain('Payments are amounts received, including tax');
  });

  it('merges same-named categories across outlets into one row', () => {
    const lk: Lookups = {
      items: new Map([
        ['H1', { name: 'Latte', categoryId: 'x1', categoryName: 'Hot Beverages' }],
        ['H2', { name: 'Mocha', categoryId: 'x2', categoryName: 'hot beverages ' }],
      ]),
      outlets: new Map([['o1', 'A'], ['o2', 'B']]),
    };
    const orders = [
      order({ outletId: 'o1', createdAt: ist(17, 13), source: 'TABLE', subtotalPaise: 30000,
        items: [{ menuItemId: 'H1', quantity: 1, subtotalPaise: 10000 }, { menuItemId: 'H2', quantity: 1, subtotalPaise: 20000 }] }),
      order({ outletId: 'o2', createdAt: ist(17, 14), source: 'TABLE', subtotalPaise: 5000,
        items: [{ menuItemId: 'H2', quantity: 1, subtotalPaise: 5000 }] }),
    ];
    const r = aggregate({
      current: { range: CURRENT, orders, waste: [] }, previous: null, filters: baseFilters, lookups: lk,
      labels: { period: labels.period, comparison: null, compareLabel: '' },
    });
    expect(r.categories).toHaveLength(1);
    expect(r.categories[0].label).toBe('Hot Beverages');
    expect(r.categories[0].current).toEqual({ netSalesPaise: 35000, orders: 2 }); // one order holds both ids: counted once
    expect(r.categories[0].sharePct).toBe(100);
  });

  it('merges same-named items across outlets, current and previous', () => {
    const lk: Lookups = {
      items: new Map([
        ['L1', { name: 'Iced Caramel Latte', categoryId: 'x1', categoryName: 'Cold Beverages' }],
        ['L2', { name: 'iced caramel latte ', categoryId: 'x2', categoryName: 'cold beverages' }],
        ['L3', { name: 'Blank', categoryId: 'x3', categoryName: '  ' }],
      ]),
      outlets: new Map([['o1', 'A'], ['o2', 'B']]),
    };
    const mk = (id: string, outletId: string, day: number, qty: number, sales: number) =>
      order({ outletId, createdAt: ist(day, 13), source: 'TABLE', subtotalPaise: sales, items: [{ menuItemId: id, quantity: qty, subtotalPaise: sales }] });
    const r = aggregate({
      current: { range: CURRENT, orders: [mk('L1', 'o1', 17, 2, 20000), mk('L2', 'o2', 17, 3, 30000), mk('L3', 'o1', 17, 1, 5000)], waste: [] },
      previous: { range: PREVIOUS, orders: [mk('L1', 'o1', 15, 1, 10000), mk('L2', 'o2', 15, 1, 10000)], waste: [] },
      filters: baseFilters, lookups: lk, labels,
    });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toEqual({
      menuItemId: 'L1', name: 'Iced Caramel Latte', category: 'Cold Beverages', qty: 5, salesPaise: 50000,
      prevQty: 2, prevSalesPaise: 20000, changePct: 150,
    });
    expect(r.items[1].category).toBe('Uncategorised');
    expect(r.categories.map((c) => c.label)).toEqual(['Cold Beverages', 'Uncategorised']);
  });

  it('category filter keeps matching lines and adds the note', () => {
    const r = run({ ...baseFilters, categoryIds: ['c2'] });
    expect(r.totals.current.netSalesPaise).toBe(160000); // Dal lines only
    expect(r.totals.current.orders).toBe(2);
    expect(r.totals.current.taxPaise).toBe(0);
    expect(r.totals.current.serviceChargePaise).toBe(0);
    expect(r.payments).toEqual([]);
    expect(r.notes).toContain("With a category filter, tax, service charge and payments aren't shown");
    expect(r.notes).toContain("Waste isn't split by channel or category");
  });

  it('channel filter leaves waste unfiltered and adds the note', () => {
    const r = run({ ...baseFilters, sources: ['DELIVERY'] });
    expect(r.totals.current.netSalesPaise).toBe(100000);
    expect(r.totals.current.wastePaise).toBe(10000);
    expect(r.notes).toContain("Waste isn't split by channel or category");
  });

  it('hour filter 12–16 drops a 19:00 order', () => {
    const r = run({ ...baseFilters, hourFrom: 12, hourTo: 16 });
    expect(r.totals.current.orders).toBe(4);
    expect(r.totals.current.netSalesPaise).toBe(330000);
    expect(r.totals.current.wastePaise).toBe(0); // 10:00 and 16:00 are both outside [12, 16)
  });

  it('weekday filter [0,6] keeps weekend orders only', () => {
    expect(run({ ...baseFilters, weekdays: [0, 6] }).totals.current.orders).toBe(6);
    const r = run({ ...baseFilters, weekdays: [0] });
    expect(r.totals.current.orders).toBe(3);
    expect(r.totals.current.netSalesPaise).toBe(190000);
    expect(r.totals.previous?.orders).toBe(0);
  });

  it('items sold only last period show qty 0 now', () => {
    const lonely: RawOrder = order({ outletId: 'o1', createdAt: ist(15, 12), source: 'TABLE', subtotalPaise: 10000,
      items: [{ menuItemId: 'Z', quantity: 1, subtotalPaise: 10000 }] });
    const r = aggregate({
      current: { range: CURRENT, orders: currentOrders, waste: [] },
      previous: { range: PREVIOUS, orders: [...previousOrders, lonely], waste: [] },
      filters: baseFilters, lookups, labels,
    });
    const z = r.items.find((i) => i.menuItemId === 'Z')!;
    expect(z).toMatchObject({ name: 'Unknown item', category: 'Uncategorised', qty: 0, salesPaise: 0, prevQty: 1, prevSalesPaise: 10000 });
    expect(z.changePct).toBe(-100);
    const c = r.items.find((i) => i.menuItemId === 'C')!;
    expect(c).toMatchObject({ qty: 4, salesPaise: 160000, prevQty: 2, prevSalesPaise: 90000, changePct: 77.8 });
  });

  it('trend days line up with the comparison by position', () => {
    const r = run();
    expect(r.trend.granularity).toBe('day');
    expect(r.trend.current.map((b) => b.label)).toEqual(['Sat 17 Oct', 'Sun 18 Oct']);
    expect(r.trend.previous.map((b) => b.label)).toEqual(['Thu 15 Oct', 'Fri 16 Oct']);
    expect(r.trend.current[0]).toMatchObject({ netSalesPaise: 220000, orders: 3, wastePaise: 8000 });
    expect(r.trend.previous[1]).toMatchObject({ netSalesPaise: 280000, orders: 2, wastePaise: 5000 });
    expect(r.trend.current[0].start).toBe(CURRENT.start.toISOString());
  });

  it('weekday and hour rows follow the fixed layout', () => {
    const r = run();
    expect(r.weekdays.map((w) => w.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(r.hours.map((h) => h.label)).toEqual(['12 PM', '1 PM', '2 PM', '3 PM', '7 PM', '8 PM', '9 PM']);
    expect(r.hours[1].key).toBe('13');
    expect(r.waste.map((w) => w.label)).toEqual(['Spoilage', 'Returned', 'Mistake']);
    expect(r.outlets.map((o) => o.label)).toEqual(['Indiranagar', 'Koramangala']);
  });

  it('autoGranularity', () => {
    expect(autoGranularity(days(17, 17))).toBe('hour');
    expect(autoGranularity({ start: businessDayStart(2026, 9, 1), end: new Date(businessDayStart(2026, 10, 1).getTime() - 1) })).toBe('day');
    expect(autoGranularity({ start: businessDayStart(2026, 6, 1), end: new Date(businessDayStart(2026, 9, 1).getTime() - 1) })).toBe('week');
    expect(autoGranularity({ start: businessDayStart(2026, 0, 1), end: new Date(businessDayStart(2027, 0, 1).getTime() - 1) })).toBe('month');
  });

  it('highlights', () => {
    expect(run().highlights).toEqual([
      'Sales ₹4,100, up 7.9% vs 15–16 Oct 2026',
      'Dal Makhani grew the most: +₹700 (77.8%)',
      'Butter Naan fell the most: −₹700',
      'Dine-in (table) was 37% of sales (was 61%)',
      'Waste ₹100, up 100%',
    ]);
    expect(run(baseFilters, false).highlights).toEqual(['Sales ₹4,100', 'Busiest day: Sat 17 Oct (₹2,200)']);
  });

  it('empty period', () => {
    const r = aggregate({
      current: { range: CURRENT, orders: [], waste: [] },
      previous: { range: PREVIOUS, orders: [], waste: [] },
      filters: baseFilters, lookups, labels,
    });
    expect(Object.values(r.totals.current).every((v) => v === 0)).toBe(true);
    expect(Object.values(r.totals.changePct).every((v) => v === null)).toBe(true);
    expect(r.items).toEqual([]);
    expect(r.channels).toEqual([]);
    expect(r.trend.current).toHaveLength(2);
  });
});
