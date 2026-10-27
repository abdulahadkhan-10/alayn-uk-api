/*
 * Extra facts for AlaynAI beyond the basic snapshot: past days and weeks, typical hourly sales,
 * per-outlet totals, today's roster and attendance, expiring stock, and every item's sales.
 * Each section is built independently; if one fails it says "unavailable"
 * instead of breaking the assistant. Amounts are settled sales before tax (same rule as the dashboard).
 */
import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { menuItemScope, outletScope, isAllOutlets } from '../../utils/tenantScope';
import { ONE_DAY_MS, businessDayStart, businessParts, outletLocalParts, businessStartOfDay } from '../../utils/outletTime';
import { detectPeriods, DetectedPeriod } from './periodParse';
import { buildReport } from '../reports/report.service';
import { businessOutletIds } from '../reports/access';
import { ReportRequest } from '../reports/query';
import { DayStrings, PeriodPreset } from '../reports/periods';
import { ReportData, formatRupees } from '../reports/aggregate';
import { clock12, getStaffToday, instant12 } from '../analytics/staffToday';

/*
 * Which parts of the café's data a question needs. Sending only those keeps each question to a
 * fraction of the tokens (Groq limits are per minute and per day). A question that matches no topic,
 * like "How is business?", gets everything.
 */
export type Topic = 'sales' | 'staff' | 'stock' | 'menu';
export const ALL_TOPICS: readonly Topic[] = ['sales', 'staff', 'stock', 'menu'];

const TOPIC_WORDS: Record<Topic, RegExp> = {
  sales: /\b(sales?|sell|sold|revenue|earn(ing|ings)?|income|turnover|forecast\w*|predict\w*|projection|busy|busiest|quiet|peak|rush|footfall|orders?|aov|average order|compare|comparison|report|breakdown|vs|versus|trend|growth|hours?)\b/,
  staff: /\b(staff\w*|employees?|team|roster\w*|shifts?|clock(ed)? ?(in|out)|attendance|late|leave|on duty|off duty|working|works|chef|manager|waiter|cashier|barista|hire|hiring|labou?r)\b/,
  stock: /\b(stock|inventory|ingredients?|expir\w*|wast\w*|spoil\w*|reorder|purchase|suppliers?|run(ning)? (out|low)|low on)\b/,
  menu: /\b(menu|dish(es)?|drinks?|products?|margins?|profit\w*|food cost|price|pricing|best ?sellers?|top sellers?|bestsellers?|worst|popular|recipes?)\b/,
};

/** Topics in the question (plus earlier questions in the same conversation); all of them if none match. */
export function detectTopics(text: string): Set<Topic> {
  const found = mentionedTopics(text);
  return new Set(found.length ? found : ALL_TOPICS);
}

