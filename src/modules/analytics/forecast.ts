/*
 * Daily revenue forecast — pure functions, no database access.
 *
 * Model: weighted same-weekday baseline × recent trend.
 *  - Baseline: the same weekday over the last 8 weeks (open days with sales only), recent weeks
 *    weighted more, each sample clipped to ±30% of their median so one exceptional night
 *    (a private party, a power cut) can't move the forecast much.
 *  - Trend: median of (actual / baseline) over the last 14 open days, clamped to 0.8–1.2.
 *    Picks up steady growth or decline that the 8-week baseline lags behind.
 *  - Range & accuracy: one-step-ahead backtest over the last 28 days. The range is the
 *    80th-percentile error; accuracy is the mean absolute % error (MAPE).
 *
 * Stages, by the number of days the outlet actually had sales:
 *  - fewer than 3  → "learning": no numbers yet.
 *  - 3 to 13       → "early": the average recent day, nudged towards that weekday once it has
 *                    been seen, with a deliberately wide range. Accuracy isn't claimed yet.
 *  - 14 or more    → "ok": the full model above.
 *
 * Amounts are unit-agnostic (the dashboard passes paise).
 */

const WEEKS = 8;
const MIN_SAMPLES = 2;
const CLIP = 0.3;
const TREND_DAYS = 14;
const MIN_TREND_SAMPLES = 5;
const TREND_MIN = 0.8;
const TREND_MAX = 1.2;
const BACKTEST_DAYS = 28;
const MIN_BACKTEST_FOR_BAND = 7;
const DEFAULT_BAND = 0.2;
const MIN_BAND = 0.05;
export const EARLY_ESTIMATE_SALES_DAYS = 3;
export const FULL_FORECAST_SALES_DAYS = 14;
const EARLY_LOOKBACK_DAYS = 28;
const EARLY_CLIP = 0.5;
const EARLY_MIN_BAND = 0.25;
const EARLY_MAX_BAND = 0.6;
const EARLY_WEEKDAY_MIN = 0.5;
const EARLY_WEEKDAY_MAX = 2;
/** How many complete days before the first displayed day the model needs to see. */
export const LOOKBACK_DAYS = WEEKS * 7 + TREND_DAYS;

export interface DayInput {
  date: string; // YYYY-MM-DD, outlet-local
  weekday: number; // 0 = Sunday
  actual: number;
  closed: boolean; // holiday or non-operating weekday
}

export type FutureDayInput = Omit<DayInput, 'actual'>;

export interface ForecastPoint {
  date: string;
  weekday: number;
  actual: number | null;
  projected: number | null;
  low: number | null;
  high: number | null;
  closed: boolean;
}

export interface BacktestPoint {
  date: string;
  actual: number;
  projected: number;
}

export type ForecastStatus = 'ok' | 'early' | 'learning';

export interface OutletForecast {
  status: ForecastStatus;
  /** Days (before today) the outlet actually had sales. */
  salesDays: number;
  /** Displayed past days, then today (actual so far), then future days. */
  points: ForecastPoint[];
  /** Last 28 complete open days: what the full model would have predicted vs what happened. */
  backtest: BacktestPoint[];
}

export interface CombinedForecast {
  status: ForecastStatus;
  salesDays: number;
  points: ForecastPoint[];
  accuracy: { mape: number; daysEvaluated: number } | null;
  /** vsLast7DaysPct is null until every included outlet has a full week of sales to compare with. */
  summary: { next7DaysProjected: number; last7DaysActual: number; vsLast7DaysPct: number | null } | null;
  coverage: { forecasted: number; total: number };
}

const isOpenWithSales = (d: DayInput) => !d.closed && d.actual > 0;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;

function clipToMedian(values: number[], clip: number): number[] {
  const m = median(values);
  return values.map((v) => Math.min(m * (1 + clip), Math.max(m * (1 - clip), v)));
}

/** Weighted same-weekday average using only days[0..end). */
function baseline(days: DayInput[], end: number, weekday: number): number | null {
  const samples: number[] = [];
  for (let i = end - 1; i >= Math.max(0, end - WEEKS * 7); i--) {
    if (days[i].weekday === weekday && isOpenWithSales(days[i])) samples.push(days[i].actual);
  }
  if (samples.length < MIN_SAMPLES) return null;

  let weighted = 0;
  let totalWeight = 0;
  clipToMedian(samples, CLIP).forEach((value, rank) => {
    const weight = WEEKS - rank; // most recent week counts most
    weighted += value * weight;
    totalWeight += weight;
  });
  return weighted / totalWeight;
}

