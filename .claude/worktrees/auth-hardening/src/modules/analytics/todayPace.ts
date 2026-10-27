/*
 * "Today's pace": sales so far today against what a typical day of the same weekday had sold by this
 * time, scaled to today's forecast. "₹12,400 by 2 PM, 8% ahead of a normal Friday."
 * Amounts are settled sales before tax, in paise (the API converts to rupees).
 */
import { prisma } from '../../config/prisma';
import { outletScope } from '../../utils/tenantScope';
import { ONE_DAY_MS, outletLocalParts, outletStartOfDay } from '../../utils/outletTime';

const SLOT_HOURS = 2;
const SLOTS = 24 / SLOT_HOURS;
const WEEKS_BACK = 8;
/** Fewer same-weekday days with sales than this and there is no reliable "typical day" yet */
export const MIN_TYPICAL_DAYS = 2;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface PaceOrder {
  createdAt: Date;
  subtotalPaise: number;
}

export interface TodayPace {
  status: 'ok' | 'no_pattern';
  weekday: string; // "Friday"
  typicalDays: number; // same-weekday days the "typical" is averaged over
  soFarPaise: number;
  forecastTodayPaise: number | null;
  /** What today's forecast implies by now, given how a typical day's sales build up */
  expectedByNowPaise: number | null;
  /** % ahead (+) or behind (−) of expected-by-now */
  pacePct: number | null;
  slots: { label: string; actualPaise: number; typicalPaise: number; isNow: boolean; isFuture: boolean }[];
}

const slotLabel = (slot: number) => {
  const h = slot * SLOT_HOURS;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
};
const dayKey = (instant: Date) => {
  const { year, month, day } = outletLocalParts(instant);
  return `${year}-${month}-${day}`;
};

/**
 * Pure: `orders` are settled orders from the last 8 weeks up to now; `forecastTodayPaise` is today's
 * forecast (null when there isn't one yet).
 */
export function computeTodayPace(orders: PaceOrder[], now: Date, forecastTodayPaise: number | null): TodayPace {
  const todayStart = outletStartOfDay(now).getTime();
  const { weekday, hour, minute } = outletLocalParts(now);
  const nowSlot = Math.floor(hour / SLOT_HOURS);

  const actual = new Array(SLOTS).fill(0);
  const pastTotals = new Array(SLOTS).fill(0);
  const pastDays = new Set<string>();
  const earliest = todayStart - WEEKS_BACK * 7 * ONE_DAY_MS;

  for (const o of orders) {
    const t = o.createdAt.getTime();
    const parts = outletLocalParts(o.createdAt);
    const slot = Math.floor(parts.hour / SLOT_HOURS);
    if (t >= todayStart) {
      actual[slot] += o.subtotalPaise;
    } else if (t >= earliest && parts.weekday === weekday) {
      pastTotals[slot] += o.subtotalPaise;
      pastDays.add(dayKey(o.createdAt));
    }
  }

  const typicalDays = pastDays.size;
  const typical = pastTotals.map((total) => (typicalDays ? total / typicalDays : 0));
  const typicalDayTotal = typical.reduce((s, v) => s + v, 0);
  const soFarPaise = actual.reduce((s, v) => s + v, 0);

  // Share of a typical day's sales made by now: full slots before this one, plus the part of this slot gone
  const intoSlot = ((hour % SLOT_HOURS) * 60 + minute) / (SLOT_HOURS * 60);
  const typicalByNow = typical.slice(0, nowSlot).reduce((s, v) => s + v, 0) + typical[nowSlot] * intoSlot;
  const share = typicalDayTotal > 0 ? typicalByNow / typicalDayTotal : 0;

  const hasPattern = typicalDays >= MIN_TYPICAL_DAYS && typicalDayTotal > 0;
  const expectedByNowPaise = hasPattern && forecastTodayPaise !== null && share > 0 ? Math.round(forecastTodayPaise * share) : null;
  const pacePct =
    expectedByNowPaise && expectedByNowPaise > 0 ? Math.round(((soFarPaise - expectedByNowPaise) / expectedByNowPaise) * 1000) / 10 : null;

  // Show the hours the café actually trades (any typical or actual sales), not the whole night
  const active = typical.map((v, i) => v > 0 || actual[i] > 0);
  const first = active.indexOf(true);
  const last = active.lastIndexOf(true);
  const range = first === -1 ? [] : Array.from({ length: last - first + 1 }, (_, k) => first + k);

  return {
    status: hasPattern ? 'ok' : 'no_pattern',
    weekday: WEEKDAYS[weekday],
    typicalDays,
    soFarPaise,
    forecastTodayPaise,
    expectedByNowPaise,
    pacePct,
    slots: range.map((i) => ({
      label: slotLabel(i),
      actualPaise: actual[i],
      typicalPaise: Math.round(typical[i]),
      isNow: i === nowSlot,
      isFuture: i > nowSlot,
    })),
  };
}

/** Settled orders from 8 weeks before today up to now, for the outlet (or the caller's business). */
export async function loadPaceOrders(outletId: string | undefined, businessId: string | undefined, now: Date): Promise<PaceOrder[]> {
  return prisma.order.findMany({
    where: {
      ...outletScope(outletId, businessId),
      status: 'COMPLETED',
      deletedAt: null,
      createdAt: { gte: new Date(outletStartOfDay(now).getTime() - WEEKS_BACK * 7 * ONE_DAY_MS), lte: now },
    },
    select: { createdAt: true, subtotalPaise: true },
  });
}
