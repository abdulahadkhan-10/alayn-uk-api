import { DateRange, pctChange, periodDays } from './periods';
import { ONE_DAY_MS, BUSINESS_DAY_START_HOUR, businessDayStart, businessParts, outletDayStart, outletLocalParts } from '../../utils/outletTime';

// Pure report aggregation: turns loaded orders and waste rows into the ReportData that every
// report surface (API, PDF, Excel, page, Ask Alayn, emails) renders. No database access here.
// Money stays in integer paise. Every hour/weekday/day bucket is computed in India time.

export type Channel = 'TABLE' | 'QR' | 'COUNTER' | 'DELIVERY';
export type Granularity = 'hour' | 'day' | 'week' | 'month';

export interface ReportFilters {
  outletIds: string[];
  sources?: Channel[];
  categoryIds?: string[];
  weekdays?: number[]; // 0 = Sunday … 6
  hourFrom?: number;
  hourTo?: number; // 0–24, [from, to)
  granularity?: Granularity; // undefined = auto
}

export interface RawOrder {
  id: string; outletId: string; createdAt: Date; source: Channel; status: string;
  subtotalPaise: number; discountPaise: number; cgstPaise: number; sgstPaise: number; serviceTaxPaise: number;
  items: { menuItemId: string; quantity: number; subtotalPaise: number }[];
  payments: { method: 'UPI' | 'CARD' | 'CASH' | 'SWIGGY' | 'ZOMATO' | 'EAZYDINER'; amountPaise: number }[]; // CONFIRMED payments only
}

export interface RawWaste {
  outletId: string; createdAt: Date; reason: 'SPOILAGE' | 'OVER_PREP' | 'RETURN' | 'ERROR'; costAtLoggingPaise: number;
}

export interface Lookups {
  items: Map<string, { name: string; categoryId: string | null; categoryName: string }>;
  outlets: Map<string, string>;
}

export interface Totals {
  netSalesPaise: number; orders: number; avgOrderPaise: number; discountPaise: number; taxPaise: number;
  serviceChargePaise: number; cancelledOrders: number; cancelledPaise: number; wastePaise: number; itemsSold: number;
}
export interface Figures { netSalesPaise: number; orders: number }
export interface BreakdownRow {
  key: string; label: string; current: Figures; previous: Figures | null; changePct: number | null; sharePct: number;
}
export interface ItemRow {
  menuItemId: string; name: string; category: string; qty: number; salesPaise: number;
  prevQty: number | null; prevSalesPaise: number | null; changePct: number | null;
}
export interface TrendBucket { label: string; start: string; netSalesPaise: number; orders: number; wastePaise: number }

export interface ReportData {
  period: { start: string; end: string; label: string };
  comparison: { start: string; end: string; label: string; compareLabel: string } | null;
  totals: { current: Totals; previous: Totals | null; changePct: Partial<Record<keyof Totals, number | null>> };
  trend: { granularity: Granularity; current: TrendBucket[]; previous: TrendBucket[] };
  channels: BreakdownRow[]; payments: BreakdownRow[]; categories: BreakdownRow[]; outlets: BreakdownRow[];
  hours: BreakdownRow[]; weekdays: BreakdownRow[]; waste: BreakdownRow[]; // waste: netSalesPaise holds cost, orders holds entries
  items: ItemRow[]; highlights: string[]; notes: string[];
}

