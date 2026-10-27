/*
 * "Needs attention" for the Overview: the few things an owner should act on right now, most urgent
 * first. Uses the same rules as the rest of Alayn: stock levels come from the Inventory page's stock
 * ledger, staff from the Shift Coverage card, bills from orders not settled or cancelled.
 */
import { prisma } from '../../config/prisma';
import { InventoryRepository } from '../inventory/inventory.repository';
import { isAllOutlets, outletScope } from '../../utils/tenantScope';
import { ONE_DAY_MS, outletLocalParts, outletStartOfDay } from '../../utils/outletTime';
import { clock12, getStaffToday, instant12 } from './staffToday';
import { RUN_OUT_WARN_DAYS, stockOutlook } from './runOut';

export type AttentionKind = 'expired_stock' | 'staff_not_in' | 'stale_bills' | 'low_stock' | 'runs_out_soon' | 'expiring_soon';

export interface AttentionItem {
  kind: AttentionKind;
  severity: 'high' | 'medium';
  title: string; // "2 staff not clocked in"
  detail: string; // "Head Waiter (shift started 4 PM), Service Staff (8 AM)"
  href: string; // where to fix it
}

/** A bill still open after this long has probably been forgotten (normal open orders show in Active Orders). */
const STALE_BILL_MS = 2 * 60 * 60 * 1000;
const EXPIRY_WINDOW_DAYS = 3;
const MAX_NAMES = 3;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
const qty = (n: number) => `${+n.toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "A, B, C and 2 more" */
const list = (names: string[]) =>
  names.length <= MAX_NAMES ? names.join(', ') : `${names.slice(0, MAX_NAMES).join(', ')} and ${names.length - MAX_NAMES} more`;

/** "today", "tomorrow", "in 3 days" (outlet-local calendar days) */
function daysFromToday(date: Date, now: Date): string {
  const diff = Math.round((outletStartOfDay(date).getTime() - outletStartOfDay(now).getTime()) / ONE_DAY_MS);
  return diff <= 0 ? 'today' : diff === 1 ? 'tomorrow' : `in ${diff} days`;
}

/** "3:10 PM" if today, otherwise "yesterday" or the date */
function whenOpened(instant: Date, now: Date): string {
  const diff = Math.round((outletStartOfDay(now).getTime() - outletStartOfDay(instant).getTime()) / ONE_DAY_MS);
  if (diff <= 0) return instant12(instant);
  if (diff === 1) return 'yesterday';
  const { day, month } = outletLocalParts(instant);
  return `${day} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month]}`;
}

/** "in ~2 days (Sat)", "by tomorrow" at the current rate of use */
export function runOutWhen(days: number, now: Date): string {
  const whole = Math.floor(days);
  if (whole <= 0) return 'by end of today';
  if (whole === 1) return 'by tomorrow';
  const { weekday } = outletLocalParts(new Date(now.getTime() + whole * ONE_DAY_MS));
  return `in ~${whole} days (${WEEKDAYS[weekday]})`;
}

export async function getAttention(outletId?: string, businessId?: string, now: Date = new Date()): Promise<AttentionItem[]> {
  // "All outlets" without a business must match nothing, never every business
  if (isAllOutlets(outletId) && !businessId) return [];
  const scope = outletScope(outletId, businessId);
  const withOutlet = isAllOutlets(outletId);
  const at = (name: string, outlet?: string | null) => (withOutlet && outlet ? `${name} (${outlet})` : name);

  const [{ items, outlook }, batches, openOrders, staff] = await Promise.all([
    new InventoryRepository()
      .findManyItems(outletId ?? 'all', businessId)
      .then(async (items) => ({ items, outlook: await stockOutlook(outletId, businessId, now, items) })),
    prisma.stockBatch.findMany({
      where: {
        ...scope,
        quantity: { gt: 0 },
        expiryDate: { lte: new Date(now.getTime() + EXPIRY_WINDOW_DAYS * ONE_DAY_MS) },
        item: { deletedAt: null },
      },
      select: { quantity: true, expiryDate: true, item: { select: { id: true, name: true, unit: true } }, outlet: { select: { name: true } } },
      orderBy: { expiryDate: 'asc' },
    }),
    prisma.order.findMany({
      where: { ...scope, status: { notIn: ['COMPLETED', 'CANCELLED'] }, deletedAt: null, createdAt: { lte: new Date(now.getTime() - STALE_BILL_MS) } },
      select: { totalPaise: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    getStaffToday(outletId, businessId, now),
  ]);

  const result: AttentionItem[] = [];

  // Expired stock still on the shelf: food safety, so it comes first
  const expired = new Map<string, string>();
  const expiringSoon = new Map<string, { label: string; date: Date }>();
  for (const b of batches) {
    const key = `${b.item.id}`;
    if (b.expiryDate < now) {
      if (!expired.has(key)) expired.set(key, at(b.item.name, b.outlet?.name));
    } else if (!expiringSoon.has(key)) {
      expiringSoon.set(key, { label: `${at(b.item.name, b.outlet?.name)} ${daysFromToday(b.expiryDate, now)}`, date: b.expiryDate });
    }
  }
  if (expired.size) {
    result.push({
      kind: 'expired_stock',
      severity: 'high',
      title: `${plural(expired.size, 'item')} expired but still in stock`,
      detail: list([...expired.values()]),
      href: '/inventory',
    });
  }

  const notIn = staff.entries.filter((e) => e.status === 'not_in');
  if (notIn.length) {
    result.push({
      kind: 'staff_not_in',
      severity: 'high',
      title: `${plural(notIn.length, 'person', 'people')} not clocked in`,
      detail: list(notIn.map((e) => `${at(e.name, e.outletName)} (shift started ${clock12(e.shift!.startTime)})`)),
      href: '/workforce',
    });
  }

  if (openOrders.length) {
    const total = openOrders.reduce((s, o) => s + o.totalPaise, 0);
    result.push({
      kind: 'stale_bills',
      severity: 'medium',
      title: `${plural(openOrders.length, 'bill')} open for over 2 hours`,
      detail: `${rupees(total)} not settled · oldest opened ${whenOpened(openOrders[0].createdAt, now)}`,
      href: '/orders',
    });
  }

  const low = items.filter((i) => i.currentStock <= i.reorderThreshold);
  if (low.length) {
    result.push({
      kind: 'low_stock',
      severity: 'medium',
      title: `${plural(low.length, 'item')} running low`,
      detail: list(low.map((i) => `${at(i.name, i.outlet?.name)} (${qty(i.currentStock)} ${i.unit} left)`)),
      href: '/inventory',
    });
  }

  // Not low yet, but at the recent rate of use it won't last the next few days
  const runningOut = items
    .filter((i) => i.currentStock > i.reorderThreshold)
    .map((i) => ({ item: i, days: outlook.get(i.id)?.daysLeft ?? null }))
    .filter((r): r is { item: (typeof items)[number]; days: number } => r.days !== null && r.days <= RUN_OUT_WARN_DAYS)
    .sort((a, b) => a.days - b.days);
  if (runningOut.length) {
    result.push({
      kind: 'runs_out_soon',
      severity: 'medium',
      title: `${plural(runningOut.length, 'item')} will run out in the next ${RUN_OUT_WARN_DAYS} days`,
      detail: list(runningOut.map((r) => `${at(r.item.name, r.item.outlet?.name)} ${runOutWhen(r.days, now)}`)),
      href: '/inventory',
    });
  }

  if (expiringSoon.size) {
    result.push({
      kind: 'expiring_soon',
      severity: 'medium',
      title: `${plural(expiringSoon.size, 'item')} expiring in the next ${EXPIRY_WINDOW_DAYS} days`,
      detail: list([...expiringSoon.values()].map((e) => e.label)),
      href: '/inventory',
    });
  }

  return result;
}
