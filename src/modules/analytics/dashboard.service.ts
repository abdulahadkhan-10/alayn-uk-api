import { prisma } from '../../config/prisma';
import {
  BUSINESS_DAY_START_HOUR,
  ONE_DAY_MS,
  businessParts,
  businessStartOfDay,
  outletLocalParts,
} from '../../utils/outletTime';
import {
  combineForecasts,
  DayInput,
  EARLY_ESTIMATE_SALES_DAYS,
  forecastOutlet,
  FULL_FORECAST_SALES_DAYS,
  LOOKBACK_DAYS,
} from './forecast';
import { clock12, getStaffToday, instant12, StaffStatus } from './staffToday';
import { computeTodayPace, loadPaceOrders } from './todayPace';
import { flagStaffing, rosteredStaffByDate } from './staffingWeek';
import { menuItemScope } from '../../utils/tenantScope';
import { compareLabel, comparisonPeriod, describeRange, PeriodPreset, resolvePeriod } from '../reports/periods';

const STAFF_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** A dish that hasn't sold for this long is a "slow mover" (dishes newer than this are left out) */
const SLOW_MOVER_DAYS = 14;

// Shift Coverage order: who needs attention first, then who's working, then everyone else
const STAFF_ORDER: StaffStatus[] = ['not_in', 'in', 'upcoming', 'left', 'leave', 'off'];

/*
 * Money rules used everywhere on the dashboard:
 *  - Revenue = SETTLED (COMPLETED) orders only, measured BEFORE taxes (order subtotal).
 *    GST / service charge collected is reported separately — it isn't the outlet's income.
 *  - Orders still open (in the kitchen / unpaid) are reported separately as "open bills".
 *  - All dates and hours are India time (see utils/outletTime), not the server's UTC clock.
 */
const SETTLED = 'COMPLETED' as const;

type ScopeFilter = Record<string, unknown>;

/** What the Overview's range picker sends, as report periods. */
const DASHBOARD_PRESETS: Record<string, PeriodPreset> = {
  TODAY: 'TODAY',
  YESTERDAY: 'YESTERDAY',
  '7_DAY': 'LAST_7_DAYS',
  THIS_MONTH: 'THIS_MONTH',
  LAST_MONTH: 'LAST_MONTH',
  CUSTOM: 'CUSTOM',
};