interface PeriodInput { range: DateRange; orders: RawOrder[]; waste: RawWaste[] }
interface AggregateInput {
  current: PeriodInput; previous: PeriodInput | null; filters: ReportFilters; lookups: Lookups;
  labels: { period: string; comparison: string | null; compareLabel: string };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
const HOUR_MS = 60 * 60 * 1000;
const CHANNEL_LABELS: Record<Channel, string> = { TABLE: 'Dine-in (table)', QR: 'QR order', COUNTER: 'Counter', DELIVERY: 'Delivery' };
const PAYMENT_LABELS: Record<string, string> = {
  UPI: 'UPI',
  CARD: 'Card',
  CASH: 'Cash',
  SWIGGY: 'Swiggy',
  ZOMATO: 'Zomato',
  EAZYDINER: 'EazyDiner',
};
const WASTE_LABELS: Record<string, string> = { SPOILAGE: 'Spoilage', OVER_PREP: 'Over-preparation', RETURN: 'Returned', ERROR: 'Mistake' };
const MIN_ITEM_MOVE_PAISE = 50000; // ₹500
const MIN_SHARE_MOVE_POINTS = 5;
const MIN_WASTE_MOVE_PCT = 20;

const round1 = (n: number) => Math.round(n * 10) / 10;
const zero = (): Figures => ({ netSalesPaise: 0, orders: 0 });

export function formatRupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  return `${sign}₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export function autoGranularity(range: DateRange): Granularity {
  const d = periodDays(range);
  if (d <= 1) return 'hour';
  if (d <= 62) return 'day';
  if (d <= 180) return 'week';
  return 'month';
}

// ---------- normalising orders ----------

interface NormOrder {
  outletId: string; at: Date; source: Channel; settled: boolean;
  salesPaise: number; discountPaise: number; taxPaise: number; serviceChargePaise: number;
  payments: RawOrder['payments']; lines: { id: string; qty: number; salesPaise: number }[];
}

const hourOk = (at: Date, f: ReportFilters) => {
  const { hour } = outletLocalParts(at);
  return hour >= (f.hourFrom ?? 0) && hour < (f.hourTo ?? 24);
};
const weekdayOk = (at: Date, f: ReportFilters) =>
  !f.weekdays || f.weekdays.length === 0 || f.weekdays.includes(businessParts(at).weekday); // 1:30 AM Saturday counts as Friday

function normalise(orders: RawOrder[], f: ReportFilters, lookups: Lookups): NormOrder[] {
  const cats = f.categoryIds && f.categoryIds.length > 0 ? new Set(f.categoryIds) : null;
  const out: NormOrder[] = [];
  for (const o of orders) {
    if (o.status !== 'COMPLETED' && o.status !== 'CANCELLED') continue;
    if (f.sources && f.sources.length > 0 && !f.sources.includes(o.source)) continue;
    if (!weekdayOk(o.createdAt, f) || !hourOk(o.createdAt, f)) continue;
    let lines = o.items.map((i) => ({ id: i.menuItemId, qty: i.quantity, salesPaise: i.subtotalPaise }));
    if (cats) {
      lines = lines.filter((l) => {
        const cat = lookups.items.get(l.id)?.categoryId;
        return cat != null && cats.has(cat);
      });
      if (lines.length === 0) continue;
    }
    out.push({
      outletId: o.outletId, at: o.createdAt, source: o.source, settled: o.status === 'COMPLETED', lines,
      // A category filter can't apportion bill-level discount, tax, service charge or payments.
      salesPaise: cats ? lines.reduce((s, l) => s + l.salesPaise, 0) : o.subtotalPaise - o.discountPaise,
      discountPaise: cats ? 0 : o.discountPaise,
      taxPaise: cats ? 0 : o.cgstPaise + o.sgstPaise,
      serviceChargePaise: cats ? 0 : o.serviceTaxPaise,
      payments: cats ? [] : o.payments,
    });
  }
  return out;
}

const filterWaste = (waste: RawWaste[], f: ReportFilters) =>
  waste.filter((w) => weekdayOk(w.createdAt, f) && hourOk(w.createdAt, f));

function totalsOf(orders: NormOrder[], waste: RawWaste[]): Totals {
  const t: Totals = {
    netSalesPaise: 0, orders: 0, avgOrderPaise: 0, discountPaise: 0, taxPaise: 0, serviceChargePaise: 0,
    cancelledOrders: 0, cancelledPaise: 0, wastePaise: 0, itemsSold: 0,
  };
  for (const o of orders) {
    if (!o.settled) {
      t.cancelledOrders += 1;
      t.cancelledPaise += o.salesPaise;
      continue;
    }
    t.orders += 1;
    t.netSalesPaise += o.salesPaise;
    t.discountPaise += o.discountPaise;
    t.taxPaise += o.taxPaise;
    t.serviceChargePaise += o.serviceChargePaise;
    t.itemsSold += o.lines.reduce((s, l) => s + l.qty, 0);
  }
  t.avgOrderPaise = t.orders > 0 ? Math.round(t.netSalesPaise / t.orders) : 0;
  t.wastePaise = waste.reduce((s, w) => s + w.costAtLoggingPaise, 0);
  return t;
}

// ---------- breakdown rows ----------

type FigMap = Map<string, Figures>;
function bump(map: FigMap, key: string, net: number, orders = 1) {
  const f = map.get(key) ?? zero();
  f.netSalesPaise += net;
  f.orders += orders;
  map.set(key, f);
}

function buildRows(cur: FigMap, prev: FigMap | null, labelOf: (key: string) => string, order?: string[]): BreakdownRow[] {
  const keys = order ?? [...new Set([...cur.keys(), ...(prev?.keys() ?? [])])];
  const total = [...cur.values()].reduce((s, f) => s + f.netSalesPaise, 0);
  const rows = keys.map((key): BreakdownRow => {
    const current = cur.get(key) ?? zero();
    const previous = prev ? prev.get(key) ?? zero() : null;
    return {
      key, label: labelOf(key), current, previous,
      changePct: previous ? pctChange(current.netSalesPaise, previous.netSalesPaise) : null,
      sharePct: total > 0 ? round1((current.netSalesPaise / total) * 100) : 0,
    };
  });
  if (order) return rows;
  return rows.sort((a, b) =>
    b.current.netSalesPaise - a.current.netSalesPaise ||
    (b.previous?.netSalesPaise ?? 0) - (a.previous?.netSalesPaise ?? 0) ||
    a.key.localeCompare(b.key));
}

interface Maps {
  channels: FigMap; payments: FigMap; categories: FigMap; outlets: FigMap; hours: FigMap; weekdays: FigMap; waste: FigMap;
}

// Each outlet has its own copy of every category, so categories are merged by name
// (trimmed, case-insensitive). The first spelling seen becomes the label.
const NO_CATEGORY = ' none'; // leading space can't clash with a trimmed name
function categoryKeyOf(info: { categoryId: string | null; categoryName: string } | undefined): string {
  if (!info || info.categoryId == null) return NO_CATEGORY;
  return info.categoryName.trim().toLowerCase() || NO_CATEGORY; // blank names count as uncategorised
}

function categoryKey(itemId: string, lookups: Lookups, labels: Map<string, string>): string {
  const info = lookups.items.get(itemId);
  const key = categoryKeyOf(info);
  if (key !== NO_CATEGORY && !labels.has(key)) labels.set(key, info!.categoryName.trim());
  return key;
}

function breakdownMaps(orders: NormOrder[], waste: RawWaste[], lookups: Lookups, categoryLabels: Map<string, string>): Maps {
  const m: Maps = {
    channels: new Map(), payments: new Map(), categories: new Map(), outlets: new Map(),
    hours: new Map(), weekdays: new Map(), waste: new Map(),
  };
  for (const o of orders) {
    if (!o.settled) continue;
    const { hour } = outletLocalParts(o.at); // real clock hour
    const { weekday } = businessParts(o.at); // business day (5 AM to 5 AM)
    bump(m.channels, o.source, o.salesPaise);
    bump(m.outlets, o.outletId, o.salesPaise);
    bump(m.hours, String(hour), o.salesPaise);
    bump(m.weekdays, String(weekday), o.salesPaise);
    for (const method of new Set(o.payments.map((p) => p.method))) {
      bump(m.payments, method, o.payments.filter((p) => p.method === method).reduce((s, p) => s + p.amountPaise, 0));
    }
    const perCategory = new Map<string, number>();
    for (const l of o.lines) {
      const key = categoryKey(l.id, lookups, categoryLabels);
      perCategory.set(key, (perCategory.get(key) ?? 0) + l.salesPaise);
    }
    perCategory.forEach((sales, key) => bump(m.categories, key, sales));
  }
  for (const w of waste) {
    bump(m.waste, w.reason, w.costAtLoggingPaise);
    if (!m.outlets.has(w.outletId)) m.outlets.set(w.outletId, zero()); // outlet had waste but no sales
  }
  return m;
}

// Each outlet has its own copy of every menu item, so items merge by name plus merged category.
function itemGroupKey(id: string, lookups: Lookups): string {
  const info = lookups.items.get(id);
  return info ? `${info.name.trim().toLowerCase()}|${categoryKeyOf(info)}` : `?${id}`;
}

function itemRows(cur: NormOrder[], prev: NormOrder[] | null, lookups: Lookups): ItemRow[] {
  const first = new Map<string, string>(); // group key -> first-seen menu item id
  const sum = (orders: NormOrder[]) => {
    const map = new Map<string, { qty: number; sales: number }>();
    for (const o of orders) {
      if (!o.settled) continue;
      for (const l of o.lines) {
        const key = itemGroupKey(l.id, lookups);
        if (!first.has(key)) first.set(key, l.id);
        const e = map.get(key) ?? { qty: 0, sales: 0 };
        e.qty += l.qty;
        e.sales += l.salesPaise;
        map.set(key, e);
      }
    }
    return map;
  };
  const c = sum(cur);
  const p = prev ? sum(prev) : null;
  const keys = new Set([...c.keys(), ...(p?.keys() ?? [])]);
  return [...keys].map((key): ItemRow => {
    const id = first.get(key)!;
    const info = lookups.items.get(id);
    const now = c.get(key) ?? { qty: 0, sales: 0 };
    const before = p ? p.get(key) ?? { qty: 0, sales: 0 } : null;
    return {
      menuItemId: id, name: info?.name.trim() ?? 'Unknown item',
      category: info && categoryKeyOf(info) !== NO_CATEGORY ? info.categoryName.trim() : 'Uncategorised',
      qty: now.qty, salesPaise: now.sales,
      prevQty: before ? before.qty : null, prevSalesPaise: before ? before.sales : null,
      changePct: before ? pctChange(now.sales, before.sales) : null,
    };
  }).sort((a, b) => b.salesPaise - a.salesPaise || a.name.localeCompare(b.name));
}

// ---------- trend buckets ----------

function bucketStart(at: Date, g: Granularity): Date {
  if (g === 'hour') {
    const c = outletLocalParts(at); // clock hour
    return new Date(outletDayStart(c.year, c.month, c.day).getTime() + c.hour * HOUR_MS);
  }
  // Days, weeks and months are business days: 5 AM to 5 AM
  const { year, month, day, weekday } = businessParts(at);
  switch (g) {
    case 'day': return businessDayStart(year, month, day);
    case 'week': return businessDayStart(year, month, day - ((weekday + 6) % 7)); // weeks start Monday
    default: return businessDayStart(year, month, 1);
  }
}

function nextBucket(start: Date, g: Granularity): Date {
  if (g === 'hour') return new Date(start.getTime() + HOUR_MS);
  if (g === 'day') return new Date(start.getTime() + ONE_DAY_MS);
  if (g === 'week') return new Date(start.getTime() + 7 * ONE_DAY_MS);
  const p = businessParts(start);
  return businessDayStart(p.year, p.month + 1, 1);
}

function bucketLabel(start: Date, g: Granularity): string {
  const p = g === 'hour' ? outletLocalParts(start) : businessParts(start);
  if (g === 'hour') return `${p.hour % 12 === 0 ? 12 : p.hour % 12} ${p.hour < 12 ? 'AM' : 'PM'}`;
  if (g === 'day') return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month]}`;
  if (g === 'week') return `w/c ${p.day} ${MONTHS[p.month]}`;
  return `${MONTHS[p.month]} ${p.year}`;
}