/** How far recent days ran above/below their baseline, using only days[0..end). */
function trendFactor(days: DayInput[], end: number): number {
  const ratios: number[] = [];
  for (let i = Math.max(0, end - TREND_DAYS); i < end; i++) {
    if (!isOpenWithSales(days[i])) continue;
    const b = baseline(days, i, days[i].weekday);
    if (b) ratios.push(days[i].actual / b);
  }
  if (ratios.length < MIN_TREND_SAMPLES) return 1;
  return Math.min(TREND_MAX, Math.max(TREND_MIN, median(ratios)));
}

/** Forecast for a day of `weekday` right after days[0..end). */
function predict(days: DayInput[], end: number, weekday: number, trend = trendFactor(days, end)): number | null {
  const b = baseline(days, end, weekday);
  return b === null ? null : b * trend;
}

/**
 * Early estimate for a day of `weekday` right after days[0..end): the average recent day, moved
 * towards that weekday's own average in proportion to how often it has been seen.
 */
function earlyPredict(days: DayInput[], end: number, weekday: number): { value: number; band: number } | null {
  const recent = days.slice(Math.max(0, end - EARLY_LOOKBACK_DAYS), end).filter(isOpenWithSales);
  if (recent.length < EARLY_ESTIMATE_SALES_DAYS) return null;

  const clipped = clipToMedian(recent.map((d) => d.actual), EARLY_CLIP);
  const overall = mean(clipped);
  // A real busy weekday can be double an average day; a one-off party night can't push it further
  const sameDay = recent
    .filter((d) => d.weekday === weekday)
    .map((d) => Math.min(overall * EARLY_WEEKDAY_MAX, Math.max(overall * EARLY_WEEKDAY_MIN, d.actual)));
  const w = sameDay.length / (sameDay.length + 1);
  const value = sameDay.length ? w * mean(sameDay) + (1 - w) * overall : overall;

  // How much ordinary days have swung around the average so far
  const spread = percentile(clipped.map((v) => Math.abs(v / overall - 1)), 0.8);
  return { value, band: Math.min(EARLY_MAX_BAND, Math.max(EARLY_MIN_BAND, spread)) };
}

function rangePoint(d: DayInput | FutureDayInput, actual: number | null, projected: number | null, band: number): ForecastPoint {
  if (d.closed) return { date: d.date, weekday: d.weekday, actual, projected: 0, low: 0, high: 0, closed: true };
  return {
    date: d.date,
    weekday: d.weekday,
    actual,
    projected,
    low: projected === null ? null : projected * (1 - band),
    high: projected === null ? null : projected * (1 + band),
    closed: false,
  };
}

export function forecastOutlet(params: {
  history: DayInput[]; // complete days, oldest first, ending yesterday
  today: DayInput; // actual so far
  future: FutureDayInput[]; // tomorrow onward
  displayDays: number; // complete past days to show before today
}): OutletForecast {
  const { history, today, future, displayDays } = params;
  const n = history.length;
  const salesDays = history.filter(isOpenWithSales).length;
  const status: ForecastStatus =
    salesDays >= FULL_FORECAST_SALES_DAYS ? 'ok' : salesDays >= EARLY_ESTIMATE_SALES_DAYS ? 'early' : 'learning';
  const displayFrom = Math.max(0, n - displayDays);

  if (status !== 'ok') {
    // learning: actual sales only. early: a rough estimate with a wide range, no accuracy claim.
    const estimate = (end: number, d: DayInput | FutureDayInput, actual: number | null) => {
      const e = status === 'early' ? earlyPredict(history, end, d.weekday) : null;
      const point = rangePoint(d, actual, e ? e.value : null, e ? e.band : 0);
      return status === 'learning' ? { ...point, projected: null, low: null, high: null } : point;
    };
    return {
      status,
      salesDays,
      points: [
        ...history.slice(displayFrom).map((d, k) => estimate(displayFrom + k, d, d.actual)),
        estimate(n, today, today.actual),
        ...future.map((d) => estimate(n, d, null)),
      ],
      backtest: [],
    };
  }

  // One-step-ahead backtest: errors measure how far off the model really is
  const backtest: BacktestPoint[] = [];
  for (let i = Math.max(0, n - BACKTEST_DAYS); i < n; i++) {
    if (!isOpenWithSales(history[i])) continue;
    const projected = predict(history, i, history[i].weekday);
    if (projected !== null) backtest.push({ date: history[i].date, actual: history[i].actual, projected });
  }
  const errors = backtest.map((b) => Math.abs(b.actual - b.projected) / b.actual);
  const band = Math.max(MIN_BAND, errors.length >= MIN_BACKTEST_FOR_BAND ? percentile(errors, 0.8) : DEFAULT_BAND);

  // A weekday the full model hasn't seen twice yet falls back to the early estimate
  const forecastFor = (end: number, weekday: number, trend?: number) =>
    predict(history, end, weekday, trend) ?? earlyPredict(history, end, weekday)?.value ?? null;

  const points: ForecastPoint[] = [];
  for (let i = displayFrom; i < n; i++) {
    points.push(rangePoint(history[i], history[i].actual, forecastFor(i, history[i].weekday), band));
  }
  const trendNow = trendFactor(history, n);
  points.push(rangePoint(today, today.actual, forecastFor(n, today.weekday, trendNow), band));
  for (const d of future) points.push(rangePoint(d, null, forecastFor(n, d.weekday, trendNow), band));

  return { status, salesDays, points, backtest };
}