/** Past days shown on the forecast chart for each range option. */
const FORECAST_RANGES: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
const WEEKDAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isoDate({ year, month, day }: { year: number; month: number; day: number }) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function forecastLabel(date: string, isToday: boolean) {
  if (isToday) return 'Today';
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** Weekdays the outlet opens (0 = Sunday), or null when not configured (treat every day as open). */
function parseOperatingDays(json: string | null): Set<number> | null {
  if (!json) return null;
  try {
    const names: unknown = JSON.parse(json);
    if (!Array.isArray(names) || names.length === 0) return null;
    return new Set(names.map((n) => WEEKDAY_NAMES.indexOf(String(n).toUpperCase())).filter((i) => i >= 0));
  } catch {
    return null;
  }
}

function formatCurrency(paise: number) {
  const sign = paise < 0 ? '-' : '';
  return `${sign}₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function percentChange(current: number, previous: number) {
  if (previous > 0) {
    const diffPct = ((current - previous) / previous) * 100;
    return { change: `${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%`, increased: diffPct >= 0 };
  }
  // Nothing to compare with (e.g. a café's first sales): no percentage, rather than a fake "+100%"
  if (current > 0) return { change: '', increased: true };
  return { change: '0.0%', increased: true };
}

export class DashboardService {
  /** Which orders/items/waste are in scope: one outlet, or all outlets of the caller's business. */
  private scopeFilter(outletId?: string, businessId?: string): ScopeFilter {
    const isAll = !outletId || outletId === 'all';
    if (!isAll) return { outletId };
    // Never fall back to "every business" when the caller has no business: match nothing instead
    return businessId ? { outlet: { businessId } } : { id: { in: [] } };
  }

  /** The dashboard's range options as a resolved period. Anything unknown means this month so far. */
  private resolveRange(range?: string, startDateStr?: string, endDateStr?: string, now: Date = new Date()) {
    const preset = DASHBOARD_PRESETS[range ?? ''] ?? 'THIS_MONTH';
    if (preset === 'CUSTOM') {
      return startDateStr && endDateStr
        ? resolvePeriod('CUSTOM', now, { from: startDateStr, to: endDateStr })
        : resolvePeriod('THIS_MONTH', now);
    }
    return resolvePeriod(preset, now);
  }

  private getDateRangeBounds(range?: string, startDateStr?: string, endDateStr?: string, now: Date = new Date()) {
    const { start, end } = this.resolveRange(range, startDateStr, endDateStr, now);
    return { startDate: start, endDate: end };
  }

  private async periodFigures(scope: ScopeFilter, startDate: Date, endDate: Date) {
    const settledOrders = await prisma.order.findMany({
      where: { ...scope, status: SETTLED, createdAt: { gte: startDate, lte: endDate }, deletedAt: null },
      select: { id: true, subtotalPaise: true, discountPaise: true, cgstPaise: true, sgstPaise: true, serviceTaxPaise: true },
    });
    // Net food sales (after discount). GST is the government's; service charge is reported separately.
    const revenuePaise = settledOrders.reduce((sum, o) => sum + o.subtotalPaise - o.discountPaise, 0);
    const taxPaise = settledOrders.reduce((sum, o) => sum + o.cgstPaise + o.sgstPaise, 0);
    const serviceChargePaise = settledOrders.reduce((sum, o) => sum + o.serviceTaxPaise, 0);

    const waste = await prisma.wasteLog.findMany({
      where: { ...scope, createdAt: { gte: startDate, lte: endDate } },
      select: { costAtLoggingPaise: true },
    });
    const wasteCostPaise = waste.reduce((sum, w) => sum + w.costAtLoggingPaise, 0);

    return {
      orderCount: settledOrders.length,
      revenuePaise,
      taxPaise,
      serviceChargePaise,
      wasteCostPaise,
    };
  }

  async getKpis(outletId?: string, businessId?: string, range?: string, startDateStr?: string, endDateStr?: string) {
    const scope = this.scopeFilter(outletId, businessId);
    const now = new Date();
    const period = this.resolveRange(range, startDateStr, endDateStr, now);
    const { start: startDate, end: endDate } = period;

    // Compare like with like: the same stretch of the previous day, week, month, ...
    const previousRange = comparisonPeriod(period, 'PREVIOUS', now)!;
    const { start: prevStartDate, end: prevEndDate } = previousRange;

    const current = await this.periodFigures(scope, startDate, endDate);
    const previous = await this.periodFigures(scope, prevStartDate, prevEndDate);

    // Bills placed in this period that are not settled yet (not counted as revenue)
    const openOrders = await prisma.order.findMany({
      where: {
        ...scope,
        status: { notIn: [SETTLED, 'CANCELLED'] },
        createdAt: { gte: startDate, lte: endDate },
        deletedAt: null,
      },
      select: { totalPaise: true },
    });
    const openBillsPaise = openOrders.reduce((sum, o) => sum + o.totalPaise, 0);

    const revenue = percentChange(current.revenuePaise, previous.revenuePaise);
    // Menu items aren't linked to stock (kitchens don't measure every ingredient), so there is no food
    // cost or margin to show; what the owner does know is the stock they logged as wasted
    const waste = percentChange(current.wasteCostPaise, previous.wasteCostPaise);

    const avgOrderPaise = current.orderCount > 0 ? Math.round(current.revenuePaise / current.orderCount) : 0;
    const prevAvgOrderPaise = previous.orderCount > 0 ? Math.round(previous.revenuePaise / previous.orderCount) : 0;
    const avgOrder = percentChange(avgOrderPaise, prevAvgOrderPaise);
    const orders = percentChange(current.orderCount, previous.orderCount);

    // 5. Active staff
    const activeStaffCount = await prisma.employee.count({
      where: { ...scope, status: 'ACTIVE', deletedAt: null },
    });
    const previousStaffCount = await prisma.employee.count({
      where: { ...scope, status: 'ACTIVE', createdAt: { lte: prevEndDate }, deletedAt: null },
    });
    const diffStaff = activeStaffCount - previousStaffCount;

    return {
      comparison: {
        label: compareLabel(period, 'PREVIOUS', previousRange, now),
        current: describeRange(period, now),
        previous: describeRange(previousRange, now),
      },
      totalRevenue: {
        value: formatCurrency(current.revenuePaise),
        prev: formatCurrency(previous.revenuePaise),
        change: revenue.change,
        isPositive: revenue.increased,
      },
      avgOrderValue: {
        value: formatCurrency(avgOrderPaise),
        prev: formatCurrency(prevAvgOrderPaise),
        change: avgOrder.change,
        isPositive: avgOrder.increased,
      },
      orders: {
        value: current.orderCount.toLocaleString('en-IN'),
        prev: previous.orderCount.toLocaleString('en-IN'),
        change: orders.change,
        isPositive: orders.increased,
      },
      // Less waste is the good direction
      waste: {
        value: formatCurrency(current.wasteCostPaise),
        prev: formatCurrency(previous.wasteCostPaise),
        change: waste.change,
        isPositive: current.wasteCostPaise <= previous.wasteCostPaise,
      },
      laborCosts: { value: `${activeStaffCount} Staff`, change: `${diffStaff >= 0 ? '+' : ''}${diffStaff}`, isPositive: diffStaff >= 0 },
      // Reported separately from revenue
      taxCollected: { value: formatCurrency(current.taxPaise) }, // CGST + SGST only
      serviceCharge: { value: formatCurrency(current.serviceChargePaise) },
      openBills: { value: formatCurrency(openBillsPaise), count: openOrders.length },
    };
  }

  async getSalesVelocity(outletId?: string, businessId?: string, range?: string, startDateStr?: string, endDateStr?: string) {
    const scope = this.scopeFilter(outletId, businessId);
    const { startDate, endDate } = this.getDateRangeBounds(range, startDateStr, endDateStr);

    const periodOrders = await prisma.order.findMany({
      where: { ...scope, status: SETTLED, createdAt: { gte: startDate, lte: endDate }, deletedAt: null },
      select: { createdAt: true, subtotalPaise: true },
    });

    // 2-hour buckets on clock hours, India time, in business-day order: from the bucket holding 5 AM
    // (4 AM) round to 2 AM, so late-night sales come after the evening, as on Today's Pace and Reports
    const firstBucket = Math.floor(BUSINESS_DAY_START_HOUR / 2);
    const bucketOf = (hour: number) => (Math.floor(hour / 2) - firstBucket + 12) % 12;
    const labels = Array.from({ length: 12 }, (_, i) => {
      const hour = ((i + firstBucket) % 12) * 2;
      const period = hour < 12 ? 'AM' : 'PM';
      const display = hour % 12 === 0 ? 12 : hour % 12;
      return `${display} ${period}`;
    });
    const totals = new Array(12).fill(0);
    for (const order of periodOrders) {
      const { hour } = outletLocalParts(new Date(order.createdAt));
      totals[bucketOf(hour)] += order.subtotalPaise;
    }

    // Show the span the outlet actually trades in; default to 10 AM – 10 PM when there are no sales
    const nonZero = totals.map((t, i) => (t > 0 ? i : -1)).filter((i) => i >= 0);
    const first = nonZero.length > 0 ? Math.min(...nonZero) : bucketOf(10);
    const last = nonZero.length > 0 ? Math.max(...nonZero) : bucketOf(22);

    return labels.slice(first, last + 1).map((time, i) => ({
      time,
      revenue: Math.round(totals[first + i] / 100),
    }));
  }

  async getChannelDistribution(outletId?: string, businessId?: string, range?: string, startDateStr?: string, endDateStr?: string) {
    const scope = this.scopeFilter(outletId, businessId);
    const { startDate, endDate } = this.getDateRangeBounds(range, startDateStr, endDateStr);

    const channelCounts = await prisma.order.groupBy({
      by: ['source'],
      where: { ...scope, status: SETTLED, createdAt: { gte: startDate, lte: endDate }, deletedAt: null },
      _count: { id: true },
    });

    const totalOrders = channelCounts.reduce((sum, c) => sum + c._count.id, 0);
    if (totalOrders === 0) return [];

    const sourceLabelMap: Record<string, { name: string; color: string }> = {
      TABLE: { name: "Dine-in", color: "#2563eb" },
      QR: { name: "Dine-in", color: "#2563eb" },
      DELIVERY: { name: "Delivery", color: "#7c3aed" }, // distinct from Dine-in blue
      // Entered at the counter/POS without a table. Alayn does not record whether the customer ate in or took it away
      COUNTER: { name: "Counter", color: "#d97706" },
    };

    const mergedShares: Record<string, { value: number; color: string }> = {};

    for (const c of channelCounts) {
      const info = sourceLabelMap[c.source] || { name: c.source, color: "#64748b" };
      const pct = Math.round((c._count.id / totalOrders) * 100);
      if (!mergedShares[info.name]) {
        mergedShares[info.name] = { value: pct, color: info.color };
      } else {
        mergedShares[info.name].value += pct;
      }
    }

    return Object.entries(mergedShares).map(([name, data]) => ({
      name,
      value: data.value,
      color: data.color,
    }));
  }

  async getTopSellingItems(outletId?: string, businessId?: string, range?: string, startDateStr?: string, endDateStr?: string) {
    const scope = this.scopeFilter(outletId, businessId);
    const { startDate, endDate } = this.getDateRangeBounds(range, startDateStr, endDateStr);

    const groups = await prisma.orderItem.groupBy({
      by: ['menuItemId'],
      where: {
        order: { ...scope, status: SETTLED, createdAt: { gte: startDate, lte: endDate }, deletedAt: null },
      },
      _sum: { quantity: true, subtotalPaise: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5,
    });

    if (groups.length === 0) return [];

    const itemIds = groups.map((g) => g.menuItemId);
    const menuItems = await prisma.menuItem.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, name: true, category: { select: { name: true } } },
    });

    const itemMap = new Map(menuItems.map((i) => [i.id, i]));

    return groups.map((g) => {
      const itemInfo = itemMap.get(g.menuItemId);
      return {
        name: itemInfo?.name || 'Item',
        volume: g._sum.quantity || 0,
        revenue: Math.round((g._sum.subtotalPaise || 0) / 100),
        category: itemInfo?.category?.name || 'General',
      };
    });
  }

  /** Active dishes with no settled sales in the last 14 days, with when they last sold. */
  async getSlowMovers(outletId?: string, businessId?: string, now: Date = new Date()) {
    const since = new Date(businessStartOfDay(now).getTime() - SLOW_MOVER_DAYS * ONE_DAY_MS);
    const orderScope = this.scopeFilter(outletId, businessId);
    const items = await prisma.menuItem.findMany({
      where: {
        ...menuItemScope(outletId, businessId),
        isActive: true,
        deletedAt: null,
        createdAt: { lt: since },
        orderItems: { none: { order: { ...orderScope, status: SETTLED, deletedAt: null, createdAt: { gte: since } } } },
      },
      select: { id: true, name: true, pricePaise: true, category: { select: { name: true } } },
      take: 200,
    });
    if (items.length === 0) return { days: SLOW_MOVER_DAYS, items: [] };

    const lastSales = await prisma.orderItem.findMany({
      where: { menuItemId: { in: items.map((i) => i.id) }, order: { ...orderScope, status: SETTLED, deletedAt: null } },
      select: { menuItemId: true, order: { select: { createdAt: true } } },
      orderBy: { order: { createdAt: 'desc' } },
      distinct: ['menuItemId'],
    });
    const lastSold = new Map(lastSales.map((l) => [l.menuItemId, l.order.createdAt]));
    const daysAgo = (d: Date) => Math.round((businessStartOfDay(now).getTime() - businessStartOfDay(d).getTime()) / ONE_DAY_MS);

    return {
      days: SLOW_MOVER_DAYS,
      items: items
        .map((i) => {
          const last = lastSold.get(i.id);
          return { id: i.id, name: i.name, category: i.category?.name ?? 'General', price: Math.round(i.pricePaise / 100), lastSoldDaysAgo: last ? daysAgo(last) : null };
        })
        // Longest-unsold first; never sold at all goes to the top
        .sort((a, b) => (b.lastSoldDaysAgo ?? Infinity) - (a.lastSoldDaysAgo ?? Infinity) || a.name.localeCompare(b.name)),
    };
  }

  /**
   * Daily revenue forecast (before tax) with a likely range and the model's measured accuracy.
   * See ./forecast.ts for the model. Outlets are forecast separately (each has its own holidays
   * and weekly pattern) and added together for the "all outlets" view.
   */
  async getSalesForecast(
    outletId?: string,
    businessId?: string,
    now: Date = new Date(),
    options: { range?: string; horizon?: number } = {},
  ) {
    const displayDays = FORECAST_RANGES[options.range ?? ''] ?? 7;
    const horizon = Math.min(14, Math.max(1, Math.floor(options.horizon ?? 7)));
    const isAll = !outletId || outletId === 'all';

    const outlets = isAll
      ? businessId
        ? await prisma.outlet.findMany({ where: { businessId, deletedAt: null }, select: { id: true, operatingDays: true } })
        : []
      : await prisma.outlet.findMany({ where: { id: outletId, deletedAt: null, ...(businessId ? { businessId } : {}) }, select: { id: true, operatingDays: true } });

    // Complete days the model needs: what's displayed (or the 28-day backtest) plus its lookback
    // Days are business days (5 AM to 5 AM), so late-night sales count towards the evening they belong to
    const todayStart = businessStartOfDay(now);
    const historyDays = Math.max(displayDays, 28) + LOOKBACK_DAYS;
    const calendar = Array.from({ length: historyDays + 1 + horizon }, (_, k) => {
      const parts = businessParts(new Date(todayStart.getTime() + (k - historyDays) * ONE_DAY_MS));
      return { date: isoDate(parts), weekday: parts.weekday };
    });

    const outletIds = outlets.map((o) => o.id);
    const [orders, holidays] = outletIds.length
      ? await Promise.all([
          prisma.order.findMany({
            where: {
              outletId: { in: outletIds },
              status: SETTLED,
              deletedAt: null,
              createdAt: { gte: new Date(todayStart.getTime() - historyDays * ONE_DAY_MS), lte: new Date(todayStart.getTime() + ONE_DAY_MS - 1) },
            },
            select: { outletId: true, createdAt: true, subtotalPaise: true },
          }),
          prisma.outletHoliday.findMany({
            where: {
              outletId: { in: outletIds },
              date: { gte: new Date(calendar[0].date), lte: new Date(calendar[calendar.length - 1].date) },
            },
            select: { outletId: true, date: true },
          }),
        ])
      : [[], []];

    const revenue = new Map<string, number>(); // `${outletId}|${date}` → paise
    for (const o of orders) {
      const key = `${o.outletId}|${isoDate(businessParts(o.createdAt))}`;
      revenue.set(key, (revenue.get(key) ?? 0) + o.subtotalPaise);
    }
    // OutletHoliday.date is a calendar date (stored as UTC midnight)
    const holidaySet = new Set(holidays.map((h) => `${h.outletId}|${h.date.toISOString().slice(0, 10)}`));

    const perOutlet = outlets.map((outlet) => {
      const openWeekdays = parseOperatingDays(outlet.operatingDays);
      const days: DayInput[] = calendar.map(({ date, weekday }) => ({
        date,
        weekday,
        actual: revenue.get(`${outlet.id}|${date}`) ?? 0,
        closed: holidaySet.has(`${outlet.id}|${date}`) || (openWeekdays !== null && !openWeekdays.has(weekday)),
      }));
      return forecastOutlet({
        history: days.slice(0, historyDays),
        today: days[historyDays],
        future: days.slice(historyDays + 1).map(({ actual, ...rest }) => rest),
        displayDays,
      });
    });

    const combined = combineForecasts(perOutlet);
    const todayDate = calendar[historyDays].date;
    const rupees = (paise: number | null) => (paise === null ? null : Math.round(paise / 100));
    const points = combined.points.length
      ? combined.points
      : calendar.slice(historyDays - displayDays).map((d) => ({
          ...d, actual: d.date > todayDate ? null : 0, projected: null, low: null, high: null, closed: false,
        }));

    return {
      status: combined.status,
      salesDays: combined.salesDays,
      earlyEstimateAfterDays: EARLY_ESTIMATE_SALES_DAYS,
      fullForecastAfterDays: FULL_FORECAST_SALES_DAYS,
      points: points.map((p) => ({
        date: p.date,
        label: forecastLabel(p.date, p.date === todayDate),
        isToday: p.date === todayDate,
        isFuture: p.date > todayDate,
        actual: rupees(p.actual),
        projected: rupees(p.projected),
        low: rupees(p.low),
        high: rupees(p.high),
        closed: p.closed,
      })),
      accuracy: combined.accuracy && {
        mapePct: Math.round(combined.accuracy.mape * 1000) / 10,
        daysEvaluated: combined.accuracy.daysEvaluated,
      },
      summary: combined.summary && {
        next7DaysProjected: rupees(combined.summary.next7DaysProjected)!,
        last7DaysActual: rupees(combined.summary.last7DaysActual)!,
        vsLast7DaysPct:
          combined.summary.vsLast7DaysPct === null ? null : Math.round(combined.summary.vsLast7DaysPct * 10) / 10,
      },
      coverage: combined.coverage,
    };
  }

  /** Who is working today, with ready-to-show labels for the Overview's Shift Coverage card. */
  async getStaffToday(outletId?: string, businessId?: string, now: Date = new Date()) {
    const { rosterSource, entries } = await getStaffToday(outletId, businessId, now);
    const statusLabel = (e: (typeof entries)[number]): string => {
      switch (e.status) {
        case 'in': return `In since ${instant12(e.clockIn!)}${e.late ? ' (late)' : ''}`;
        case 'left': return `Left at ${instant12(e.clockOut!)}`;
        case 'not_in': return 'Not clocked in';
        case 'upcoming': return `Starts ${clock12(e.shift!.startTime)}`;
        case 'leave': return 'On leave';
        case 'off': return 'Off today';
      }
    };
    const staff = [...entries]
      .sort((a, b) => STAFF_ORDER.indexOf(a.status) - STAFF_ORDER.indexOf(b.status) || a.name.localeCompare(b.name))
      .map((e) => ({
        id: e.employeeId,
        name: e.name,
        role: e.role,
        outletName: e.outletName,
        shiftLabel: e.shift ? `${e.shift.name} · ${clock12(e.shift.startTime)}–${clock12(e.shift.endTime)}` : null,
        status: e.status,
        statusLabel: statusLabel(e),
        late: e.late,
      }));
    const count = (s: StaffStatus) => entries.filter((e) => e.status === s).length;
    return {
      rosterSource,
      summary: {
        working: entries.filter((e) => e.shift || e.clockIn).length,
        in: count('in'),
        notIn: count('not_in'),
        onLeave: count('leave'),
      },
      staff,
    };
  }

  /** Today's sales so far against a typical same weekday, scaled to today's forecast. Amounts in rupees. */
  async getTodayPace(outletId?: string, businessId?: string, now: Date = new Date()) {
    const [orders, forecast] = await Promise.all([
      loadPaceOrders(outletId, businessId, now),
      this.getSalesForecast(outletId, businessId, now),
    ]);
    const today = forecast.points.find((p) => p.isToday);
    const forecasting = forecast.status === 'ok' || forecast.status === 'early';
    const forecastToday = forecasting && today && !today.closed && today.projected !== null ? today.projected * 100 : null;

    const pace = computeTodayPace(orders, now, forecastToday);
    const rupees = (paise: number | null) => (paise === null ? null : Math.round(paise / 100));
    return {
      status: pace.status,
      weekday: pace.weekday,
      typicalDays: pace.typicalDays,
      soFar: rupees(pace.soFarPaise)!,
      forecastToday: rupees(pace.forecastTodayPaise),
      expectedByNow: rupees(pace.expectedByNowPaise),
      pacePct: pace.pacePct,
      asOf: instant12(now),
      slots: pace.slots.map((s) => ({
        label: s.label,
        actual: s.isFuture ? null : rupees(s.actualPaise)!,
        typical: rupees(s.typicalPaise)!,
        isNow: s.isNow,
      })),
    };
  }

  /** The next 7 days: forecast next to how many people are rostered, flagging days that don't match. */
  async getStaffingWeek(outletId?: string, businessId?: string, now: Date = new Date()) {
    const forecast = await this.getSalesForecast(outletId, businessId, now, { horizon: 7 });
    const forecasting = forecast.status === 'ok' || forecast.status === 'early';
    const todayStart = businessStartOfDay(now).getTime();
    const dates = Array.from({ length: 7 }, (_, k) => {
      const parts = businessParts(new Date(todayStart + (k + 1) * ONE_DAY_MS));
      return { date: isoDate(parts), weekday: parts.weekday };
    });

    const staff = await rosteredStaffByDate(outletId, businessId, dates);
    const byDate = new Map(forecast.points.map((p) => [p.date, p]));
    const days = flagStaffing(
      dates.map(({ date, weekday }) => {
        const point = byDate.get(date);
        return {
          date,
          weekday,
          forecast: forecasting ? point?.projected ?? null : null,
          closed: point?.closed ?? false,
          staff: staff.get(date) ?? 0,
        };
      }),
    );
    return {
      forecastStatus: forecast.status,
      days: days.map((d) => ({ ...d, label: STAFF_WEEKDAYS[d.weekday], dayOfMonth: Number(d.date.slice(8)) })),
    };
  }

  async getInventoryForecast(outletId?: string, businessId?: string) {
    const scope = this.scopeFilter(outletId, businessId);

    const items = await prisma.item.findMany({
      where: {
        ...scope,
        deletedAt: null,
      },
      include: {
        batches: {
          where: {
            expiryDate: { gte: new Date() }
          }
        }
      },
      take: 10,
    });

    return items.map(item => {
      const currentStock = item.batches.reduce((sum, batch) => sum + Number(batch.quantity), 0);
      const threshold = Number(item.reorderThreshold);

      // Calculate projected days remaining based on threshold ratios
      let daysRemaining = 0;
      if (currentStock > 0) {
        daysRemaining = threshold > 0 ? (currentStock / threshold) * 5 : 10;
      }

      return {
        item: `${item.name} (${item.unit})`,
        currentStock,
        threshold,
        daysRemaining: parseFloat(daysRemaining.toFixed(1)),
      };
    });
  }
}