function trendOf(range: DateRange, orders: NormOrder[], waste: RawWaste[], g: Granularity): TrendBucket[] {
  const buckets = new Map<number, TrendBucket>();
  for (let s = bucketStart(range.start, g); s.getTime() <= range.end.getTime(); s = nextBucket(s, g)) {
    buckets.set(s.getTime(), { label: bucketLabel(s, g), start: s.toISOString(), netSalesPaise: 0, orders: 0, wastePaise: 0 });
  }
  for (const o of orders) {
    const b = o.settled ? buckets.get(bucketStart(o.at, g).getTime()) : undefined;
    if (b) { b.netSalesPaise += o.salesPaise; b.orders += 1; }
  }
  for (const w of waste) {
    const b = buckets.get(bucketStart(w.createdAt, g).getTime());
    if (b) b.wastePaise += w.costAtLoggingPaise;
  }
  return [...buckets.values()];
}

// ---------- highlights ----------

export function buildHighlights(r: Omit<ReportData, 'highlights'>): string[] {
  const out: string[] = [];
  const cur = r.totals.current;
  const sales = r.totals.changePct.netSalesPaise;
  const compareText = r.comparison ? r.comparison.compareLabel.replace(/^vs /, '') : '';

  if (r.comparison && sales != null) {
    out.push(`Sales ${formatRupees(cur.netSalesPaise)}, ${sales >= 0 ? 'up' : 'down'} ${Math.abs(sales)}% vs ${compareText}`);
  } else {
    out.push(`Sales ${formatRupees(cur.netSalesPaise)}`);
  }

  if (!r.comparison) {
    if (r.trend.granularity === 'day') {
      const best = r.trend.current.reduce<TrendBucket | null>((b, x) => (!b || x.netSalesPaise > b.netSalesPaise ? x : b), null);
      if (best && best.netSalesPaise > 0) out.push(`Busiest day: ${best.label} (${formatRupees(best.netSalesPaise)})`);
    }
    return out.slice(0, 5);
  }

  const moves = r.items
    .filter((i) => i.prevSalesPaise != null)
    .map((i) => ({ item: i, delta: i.salesPaise - (i.prevSalesPaise as number) }));
  const gain = moves.reduce<(typeof moves)[number] | null>((b, m) => (!b || m.delta > b.delta ? m : b), null);
  if (gain && gain.delta >= MIN_ITEM_MOVE_PAISE) {
    const pct = gain.item.changePct != null ? ` (${gain.item.changePct}%)` : '';
    out.push(`${gain.item.name} grew the most: +${formatRupees(gain.delta)}${pct}`);
  }
  const drop = moves.reduce<(typeof moves)[number] | null>((b, m) => (!b || m.delta < b.delta ? m : b), null);
  if (drop && -drop.delta >= MIN_ITEM_MOVE_PAISE) out.push(`${drop.item.name} fell the most: −${formatRupees(-drop.delta)}`);

  const prevSales = r.totals.previous?.netSalesPaise ?? 0;
  if (prevSales > 0 && cur.netSalesPaise > 0) {
    let best: { label: string; now: number; was: number } | null = null;
    for (const c of r.channels) {
      const now = (c.current.netSalesPaise / cur.netSalesPaise) * 100;
      const was = ((c.previous?.netSalesPaise ?? 0) / prevSales) * 100;
      if (Math.abs(now - was) >= MIN_SHARE_MOVE_POINTS && (!best || Math.abs(now - was) > Math.abs(best.now - best.was))) {
        best = { label: c.label, now, was };
      }
    }
    if (best) out.push(`${best.label} was ${Math.round(best.now)}% of sales (was ${Math.round(best.was)}%)`);
  }

  const waste = r.totals.changePct.wastePaise;
  if (waste != null && Math.abs(waste) >= MIN_WASTE_MOVE_PCT) {
    out.push(`Waste ${formatRupees(cur.wastePaise)}, ${waste >= 0 ? 'up' : 'down'} ${Math.abs(waste)}%`);
  }
  return out.slice(0, 5);
}