/** Adds outlet forecasts together (a single outlet passes through unchanged) and scores them. */
export function combineForecasts(forecasts: OutletForecast[]): CombinedForecast {
  const ok = forecasts.filter((f) => f.status === 'ok');
  const estimated = forecasts.filter((f) => f.status !== 'learning');
  const status: ForecastStatus = ok.length > 0 ? 'ok' : estimated.length > 0 ? 'early' : 'learning';
  const salesDays = Math.max(0, ...forecasts.map((f) => f.salesDays));
  const coverage = { forecasted: estimated.length, total: forecasts.length };

  // Sum by date, in display order. Once any outlet has estimates, only those outlets are
  // included, so actual vs forecast (and "vs last 7 days") always compares the same outlets.
  const included = estimated.length > 0 ? estimated : forecasts;
  const byDate = new Map<string, ForecastPoint>();
  const add = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);
  for (const f of included) {
    for (const p of f.points) {
      const acc = byDate.get(p.date);
      if (!acc) {
        byDate.set(p.date, { ...p });
        continue;
      }
      acc.actual = add(acc.actual, p.actual);
      acc.projected = add(acc.projected, p.projected);
      acc.low = add(acc.low, p.low);
      acc.high = add(acc.high, p.high);
      acc.closed = acc.closed && p.closed;
    }
  }
  const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  // Accuracy is only claimed for full forecasts (an outlet closed that day simply adds nothing)
  const backtestByDate = new Map<string, { actual: number; projected: number }>();
  for (const f of ok) {
    for (const b of f.backtest) {
      const acc = backtestByDate.get(b.date) ?? { actual: 0, projected: 0 };
      acc.actual += b.actual;
      acc.projected += b.projected;
      backtestByDate.set(b.date, acc);
    }
  }
  const evaluated = [...backtestByDate.values()].filter((b) => b.actual > 0);
  const accuracy = evaluated.length
    ? {
        mape: evaluated.reduce((s, b) => s + Math.abs(b.actual - b.projected) / b.actual, 0) / evaluated.length,
        daysEvaluated: evaluated.length,
      }
    : null;

  let summary: CombinedForecast['summary'] = null;
  if (status !== 'learning') {
    const todayIdx = points.findIndex((p, i) => p.actual !== null && (i === points.length - 1 || points[i + 1].actual === null));
    const next7 = points.slice(todayIdx + 1, todayIdx + 8);
    const last7 = points.slice(Math.max(0, todayIdx - 7), todayIdx);
    const next7DaysProjected = next7.reduce((s, p) => s + (p.projected ?? 0), 0);
    const last7DaysActual = last7.reduce((s, p) => s + (p.actual ?? 0), 0);
    summary = {
      next7DaysProjected,
      last7DaysActual,
      vsLast7DaysPct:
        last7DaysActual > 0 && included.every((f) => f.salesDays >= 7)
          ? ((next7DaysProjected - last7DaysActual) / last7DaysActual) * 100
          : null,
    };
  }

  return { status, salesDays, points, accuracy, summary, coverage };
}
