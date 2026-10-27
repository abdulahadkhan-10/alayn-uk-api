import { combineForecasts, forecastOutlet, DayInput } from '../src/modules/analytics/forecast';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 5); // Monday 5 Jan 2026

function day(i: number): { date: string; weekday: number } {
  const d = new Date(START + i * DAY_MS);
  return { date: d.toISOString().slice(0, 10), weekday: d.getUTCDay() };
}

/** `count` contiguous days starting at index `from`, revenue from `fn(index, weekday)`. */
function days(count: number, fn: (i: number, weekday: number) => number, from = 0): DayInput[] {
  return Array.from({ length: count }, (_, k) => {
    const i = from + k;
    const { date, weekday } = day(i);
    return { date, weekday, actual: fn(i, weekday), closed: false };
  });
}

/** Splits a generated series into history / today / future the way the dashboard does. */
function split(all: DayInput[], historyLen: number, futureLen = 7) {
  return {
    history: all.slice(0, historyLen),
    today: all[historyLen],
    future: all.slice(historyLen + 1, historyLen + 1 + futureLen).map(({ actual, ...rest }) => rest),
  };
}

// Deterministic pseudo-random noise in [-1, 1]
function noise(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

const WEEKLY = (_: number, wd: number) => (wd === 2 ? 1000 : wd === 6 ? 2000 : 1500);

describe('Sales forecast model', () => {
  it('keeps the weekday pattern (a busy Saturday is not averaged with a quiet Tuesday)', () => {
    const all = days(8 * 7 + 1 + 7, WEEKLY);
    const result = forecastOutlet({ ...split(all, 56), displayDays: 7 });

    expect(result.status).toBe('ok');
    const future = result.points.slice(-7);
    for (const p of future) {
      const expected = WEEKLY(0, p.weekday);
      expect(Math.abs(p.projected! - expected) / expected).toBeLessThan(0.01);
    }
  });

  it('follows steady growth instead of lagging behind it', () => {
    const growth = (i: number, wd: number) => WEEKLY(i, wd) * Math.pow(1.03, i / 7); // +3% a week
    const all = days(10 * 7 + 1 + 7, growth);
    const result = forecastOutlet({ ...split(all, 70), displayDays: 7 });

    const future = result.points.slice(-7);
    future.forEach((p, k) => {
      const truth = growth(71 + k, p.weekday);
      expect(Math.abs(p.projected! - truth) / truth).toBeLessThan(0.03);
    });
  });

  it('is not thrown off by one exceptional night (e.g. a private party)', () => {
    const all = days(8 * 7 + 1 + 7, () => 1000);
    all[56 - 15].actual = 10_000; // a big night three weeks ago
    const result = forecastOutlet({ ...split(all, 56), displayDays: 7 });

    const sameWeekday = result.points.slice(-7).find((p) => p.weekday === all[56 - 15].weekday)!;
    expect(Math.abs(sameWeekday.projected! - 1000) / 1000).toBeLessThan(0.1);
  });

  it('keeps learning (no numbers) until it has seen 3 days of sales', () => {
    const all = days(10 + 1 + 7, (i) => (i >= 8 ? 1000 : 0)); // opened 2 days ago
    const result = forecastOutlet({ ...split(all, 10), displayDays: 7 });

    expect(result.status).toBe('learning');
    expect(result.salesDays).toBe(2);
    expect(result.points.every((p) => p.projected === null && p.low === null)).toBe(true);
    // Real sales are still shown
    expect(result.points.filter((p) => (p.actual ?? 0) > 0).length).toBe(3);
  });

  it('counts days that actually had sales, not days since the first sale', () => {
    // One test order 9 days ago, nothing since
    const all = days(30 + 1 + 7, (i) => (i === 21 ? 710 : 0));
    const result = forecastOutlet({ ...split(all, 30), displayDays: 7 });
    expect(result.status).toBe('learning');
    expect(result.salesDays).toBe(1);
  });

  it('gives an early estimate with a wide range from day 3', () => {
    const all = days(5 + 1 + 7, () => 1000);
    const result = forecastOutlet({ ...split(all, 5), displayDays: 7 });

    expect(result.status).toBe('early');
    const future = result.points.slice(-7);
    for (const p of future) {
      expect(p.projected).toBeCloseTo(1000, 0);
      // Honest about being rough: at least ±25% even when the first days were identical
      expect(p.low).toBeLessThanOrEqual(750);
      expect(p.high).toBeGreaterThanOrEqual(1250);
    }
    expect(combineForecasts([result]).accuracy).toBeNull();
  });

  it('early estimates lean towards a weekday once it has been seen', () => {
    // 10 days: Saturdays at ₹2,000, other days ₹1,000
    const all = days(10 + 1 + 7, (_, wd) => (wd === 6 ? 2000 : 1000));
    const result = forecastOutlet({ ...split(all, 10), displayDays: 7 });

    expect(result.status).toBe('early');
    const future = result.points.slice(-7);
    const sat = future.find((p) => p.weekday === 6)!;
    const tue = future.find((p) => p.weekday === 2)!;
    expect(sat.projected!).toBeGreaterThan(tue.projected! * 1.3);
  });

  it('switches to the full forecast after 14 days of sales', () => {
    const all = days(14 + 1 + 7, WEEKLY);
    const result = forecastOutlet({ ...split(all, 14), displayDays: 7 });
    expect(result.status).toBe('ok');
    const sat = result.points.slice(-7).find((p) => p.weekday === 6)!;
    expect(Math.abs(sat.projected! - 2000) / 2000).toBeLessThan(0.05);
  });

  it('does not compare a week of forecast with a café that has been open for 4 days', () => {
    const all = days(4 + 1 + 7, () => 1000);
    const combined = combineForecasts([forecastOutlet({ ...split(all, 4), displayDays: 7 })]);
    expect(combined.status).toBe('early');
    expect(combined.summary!.next7DaysProjected).toBeCloseTo(7000, 0);
    expect(combined.summary!.vsLast7DaysPct).toBeNull();
  });

  it('forecasts zero on closed days and ignores past holidays when learning', () => {
    const all = days(8 * 7 + 1 + 7, () => 1000);
    // Past holiday with no sales: must not drag the forecast down
    all[56 - 7].actual = 0;
    all[56 - 7].closed = true;
    const parts = split(all, 56);
    parts.future[2].closed = true;

    const result = forecastOutlet({ ...parts, displayDays: 7 });
    const future = result.points.slice(-7);
    expect(future[2]).toMatchObject({ projected: 0, low: 0, high: 0, closed: true });
    const holidayWeekday = all[56 - 7].weekday;
    const next = future.find((p) => p.weekday === holidayWeekday && !p.closed)!;
    expect(next.projected).toBeCloseTo(1000, 0);
  });

  it('measures its own accuracy honestly on noisy data', () => {
    const noisy = (i: number, wd: number) => WEEKLY(i, wd) * (1 + 0.1 * noise(i + 1));
    const all = days(12 * 7 + 1 + 7, noisy);
    const combined = combineForecasts([forecastOutlet({ ...split(all, 84), displayDays: 7 })]);

    expect(combined.status).toBe('ok');
    expect(combined.accuracy!.daysEvaluated).toBe(28);
    // ±10% uniform noise → typical error a few percent, never pretending to be perfect
    expect(combined.accuracy!.mape).toBeGreaterThan(0.02);
    expect(combined.accuracy!.mape).toBeLessThan(0.12);

    // The range is wide enough to contain most real days
    const past = combined.points.filter((p) => p.actual !== null && p.projected !== null).slice(0, -1);
    const inside = past.filter((p) => p.actual! >= p.low! && p.actual! <= p.high!).length;
    expect(inside / past.length).toBeGreaterThanOrEqual(0.5);
  });

  it('adds outlets together and summarises the next 7 days', () => {
    const a = days(8 * 7 + 1 + 7, () => 1000);
    const b = days(8 * 7 + 1 + 7, () => 3000);
    const combined = combineForecasts([
      forecastOutlet({ ...split(a, 56), displayDays: 7 }),
      forecastOutlet({ ...split(b, 56), displayDays: 7 }),
    ]);

    expect(combined.coverage).toEqual({ forecasted: 2, total: 2 });
    const future = combined.points.slice(-7);
    future.forEach((p) => expect(p.projected).toBeCloseTo(4000, 0));
    expect(combined.summary!.next7DaysProjected).toBeCloseTo(28_000, 0);
    expect(combined.summary!.vsLast7DaysPct).toBeCloseTo(0, 1);
  });

  it('includes a young outlet\'s early estimate in the all-outlets total', () => {
    const old = days(8 * 7 + 1 + 7, () => 1000);
    const young = days(8 * 7 + 1 + 7, (i) => (i < 46 ? 0 : 500)); // 10 days of sales
    const combined = combineForecasts([
      forecastOutlet({ ...split(old, 56), displayDays: 7 }),
      forecastOutlet({ ...split(young, 56), displayDays: 7 }),
    ]);

    expect(combined.status).toBe('ok');
    expect(combined.coverage).toEqual({ forecasted: 2, total: 2 });
    combined.points.slice(-7).forEach((p) => expect(p.projected).toBeCloseTo(1500, 0));
    // Accuracy is only claimed for the full forecast
    expect(combined.accuracy!.mape).toBeCloseTo(0, 5);
  });

  it('marks partial coverage when one outlet is still learning', () => {
    const old = days(8 * 7 + 1 + 7, () => 1000);
    const fresh = days(8 * 7 + 1 + 7, (i) => (i < 54 ? 0 : 500)); // 2 days of sales
    const combined = combineForecasts([
      forecastOutlet({ ...split(old, 56), displayDays: 7 }),
      forecastOutlet({ ...split(fresh, 56), displayDays: 7 }),
    ]);

    expect(combined.status).toBe('ok');
    expect(combined.coverage).toEqual({ forecasted: 1, total: 2 });
    // Accuracy only compares outlets that were actually forecast
    expect(combined.accuracy!.mape).toBeCloseTo(0, 5);
    // Like-for-like: the new outlet's sales don't make the forecast look like a drop
    expect(combined.points.find((p) => p.date === day(55).date)!.actual).toBe(1000);
    expect(combined.summary!.vsLast7DaysPct).toBeCloseTo(0, 1);
  });
});
