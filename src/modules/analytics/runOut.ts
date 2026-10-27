/*
 * How fast each stock item is used, how much is probably left, and when it runs out.
 *
 * Menu items aren't linked to stock (kitchens don't measure every onion into a dish), so use comes
 * from stock counts:
 *   used between two counts = first count + purchases in between − second count.
 * Until an item has been counted twice there is nothing to predict.
 */
import { prisma } from '../../config/prisma';
import { outletScope } from '../../utils/tenantScope';
import { ONE_DAY_MS } from '../../utils/outletTime';

/** How far back counts and movements are read */
export const WINDOW_DAYS = 42;
/** Items lasting this many days or fewer get a "runs out soon" warning */
export const RUN_OUT_WARN_DAYS = 3;

export type LedgerReason = 'SALE' | 'WASTE' | 'PURCHASE' | 'ADJUSTMENT' | 'COUNT';

export interface LedgerMove {
  itemId: string;
  outletId: string;
  change: number;
  reason: LedgerReason;
  createdAt: Date;
}

export interface ItemOutlook {
  /** Average use per day, in the item's unit */
  dailyUse: number;
  /** Stock probably on the shelf now */
  estimatedStock: number;
  daysLeft: number;
}

/** Stock brought in or moved by hand (counts and sales/waste are what "used" is measured against) */
const isInflow = (reason: LedgerReason) => reason === 'PURCHASE' || reason === 'ADJUSTMENT';
/** Stock taken out between counts that Alayn was told about (logged waste, or older recipe-based sales) */
const isRecordedUse = (reason: LedgerReason) => reason === 'SALE' || reason === 'WASTE';

/** Running stock after each move, given the item's moves (oldest first) and its stock now. */
export function withBalances(moves: LedgerMove[], currentStock: number) {
  let balance = currentStock - moves.reduce((s, m) => s + m.change, 0);
  return moves.map((m) => ({ ...m, balanceAfter: (balance += m.change) }));
}

/**
 * Pure: one item's outlook from its moves in the window (oldest first) and its ledger stock now.
 * Null until the item has two counts a day or more apart, or when it isn't being used.
 */
export function itemOutlook(moves: LedgerMove[], currentStock: number, now: Date): ItemOutlook | null {
  const rows = withBalances(moves, currentStock);
  const counts = rows.filter((r) => r.reason === 'COUNT');
  const first = counts[0];
  const last = counts[counts.length - 1];

  if (!first || !last || last.createdAt.getTime() - first.createdAt.getTime() < ONE_DAY_MS) return null;

  const between = rows.filter((r) => r.createdAt > first.createdAt && r.createdAt <= last.createdAt);
  const inflow = between.filter((r) => isInflow(r.reason)).reduce((s, r) => s + r.change, 0);
  const used = first.balanceAfter + inflow - last.balanceAfter;
  const dailyUse = used / ((last.createdAt.getTime() - first.createdAt.getTime()) / ONE_DAY_MS);
  if (dailyUse <= 0) return null;

  // Since the last count: add purchases, take off the usual daily use (or what was recorded, if more)
  const since = rows.filter((r) => r.createdAt > last.createdAt);
  const inflowSince = since.filter((r) => isInflow(r.reason)).reduce((s, r) => s + r.change, 0);
  const recordedSince = -since.filter((r) => isRecordedUse(r.reason)).reduce((s, r) => s + r.change, 0);
  const expectedSince = (dailyUse * (now.getTime() - last.createdAt.getTime())) / ONE_DAY_MS;
  const estimatedStock = Math.max(0, last.balanceAfter + inflowSince - Math.max(expectedSince, recordedSince));
  return { dailyUse, estimatedStock, daysLeft: estimatedStock / dailyUse };
}

/** Stock moves in the window for the outlet (or the caller's business), oldest first. */
export async function loadLedgerMoves(outletId: string | undefined, businessId: string | undefined, now: Date): Promise<LedgerMove[]> {
  const rows = await prisma.stockLedgerEntry.findMany({
    where: { ...outletScope(outletId, businessId), createdAt: { gte: new Date(now.getTime() - WINDOW_DAYS * ONE_DAY_MS), lte: now } },
    select: { itemId: true, outletId: true, change: true, reason: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({ ...r, change: r.change.toNumber() }));
}

/** Outlook for every item that is being used, keyed by item id. */
export async function stockOutlook(
  outletId: string | undefined,
  businessId: string | undefined,
  now: Date,
  items: { id: string; currentStock: number }[],
): Promise<Map<string, ItemOutlook>> {
  const moves = await loadLedgerMoves(outletId, businessId, now);
  const byItem = new Map<string, LedgerMove[]>();
  for (const m of moves) {
    const list = byItem.get(m.itemId) ?? [];
    list.push(m);
    byItem.set(m.itemId, list);
  }
  const result = new Map<string, ItemOutlook>();
  for (const item of items) {
    const outlook = itemOutlook(byItem.get(item.id) ?? [], item.currentStock, now);
    if (outlook) result.set(item.id, outlook);
  }
  return result;
}
