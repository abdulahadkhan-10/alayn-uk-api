import { prisma } from '../../config/prisma';
import { aggregate, Channel, Lookups, RawOrder, RawWaste, ReportData } from './aggregate';
import AppError from '../../utils/AppError';
import { compareLabel, comparisonPeriod, DateRange, describeRange, periodDays, resolvePeriod } from './periods';
import { ReportRequest } from './query';

export const CHANNELS: { key: Channel; label: string }[] = [
  { key: 'TABLE', label: 'Dine-in (table)' },
  { key: 'QR', label: 'QR order' },
  { key: 'COUNTER', label: 'Counter' },
  { key: 'DELIVERY', label: 'Delivery' },
];

// Longer periods would give hundreds of hourly buckets
const MAX_HOURLY_DAYS = 7;

async function loadPeriod(range: DateRange, outletIds: string[], sources?: Channel[]) {
  const createdAt = { gte: range.start, lte: range.end };
  const [orders, waste] = await Promise.all([
    prisma.order.findMany({
      where: {
        outletId: { in: outletIds },
        status: { in: ['COMPLETED', 'CANCELLED'] },
        deletedAt: null,
        createdAt,
        ...(sources && sources.length > 0 ? { source: { in: sources } } : {}),
      },
      select: {
        id: true, outletId: true, createdAt: true, source: true, status: true,
        subtotalPaise: true, discountPaise: true, cgstPaise: true, sgstPaise: true, serviceTaxPaise: true,
        items: { select: { menuItemId: true, quantity: true, subtotalPaise: true } },
        payments: { where: { status: 'CONFIRMED' }, select: { method: true, amountPaise: true } },
      },
    }),
    prisma.wasteLog.findMany({
      where: { outletId: { in: outletIds }, createdAt },
      select: { outletId: true, createdAt: true, reason: true, costAtLoggingPaise: true },
    }),
  ]);
  return { range, orders: orders as unknown as RawOrder[], waste: waste as unknown as RawWaste[] };
}

export async function buildReport(
  req: ReportRequest,
  outletIds: string[],
  now: Date = new Date(),
): Promise<ReportData & { scope: { outletNames: string[]; businessName: string } }> {
  const current = resolvePeriod(req.preset, now, req.custom);
  if (req.filters.granularity === 'hour' && periodDays(current) > MAX_HOURLY_DAYS) {
    throw new AppError('BAD_REQUEST', 'Hourly view works for up to 7 days. Pick Day, Week or Month.', 400);
  }
  const cmp = comparisonPeriod(current, req.compare, now, req.compareCustom);
  const sources = req.filters.sources;

  const [cur, prev] = await Promise.all([
    loadPeriod(current, outletIds, sources),
    cmp ? loadPeriod(cmp, outletIds, sources) : Promise.resolve(null),
  ]);

  const itemIds = [...new Set([...cur.orders, ...(prev?.orders ?? [])].flatMap((o) => o.items.map((i) => i.menuItemId)))];
  const [menuItems, outlets] = await Promise.all([
    itemIds.length
      ? prisma.menuItem.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true, categoryId: true, category: { select: { name: true } } },
        })
      : Promise.resolve([]),
    prisma.outlet.findMany({
      where: { id: { in: outletIds } },
      select: { id: true, name: true, business: { select: { name: true } } },
    }),
  ]);

  const lookups: Lookups = {
    items: new Map(menuItems.map((m) => [m.id, { name: m.name, categoryId: m.categoryId ?? null, categoryName: m.category?.name ?? 'Uncategorised' }])),
    outlets: new Map(outlets.map((o) => [o.id, o.name])),
  };

  const data = aggregate({
    current: cur,
    previous: prev,
    filters: { ...req.filters, outletIds },
    lookups,
    labels: {
      period: describeRange(current, now),
      // Comparison label and previous data are either both present or both absent.
      comparison: cmp ? describeRange(cmp, now) : null,
      compareLabel: compareLabel(current, req.compare, cmp, now),
    },
  });

  return {
    ...data,
    scope: { outletNames: outlets.map((o) => o.name), businessName: outlets[0]?.business?.name ?? '' },
  };
}

export async function reportOptions(outletIds: string[]) {
  const [outlets, categories, first] = await Promise.all([
    prisma.outlet.findMany({ where: { id: { in: outletIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.menuCategory.findMany({
      where: { outletId: { in: outletIds }, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.order.findFirst({
      where: { outletId: { in: outletIds }, status: 'COMPLETED', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  return { outlets, categories, channels: CHANNELS, earliestSale: first ? first.createdAt.toISOString() : null };
}