// ---------- main ----------

export function aggregate(input: AggregateInput): ReportData {
  const { filters, lookups, labels } = input;
  const curOrders = normalise(input.current.orders, filters, lookups);
  const curWaste = filterWaste(input.current.waste, filters);
  const prevOrders = input.previous ? normalise(input.previous.orders, filters, lookups) : null;
  const prevWaste = input.previous ? filterWaste(input.previous.waste, filters) : [];
  const hasPrev = input.previous != null && prevOrders != null;

  const current = totalsOf(curOrders, curWaste);
  const previous = hasPrev ? totalsOf(prevOrders, prevWaste) : null;
  const changePct: ReportData['totals']['changePct'] = {};
  if (previous) {
    (Object.keys(current) as (keyof Totals)[]).forEach((k) => { changePct[k] = pctChange(current[k], previous[k]); });
  }

  const categoryLabels = new Map<string, string>();
  const cm = breakdownMaps(curOrders, curWaste, lookups, categoryLabels);
  const pm = hasPrev ? breakdownMaps(prevOrders, prevWaste, lookups, categoryLabels) : null;
  const rows = (k: keyof Maps, labelOf: (key: string) => string, order?: string[]) =>
    buildRows(cm[k], pm ? pm[k] : null, labelOf, order);

  const categoryName = (key: string) => categoryLabels.get(key) ?? 'Uncategorised';
  const hasData = (key: string, k: keyof Maps) =>
    (cm[k].get(key)?.netSalesPaise ?? 0) > 0 || (pm?.[k].get(key)?.netSalesPaise ?? 0) > 0;
  // Hours in business-day order (5 AM first, 4 AM last) so late-night sales follow the evening
  const hourKeys = Array.from({ length: 24 }, (_, i) => String((i + BUSINESS_DAY_START_HOUR) % 24)).filter((h) => hasData(h, 'hours'));

  const granularity = filters.granularity ?? autoGranularity(input.current.range);
  const hasCategoryFilter = !!filters.categoryIds && filters.categoryIds.length > 0;
  const hasChannelFilter = !!filters.sources && filters.sources.length > 0;
  const notes: string[] = [];
  if (hasCategoryFilter) notes.push("With a category filter, tax, service charge and payments aren't shown");
  else notes.push('Payments are amounts received, including tax');
  if (hasCategoryFilter || hasChannelFilter) notes.push("Waste isn't split by channel or category");

  const base: Omit<ReportData, 'highlights'> = {
    period: { start: input.current.range.start.toISOString(), end: input.current.range.end.toISOString(), label: labels.period },
    comparison: input.previous && labels.comparison != null ? {
      start: input.previous.range.start.toISOString(), end: input.previous.range.end.toISOString(),
      label: labels.comparison, compareLabel: labels.compareLabel,
    } : null,
    totals: { current, previous, changePct },
    trend: {
      granularity,
      current: trendOf(input.current.range, curOrders, curWaste, granularity),
      previous: input.previous && prevOrders ? trendOf(input.previous.range, prevOrders, prevWaste, granularity) : [],
    },
    channels: rows('channels', (k) => CHANNEL_LABELS[k as Channel] ?? k),
    payments: rows('payments', (k) => PAYMENT_LABELS[k] ?? k),
    categories: rows('categories', categoryName),
    outlets: rows('outlets', (k) => lookups.outlets.get(k) ?? 'Unknown outlet'),
    hours: rows('hours', (k) => bucketLabel(new Date(outletDayStart(2026, 0, 1).getTime() + Number(k) * HOUR_MS), 'hour'), hourKeys),
    weekdays: rows('weekdays', (k) => WEEKDAYS[Number(k)], MONDAY_FIRST.map(String)),
    waste: rows('waste', (k) => WASTE_LABELS[k] ?? k),
    items: itemRows(curOrders, prevOrders, lookups),
    notes,
  };
  return { ...base, highlights: buildHighlights(base) };
}
