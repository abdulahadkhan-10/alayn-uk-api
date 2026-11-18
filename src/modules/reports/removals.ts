import { prisma } from '../../config/prisma';
import { describeRange, resolvePeriod } from './periods';
import { ReportRequest } from './query';

// Enough for any real period; the totals and per-person figures still cover everything
const MAX_ROWS = 500;

export interface RemovalTotals { removals: number; quantity: number; amountPence: number }

export interface RemovedItemsReport {
  period: { label: string };
  // afterServed: the food went to the table and was then taken off the bill, the case most worth checking
  totals: RemovalTotals & { afterServedRemovals: number; afterServedPence: number };
  byPerson: (RemovalTotals & { key: string; name: string; role: string })[];
  byReason: (RemovalTotals & { reason: string })[];
  rows: {
    id: string;
    at: string;
    orderNumber: string;
    tableNumber: number | null;
    outletName: string;
    itemName: string;
    quantity: number;
    amountPence: number;
    reason: string;
    itemStage: string;
    removedByName: string;
    removedByRole: string;
  }[];
  truncated: boolean;
}

function tally<K extends string>(map: Map<K, RemovalTotals>, key: K, quantity: number, amountPence: number) {
  const t = map.get(key) ?? { removals: 0, quantity: 0, amountPence: 0 };
  t.removals += 1;
  t.quantity += quantity;
  t.amountPence += amountPence;
  map.set(key, t);
}

// Reasons are "Preset: extra detail"; group on the preset so the same reason isn't split by its notes
const reasonGroup = (reason: string) => reason.split(':')[0].trim() || 'No reason';

/** Items taken off bills in the period: who removed them, what they were worth and why. */
export async function buildRemovedItemsReport(req: ReportRequest, outletIds: string[], now: Date = new Date()): Promise<RemovedItemsReport> {
  const range = resolvePeriod(req.preset, now, req.custom);
  const sources = req.filters.sources;

  const [removals, outlets] = await Promise.all([
    prisma.orderItemRemoval.findMany({
      where: {
        outletId: { in: outletIds },
        createdAt: { gte: range.start, lte: range.end },
        ...(sources && sources.length > 0 ? { order: { source: { in: sources } } } : {}),
      },
      include: { order: { select: { orderNumber: true, tableNumber: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.outlet.findMany({ where: { id: { in: outletIds } }, select: { id: true, name: true } }),
  ]);
  const outletNames = new Map(outlets.map((o) => [o.id, o.name]));

  const totals = { removals: 0, quantity: 0, amountPence: 0, afterServedRemovals: 0, afterServedPence: 0 };
  const people = new Map<string, RemovalTotals>();
  const personInfo = new Map<string, { name: string; role: string }>();
  const reasons = new Map<string, RemovalTotals>();

  for (const r of removals) {
    totals.removals += 1;
    totals.quantity += r.quantity;
    totals.amountPence += r.amountPence;
    if (r.itemStage === 'SERVED') {
      totals.afterServedRemovals += 1;
      totals.afterServedPence += r.amountPence;
    }

    const personKey = r.removedById ?? `name:${r.removedByName}`;
    personInfo.set(personKey, { name: r.removedByName, role: r.removedByRole });
    tally(people, personKey, r.quantity, r.amountPence);
    tally(reasons, reasonGroup(r.reason), r.quantity, r.amountPence);
  }

  const byValue = (a: RemovalTotals, b: RemovalTotals) => b.amountPence - a.amountPence || b.removals - a.removals;

  return {
    period: { label: describeRange(range, now) },
    totals,
    byPerson: [...people.entries()].map(([key, t]) => ({ key, ...personInfo.get(key)!, ...t })).sort(byValue),
    byReason: [...reasons.entries()].map(([reason, t]) => ({ reason, ...t })).sort(byValue),
    rows: removals.slice(0, MAX_ROWS).map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      orderNumber: r.order.orderNumber ?? r.orderId.slice(0, 8).toUpperCase(),
      tableNumber: r.order.tableNumber ?? null,
      outletName: outletNames.get(r.outletId) ?? '',
      itemName: r.itemName,
      quantity: r.quantity,
      amountPence: r.amountPence,
      reason: r.reason,
      itemStage: r.itemStage,
      removedByName: r.removedByName,
      removedByRole: r.removedByRole,
    })),
    truncated: removals.length > MAX_ROWS,
  };
}