/** Only the topics whose words actually appear (no all-topics fallback). */
export function mentionedTopics(text: string): Topic[] {
  const t = text.toLowerCase();
  return ALL_TOPICS.filter((topic) => TOPIC_WORDS[topic].test(t));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ENUM = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
const pct = (current: number, previous: number) =>
  previous > 0 ? `${current >= previous ? '+' : ''}${(((current - previous) / previous) * 100).toFixed(1)}%` : 'n/a';
const dayKey = (instant: Date) => {
  const { year, month, day } = businessParts(instant);
  return `${year}-${month}-${day}`;
};
const dayName = (instant: Date) => {
  const { weekday, day, month } = businessParts(instant);
  return `${WEEKDAYS[weekday]} ${day} ${MONTHS[month]}`;
};
const hourName = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;

export interface SettledOrder {
  createdAt: Date;
  subtotalPaise: number;
  outletId: string;
}

/**
 * Past-sales facts from settled orders: the last 14 days one by one, this week vs last week,
 * this month vs the same days last month, last month's total, and typical sales per hour.
 * Pure (no database) so it can be tested directly.
 */
export function summariseSales(orders: SettledOrder[], now: Date): string[] {
  const todayStart = businessStartOfDay(now);
  const { year, month, day } = businessParts(now);
  const byDay = new Map<string, number>();
  for (const o of orders) byDay.set(dayKey(o.createdAt), (byDay.get(dayKey(o.createdAt)) ?? 0) + o.subtotalPaise);
  const dayTotal = (start: Date) => byDay.get(dayKey(start)) ?? 0;
  const daysAgo = (n: number) => new Date(todayStart.getTime() - n * ONE_DAY_MS);

  const lines: string[] = [];

  const last14 = Array.from({ length: 14 }, (_, k) => daysAgo(14 - k));
  lines.push(`- Daily sales, last 14 days: ${last14.map((d) => `${dayName(d)} ${rupees(dayTotal(d))}`).join(', ')}`);

  const sumDays = (from: number, to: number) => {
    let total = 0;
    for (let n = from; n <= to; n++) total += dayTotal(daysAgo(n));
    return total;
  };
  const last7 = sumDays(1, 7);
  const prev7 = sumDays(8, 14);
  lines.push(`- Last 7 days ${rupees(last7)} vs the 7 days before ${rupees(prev7)} (${pct(last7, prev7)})`);

  // Complete days only, so a half-finished today doesn't look like a drop
  const thisMonthStart = businessDayStart(year, month, 1);
  const lastMonthStart = businessDayStart(year, month - 1, 1);
  const lastMonth = businessParts(lastMonthStart);
  let lastMonthTotal = 0;
  let lastMonthSameDays = 0;
  let thisMonthComplete = 0;
  for (const o of orders) {
    const t = o.createdAt.getTime();
    if (t >= lastMonthStart.getTime() && t < thisMonthStart.getTime()) {
      lastMonthTotal += o.subtotalPaise;
      if (businessParts(o.createdAt).day < day) lastMonthSameDays += o.subtotalPaise;
    } else if (t >= thisMonthStart.getTime() && t < todayStart.getTime()) {
      thisMonthComplete += o.subtotalPaise;
    }
  }
  if (day > 1) {
    lines.push(
      `- This month, 1–${day - 1} ${MONTHS[month]} (complete days): ${rupees(thisMonthComplete)} vs 1–${day - 1} ${MONTHS[lastMonth.month]}: ${rupees(lastMonthSameDays)} (${pct(thisMonthComplete, lastMonthSameDays)})`,
    );
  }
  lines.push(`- Last month (${MONTHS[lastMonth.month]} ${lastMonth.year}) total: ${rupees(lastMonthTotal)}`);

  // Typical sales per hour over the last 4 weeks, averaged over days that had sales
  const fourWeeksAgo = daysAgo(28).getTime();
  const byHour = new Array(24).fill(0);
  const tradingDays = new Set<string>();
  for (const o of orders) {
    const t = o.createdAt.getTime();
    if (t < fourWeeksAgo || t >= todayStart.getTime()) continue;
    byHour[outletLocalParts(o.createdAt).hour] += o.subtotalPaise;
    tradingDays.add(dayKey(o.createdAt));
  }
  if (tradingDays.size > 0) {
    const avg = byHour.map((total) => total / tradingDays.size);
    const hours = avg.map((v, h) => ({ h, v })).filter((x) => x.v > 0);
    const busiest = [...hours].sort((a, b) => b.v - a.v).slice(0, 3).map((x) => hourName(x.h));
    lines.push(
      `- Typical sales by hour (average per trading day, last 4 weeks, ${tradingDays.size} days): ${hours.map((x) => `${hourName(x.h)} ${rupees(x.v)}`).join(', ')}`,
    );
    lines.push(`- Busiest hours: ${busiest.join(', ')}`);
  } else {
    lines.push('- Typical sales by hour: no sales in the last 4 weeks');
  }
  return lines;
}

async function salesSection(outletId: string | undefined, businessId: string | undefined, now: Date): Promise<string[]> {
  const scope = outletScope(outletId, businessId);
  const { year, month } = businessParts(now);
  const from = Math.min(businessDayStart(year, month - 1, 1).getTime(), businessStartOfDay(now).getTime() - 28 * ONE_DAY_MS);
  const orders = await prisma.order.findMany({
    where: { ...scope, status: 'COMPLETED', deletedAt: null, createdAt: { gte: new Date(from) } },
    select: { createdAt: true, subtotalPaise: true, outletId: true },
  });
  const lines = summariseSales(orders, now);

  if (isAllOutlets(outletId) && businessId) {
    const outlets = await prisma.outlet.findMany({ where: { businessId, deletedAt: null }, select: { id: true, name: true } });
    const todayStart = businessStartOfDay(now).getTime();
    const monthStart = businessDayStart(year, month, 1).getTime();
    const per = outlets.map((o) => {
      let today = 0;
      let mtd = 0;
      for (const ord of orders) {
        if (ord.outletId !== o.id) continue;
        const t = ord.createdAt.getTime();
        if (t >= monthStart) mtd += ord.subtotalPaise;
        if (t >= todayStart) today += ord.subtotalPaise;
      }
      return `${o.name}: today ${rupees(today)}, this month ${rupees(mtd)}`;
    });
    if (per.length) lines.push(`- Sales by outlet: ${per.join('; ')}`);
  }
  return lines;
}

async function rosterSection(outletId: string | undefined, businessId: string | undefined, now: Date): Promise<string[]> {
  const scope = outletScope(outletId, businessId);
  const activeEmployee = { deletedAt: null, status: 'ACTIVE' as const };
  const withOutlet = isAllOutlets(outletId);
  const who = (e: { name: string; role: string; outletName?: string | null }) =>
    `${e.name} (${e.role.toLowerCase()}${withOutlet && e.outletName ? `, ${e.outletName}` : ''})`;
  const employeeSelect = { name: true, role: true, id: true, outlet: { select: { name: true } } };

  // Same source as the Overview's Shift Coverage card, so AlaynAI and the dashboard always agree
  const { weekday, rosterSource, entries } = await getStaffToday(outletId, businessId, now);
  const lines: string[] = [];
  const working = entries.filter((e) => e.shift);
  const off = entries.filter((e) => e.status === 'off');
  if (rosterSource === 'none') {
    lines.push(`- Today's roster (${WEEKDAYS[weekday]}): none set up in Alayn`);
  } else {
    lines.push(
      `- Today's roster (${WEEKDAYS[weekday]}): ${working.map((e) => `${who(e)} ${e.shift!.name} ${clock12(e.shift!.startTime)}–${clock12(e.shift!.endTime)}`).join('; ') || 'nobody rostered'}`,
    );
    if (off.length) lines.push(`- Weekly off today: ${off.map(who).join(', ')}`);
  }
  const clockedIn = entries.filter((e) => e.clockIn);
  if (clockedIn.length) {
    lines.push(
      `- Clocked in today (as of ${instant12(now)}): ${clockedIn.map((e) => `${who(e)} in at ${instant12(e.clockIn!)}${e.late ? ' (late)' : ''}${e.clockOut ? `, out at ${instant12(e.clockOut)}` : ', still in'}`).join('; ')}`,
    );
  }
  const notIn = entries.filter((e) => e.status === 'not_in');
  if (notIn.length) lines.push(`- Shift started but not clocked in: ${notIn.map(who).join(', ')}`);
  const upcoming = entries.filter((e) => e.status === 'upcoming');
  if (upcoming.length) lines.push(`- Shift later today: ${upcoming.map((e) => `${who(e)} from ${clock12(e.shift!.startTime)}`).join(', ')}`);
  const leave = entries.filter((e) => e.status === 'leave');
  if (leave.length) lines.push(`- On approved leave today: ${leave.map(who).join(', ')}`);

  // The usual weekly roster, so "who works on Saturday?" can be answered too
  const template = await prisma.employeeRoster.findMany({
    where: { ...scope, shiftId: { not: null }, employee: activeEmployee },
    select: { dayOfWeek: true, employee: { select: employeeSelect }, shift: { select: { name: true } } },
    take: 300,
  });
  if (template.length) {
    const order = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
    const days = order.map((wd) => {
      const people = template.filter((r) => r.dayOfWeek === DAY_ENUM[wd]);
      const names = people.slice(0, 12).map((r) => `${r.employee.name} (${r.shift!.name})`).join(', ');
      return `${WEEKDAYS[wd]} ${people.length} staff${people.length ? `: ${names}${people.length > 12 ? ', …' : ''}` : ''}`;
    });
    lines.push(`- Usual weekly roster (date-specific changes may apply): ${days.join('; ')}`);
  } else {
    lines.push('- Usual weekly roster: none set up in Alayn');
  }
  return lines;
}

async function stockSection(outletId: string | undefined, businessId: string | undefined, now: Date): Promise<string[]> {
  const scope = outletScope(outletId, businessId);
  const weekAhead = new Date(now.getTime() + 7 * ONE_DAY_MS);
  const batch = { quantity: true, expiryDate: true, item: { select: { name: true, unit: true } } };
  const [expiring, expired] = await Promise.all([
    prisma.stockBatch.findMany({
      where: { ...scope, quantity: { gt: 0 }, expiryDate: { gte: now, lte: weekAhead }, item: { deletedAt: null } },
      select: batch,
      orderBy: { expiryDate: 'asc' },
      take: 40,
    }),
    prisma.stockBatch.findMany({
      where: { ...scope, quantity: { gt: 0 }, expiryDate: { lt: now }, item: { deletedAt: null } },
      select: batch,
      orderBy: { expiryDate: 'desc' },
      take: 20,
    }),
  ]);
  const describe = (rows: typeof expiring, verb: string) => {
    const byItem = new Map<string, { qty: number; unit: string; date: Date }>();
    for (const r of rows) {
      const cur = byItem.get(r.item.name) ?? { qty: 0, unit: r.item.unit, date: r.expiryDate };
      cur.qty += Number(r.quantity);
      if (r.expiryDate < cur.date) cur.date = r.expiryDate;
      byItem.set(r.item.name, cur);
    }
    return [...byItem].slice(0, 12).map(([name, v]) => `${name} ${+v.qty.toFixed(2)} ${v.unit} (${verb} ${dayName(v.date)})`).join(', ');
  };
  return [
    `- Stock expiring in the next 7 days: ${expiring.length ? describe(expiring, 'expires') : 'None'}`,
    `- Expired but still in stock: ${expired.length ? describe(expired, 'expired') : 'None'}`,
  ];
}

async function menuSection(outletId: string | undefined, businessId: string | undefined, now: Date): Promise<string[]> {
  const scope = outletScope(outletId, businessId);
  const { year, month } = businessParts(now);
  const monthStart = businessDayStart(year, month, 1);
  const sold = await prisma.orderItem.groupBy({
    by: ['menuItemId'],
    where: { order: { ...scope, status: 'COMPLETED', deletedAt: null, createdAt: { gte: monthStart } } },
    _sum: { quantity: true, subtotalPaise: true },
    orderBy: { _sum: { quantity: 'desc' } },
    take: 30,
  });
  const [soldItems, activeItems] = await Promise.all([
    prisma.menuItem.findMany({
      where: { id: { in: sold.map((s) => s.menuItemId) } },
      select: { id: true, name: true, pricePaise: true },
    }),
    prisma.menuItem.findMany({
      where: { ...menuItemScope(outletId, businessId), isActive: true, deletedAt: null },
      select: { id: true, name: true },
      take: 200,
    }),
  ]);
  const info = new Map(soldItems.map((m) => [m.id, m]));
  const rows = sold.map((s) => {
    const m = info.get(s.menuItemId);
    if (!m) return null;
    return `${m.name}: ${s._sum.quantity ?? 0} sold, ${rupees(s._sum.subtotalPaise ?? 0)}, price ${rupees(m.pricePaise)}`;
  }).filter(Boolean);

  const soldIds = new Set(sold.map((s) => s.menuItemId));
  const unsold = activeItems.filter((m) => !soldIds.has(m.id)).map((m) => m.name);
  return [
    `- Menu items this month (completed orders, before tax): ${rows.length ? rows.join('; ') : 'none sold yet'}`,
    // Menu items aren't linked to stock, so there is no food cost per dish to quote
    '- Food cost and margin per dish: not tracked in Alayn (menu items are not linked to stock). Say so if asked; compare dishes by sales instead',
    `- Active menu items not sold at all this month: ${unsold.length ? unsold.slice(0, 20).join(', ') : 'None'}`,
  ];
}

const changeText = (c: number | null | undefined) => (c == null ? 'n/a' : `${c >= 0 ? '+' : ''}${c.toFixed(1)}%`);

/** The figures of one report as plain lines for the model. Pure. */
export function reportToContextLines(r: ReportData): string[] {
  const cur = r.totals.current;
  const prev = r.totals.previous;
  const ch = r.totals.changePct;
  const lines: string[] = [
    r.comparison
      ? `- Period: ${r.period.label} (current) compared with ${r.comparison.label} (earlier)`
      : `- Period: ${r.period.label} (current), no comparison`,
  ];
  const metric = (name: string, key: keyof typeof cur, money: boolean) => {
    const fmt = (n: number) => (money ? formatRupees(n) : n.toLocaleString('en-IN'));
    lines.push(prev ? `- ${name}: ${fmt(cur[key])} now vs ${fmt(prev[key])} before (${changeText(ch[key])})` : `- ${name}: ${fmt(cur[key])}`);
  };
  metric('Sales', 'netSalesPaise', true);
  metric('Orders', 'orders', false);
  metric('Average order value', 'avgOrderPaise', true);
  metric('Discounts', 'discountPaise', true);
  metric('Tax', 'taxPaise', true);
  metric('Cancelled orders', 'cancelledOrders', false);
  metric('Cancelled order value', 'cancelledPaise', true);
  metric('Stock wasted', 'wastePaise', true);

  const rows = (title: string, list: ReportData['channels']) => {
    const parts = list.map((c) =>
      `${c.label} ${formatRupees(c.current.netSalesPaise)} (${c.sharePct.toFixed(1)}% of sales${c.previous ? `, ${changeText(c.changePct)}` : ''})`);
    if (parts.length) lines.push(`- ${title}: ${parts.join('; ')}`);
  };
  rows('Channels', r.channels);
  rows('Payments', r.payments);

  const itemPart = (i: ReportData['items'][number]) =>
    `${i.name} ${formatRupees(i.salesPaise)} (${i.qty} sold${i.prevSalesPaise != null ? `, ${changeText(i.changePct)}` : ''})`;
  if (r.items.length) lines.push(`- Top items (item sales before bill discounts): ${r.items.slice(0, 10).map(itemPart).join('; ')}`);
  const drops = r.items.filter((i) => i.changePct != null && i.changePct < 0 && i.prevSalesPaise != null)
    .sort((a, b) => (a.salesPaise - (a.prevSalesPaise ?? 0)) - (b.salesPaise - (b.prevSalesPaise ?? 0))).slice(0, 5);
  if (drops.length) lines.push(`- Biggest item drops: ${drops.map(itemPart).join('; ')}`);

  rows('Weekdays', r.weekdays);
  if (r.highlights.length) lines.push(`- Highlights: ${r.highlights.join(' | ')}`);
  return lines;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
export const dayStrings = (range: { start: Date; end: Date }): DayStrings => {
  const s = businessParts(range.start);
  const e = businessParts(range.end);
  return { from: `${s.year}-${pad2(s.month + 1)}-${pad2(s.day)}`, to: `${e.year}-${pad2(e.month + 1)}-${pad2(e.day)}` };
};
export const periodDaysOf = (p: DetectedPeriod): DayStrings => (p.preset === 'CUSTOM' && p.custom ? p.custom : dayStrings(p.range));

interface ReportPlan { request: ReportRequest; link: string; title: string }

/** `current` is the period being reported; `earlier` is what it is compared with (null = the period just before it). */
function planReport(current: DetectedPeriod, earlier: DetectedPeriod | null): ReportPlan {
  const preset: PeriodPreset = current.preset;
  const custom = preset === 'CUSTOM' ? periodDaysOf(current) : undefined;
  const params: string[] = [`preset=${preset}`];
  if (custom) params.push(`from=${custom.from}`, `to=${custom.to}`);
  const request: ReportRequest = { preset, custom, compare: 'PREVIOUS', filters: {} };
  if (earlier) {
    const cc = periodDaysOf(earlier);
    request.compare = 'CUSTOM';
    request.compareCustom = cc;
    params.push('compare=CUSTOM', `cFrom=${cc.from}`, `cTo=${cc.to}`);
  } else {
    params.push('compare=PREVIOUS');
  }
  return { request, link: `/reports?${params.join('&')}`, title: earlier ? `${current.label} vs ${earlier.label}` : current.label };
}

const UNAVAILABLE = '- Unavailable right now. Do NOT guess these figures.';

/**
 * Report figures for the periods a question names (any month, quarter, date range...), built by the
 * same engine as the Reports page. Empty when the question names no period. The latest period is the
 * current one; each earlier one (up to two) is compared against. A single period is compared with the one before it.
 */
export async function reportsSection(
  text: string,
  outletId: string | undefined,
  businessId: string | undefined,
  now: Date,
): Promise<string[]> {
  const detected = detectPeriods(text, now);
  if (detected.length === 0) return [];

  try {
    let outletIds: string[];
    if (outletId === 'all') {
      if (!businessId) throw new Error('All outlets needs a business');
      outletIds = await businessOutletIds(businessId);
    } else if (outletId) {
      outletIds = [outletId];
    } else {
      throw new Error('No outlet selected');
    }
    if (outletIds.length === 0) throw new Error('No outlets to report on');

    // Latest first; a range named twice counts once
    const sorted = [...detected].sort((a, b) => b.range.start.getTime() - a.range.start.getTime());
    const periods = sorted.filter((p, i) =>
      sorted.findIndex((q) => q.range.start.getTime() === p.range.start.getTime() && q.range.end.getTime() === p.range.end.getTime()) === i);
    const [latest, ...earlier] = periods;
    const plans = earlier.length === 0 ? [planReport(latest, null)] : earlier.slice(0, 2).map((e) => planReport(latest, e));

    const lines: string[] = [];
    for (const plan of plans) {
      const report = await buildReport(plan.request, outletIds, now);
      if (plans.length > 1) lines.push(`- Report: ${plan.title}`);
      lines.push(...reportToContextLines(report), `- Full report link: ${plan.link}`);
    }
    return lines;
  } catch (err) {
    logger.error({ err, outletId }, '[AlaynAI] Report section failed');
    return [UNAVAILABLE];
  }
}

export async function buildExtendedContext(
  outletId?: string,
  businessId?: string,
  now: Date = new Date(),
  topics: Set<Topic> = new Set(ALL_TOPICS),
): Promise<string> {
  const builders: [Topic, string, () => Promise<string[]>][] = [
    ['sales', 'Sales history', () => salesSection(outletId, businessId, now)],
    ['staff', 'Staff today', () => rosterSection(outletId, businessId, now)],
    ['stock', 'Stock expiry', () => stockSection(outletId, businessId, now)],
    ['menu', 'Menu performance', () => menuSection(outletId, businessId, now)],
  ];
  // Only the sections this question needs are built (and sent)
  const sections = builders
    .filter(([topic]) => topics.has(topic))
    .map(([, title, build]): [string, Promise<string[]>] => [title, build()]);
  const parts = await Promise.all(
    sections.map(async ([title, lines]) => {
      try {
        return [`[${title.toUpperCase()}]`, ...(await lines)].join('\n');
      } catch (err) {
        logger.error({ err, outletId, section: title }, '[AlaynAI] Context section failed');
        return `[${title.toUpperCase()}]\n- Unavailable right now. Do NOT guess these figures.`;
      }
    }),
  );
  return parts.join('\n');
}
