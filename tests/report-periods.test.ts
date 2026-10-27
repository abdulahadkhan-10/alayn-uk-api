import {
  resolvePeriod,
  comparisonPeriod,
  compareLabel,
  describeRange,
  periodDays,
  pctChange,
  MAX_PERIOD_DAYS,
} from '../src/modules/reports/periods';
import { businessDayStart, businessParts } from '../src/utils/outletTime';

// An instant from an India-time wall clock. Month is zero-based like Date.
const ist = (y: number, m: number, d: number, hhmm: string) => {
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m, d, h, min) - 330 * 60 * 1000);
};
// Days are business days: 5 AM to 4:59:59 AM the next morning, India time
const startOf = (y: number, m: number, d: number) => businessDayStart(y, m, d);
const endOf = (y: number, m: number, d: number) => new Date(startOf(y, m, d + 1).getTime() - 1);

const NOW = ist(2026, 9, 20, '11:00'); // Tue 20 Oct 2026

describe('report periods', () => {
  it('today vs yesterday same time', () => {
    const cur = resolvePeriod('TODAY', NOW);
    expect(cur.start).toEqual(startOf(2026, 9, 20));
    expect(cur.end).toEqual(NOW);
    expect(cur.toDate).toBe(true);
    const cmp = comparisonPeriod(cur, 'PREVIOUS', NOW)!;
    expect(cmp.start).toEqual(startOf(2026, 9, 19));
    expect(cmp.end).toEqual(ist(2026, 9, 19, '11:00'));
    expect(compareLabel(cur, 'PREVIOUS', cmp, NOW)).toBe('vs yesterday, same time');
  });

  it('yesterday vs the day before', () => {
    const cur = resolvePeriod('YESTERDAY', NOW);
    expect(cur.toDate).toBe(false);
    expect(cur.end).toEqual(endOf(2026, 9, 19));
    const cmp = comparisonPeriod(cur, 'PREVIOUS', NOW)!;
    expect(cmp.start).toEqual(startOf(2026, 9, 18));
    expect(cmp.end).toEqual(endOf(2026, 9, 18));
    expect(compareLabel(cur, 'PREVIOUS', cmp, NOW)).toBe('vs the day before');
  });

  it('last 7 days is today plus 6', () => {
    const cur = resolvePeriod('LAST_7_DAYS', NOW);
    expect(cur.start).toEqual(startOf(2026, 9, 14));
    expect(cur.end).toEqual(NOW);
    const cmp = comparisonPeriod(cur, 'PREVIOUS', NOW)!;
    expect(cmp.start).toEqual(startOf(2026, 9, 7));
    expect(cmp.end).toEqual(ist(2026, 9, 13, '11:00'));
  });

  it('this month vs same dates last month', () => {
    const cur = resolvePeriod('THIS_MONTH', NOW);
    expect(cur.start).toEqual(startOf(2026, 9, 1));
    const cmp = comparisonPeriod(cur, 'PREVIOUS', NOW)!;
    expect(cmp.start).toEqual(startOf(2026, 8, 1));
    expect(cmp.end).toEqual(ist(2026, 8, 20, '11:00'));
    expect(compareLabel(cur, 'PREVIOUS', cmp, NOW)).toBe('vs 1–20 Sep 2026');
  });

  it('this month on 31 Mar stops at end of Feb', () => {
    const now = ist(2026, 2, 31, '10:00');
    const cur = resolvePeriod('THIS_MONTH', now);
    const cmp = comparisonPeriod(cur, 'PREVIOUS', now)!;
    expect(cmp.start).toEqual(startOf(2026, 1, 1));
    expect(cmp.end).toEqual(endOf(2026, 1, 28));
  });

  it('this week starts Monday', () => {
    const cur = resolvePeriod('THIS_WEEK', NOW);
    expect(cur.start).toEqual(startOf(2026, 9, 19));
    const cmp = comparisonPeriod(cur, 'PREVIOUS', NOW)!;
    expect(cmp.start).toEqual(startOf(2026, 9, 12));
    expect(cmp.end).toEqual(ist(2026, 9, 13, '11:00'));
  });

  it('this week on a Sunday still starts the Monday before', () => {
    const now = ist(2026, 9, 25, '09:00'); // Sun
    expect(resolvePeriod('THIS_WEEK', now).start).toEqual(startOf(2026, 9, 19));
  });

  it('last week vs the week before', () => {
    const cur = resolvePeriod('LAST_WEEK', NOW);
    expect(cur.start).toEqual(startOf(2026, 9, 12));
    expect(cur.end).toEqual(endOf(2026, 9, 18));
    const cmp = comparisonPeriod(cur, 'PREVIOUS', NOW)!;
    expect(cmp.start).toEqual(startOf(2026, 9, 5));
    expect(cmp.end).toEqual(endOf(2026, 9, 11));
  });

  it('last month vs the whole month before', () => {
    const cur = resolvePeriod('LAST_MONTH', NOW);
    expect(cur.start).toEqual(startOf(2026, 8, 1));
    expect(cur.end).toEqual(endOf(2026, 8, 30));
    const cmp = comparisonPeriod(cur, 'PREVIOUS', NOW)!;
    expect(cmp.start).toEqual(startOf(2026, 7, 1));
    expect(cmp.end).toEqual(endOf(2026, 7, 31));
  });

  it('this quarter', () => {
    const cur = resolvePeriod('THIS_QUARTER', NOW);
    expect(cur.start).toEqual(startOf(2026, 9, 1));
    const cmp = comparisonPeriod(cur, 'PREVIOUS', NOW)!;
    expect(cmp.start).toEqual(startOf(2026, 6, 1));
    expect(cmp.end).toEqual(ist(2026, 6, 20, '11:00'));
  });

  it('last quarter and last year are whole periods', () => {
    const q = resolvePeriod('LAST_QUARTER', NOW);
    expect(q.start).toEqual(startOf(2026, 6, 1));
    expect(q.end).toEqual(endOf(2026, 8, 30));
    const y = resolvePeriod('LAST_YEAR', NOW);
    expect(y.start).toEqual(startOf(2025, 0, 1));
    expect(y.end).toEqual(endOf(2025, 11, 31));
    expect(comparisonPeriod(y, 'PREVIOUS', NOW)!.start).toEqual(startOf(2024, 0, 1));
  });

  it('this year vs last year same time', () => {
    const cur = resolvePeriod('THIS_YEAR', NOW);
    const cmp = comparisonPeriod(cur, 'LAST_YEAR', NOW)!;
    expect(cmp.start).toEqual(startOf(2025, 0, 1));
    expect(cmp.end).toEqual(ist(2025, 9, 20, '11:00'));
    expect(compareLabel(cur, 'LAST_YEAR', cmp, NOW)).toBe('vs 1 Jan – 20 Oct 2025 (last year)');
  });

  it('29 Feb last year becomes 28 Feb', () => {
    const cur = resolvePeriod('CUSTOM', NOW, { from: '2028-02-29', to: '2028-02-29' });
    const cmp = comparisonPeriod(cur, 'LAST_YEAR', NOW)!;
    expect(cmp.start).toEqual(startOf(2027, 1, 28));
    expect(cmp.end).toEqual(endOf(2027, 1, 28));
  });

  it('custom compares with same length before', () => {
    const cur = resolvePeriod('CUSTOM', NOW, { from: '2026-10-05', to: '2026-10-11' });
    expect(cur.toDate).toBe(false);
    expect(cur.end).toEqual(endOf(2026, 9, 11));
    const cmp = comparisonPeriod(cur, 'PREVIOUS', NOW)!;
    expect(cmp.start).toEqual(startOf(2026, 8, 28));
    expect(cmp.end).toEqual(endOf(2026, 9, 4));
  });

  it('custom compare mode', () => {
    const cur = resolvePeriod('THIS_MONTH', NOW);
    const cmp = comparisonPeriod(cur, 'CUSTOM', NOW, { from: '2026-08-01', to: '2026-08-31' })!;
    expect(cmp.start).toEqual(startOf(2026, 7, 1));
    expect(cmp.end).toEqual(endOf(2026, 7, 31));
    expect(compareLabel(cur, 'CUSTOM', cmp, NOW)).toBe('vs Aug 2026');
  });

  it('none gives no comparison', () => {
    const cur = resolvePeriod('THIS_MONTH', NOW);
    expect(comparisonPeriod(cur, 'NONE', NOW)).toBeNull();
    expect(compareLabel(cur, 'NONE', null, NOW)).toBe('');
  });

  it('adds same time to a single-day comparison of a to-date period', () => {
    const now = ist(2026, 9, 19, '11:00'); // Mon, week just started
    const cur = resolvePeriod('THIS_WEEK', now);
    const cmp = comparisonPeriod(cur, 'PREVIOUS', now)!;
    expect(compareLabel(cur, 'PREVIOUS', cmp, now)).toBe('vs Mon 12 Oct, same time');
  });

  it('a custom past day compared with today is a whole day, not "same time"', () => {
    const cur = resolvePeriod('TODAY', NOW);
    const cmp = comparisonPeriod(cur, 'CUSTOM', NOW, { from: '2026-10-13', to: '2026-10-13' })!;
    expect(compareLabel(cur, 'CUSTOM', cmp, NOW)).toBe('vs Tue 13 Oct');
  });

  it('rejects over 400 days', () => {
    expect(() => resolvePeriod('CUSTOM', NOW, { from: '2025-01-01', to: '2026-10-01' })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(MAX_PERIOD_DAYS).toBe(400);
    expect(() => resolvePeriod('CUSTOM', NOW, { from: '2025-09-01', to: '2026-10-05' })).not.toThrow();
  });

  it('rejects a comparison over 400 days', () => {
    const cur = resolvePeriod('THIS_MONTH', NOW);
    expect(() =>
      comparisonPeriod(cur, 'CUSTOM', NOW, { from: '2025-01-01', to: '2026-10-01' }),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('rejects from after to, missing custom and bad dates', () => {
    const bad = expect.objectContaining({ statusCode: 400, code: 'BAD_REQUEST' });
    expect(() => resolvePeriod('CUSTOM', NOW, { from: '2026-10-10', to: '2026-10-01' })).toThrow(bad);
    expect(() => resolvePeriod('CUSTOM', NOW)).toThrow(bad);
    expect(() => resolvePeriod('CUSTOM', NOW, { from: 'nope', to: '2026-10-01' })).toThrow(bad);
  });

  it('periodDays counts calendar days touched', () => {
    expect(periodDays({ start: startOf(2026, 9, 1), end: NOW })).toBe(20);
    expect(periodDays({ start: startOf(2026, 9, 5), end: endOf(2026, 9, 11) })).toBe(7);
  });

  describe('business day (5 AM to 5 AM)', () => {
    it('a day starts at 5 AM, not midnight', () => {
      expect(startOf(2026, 9, 23)).toEqual(ist(2026, 9, 23, '05:00'));
      expect(endOf(2026, 9, 23)).toEqual(new Date(ist(2026, 9, 24, '05:00').getTime() - 1));
    });

    it('1:30 AM Saturday belongs to Friday', () => {
      const p = businessParts(ist(2026, 9, 24, '01:30')); // Sat 24 Oct, 1:30 AM
      expect([p.year, p.month, p.day, p.weekday]).toEqual([2026, 9, 23, 5]); // Fri 23 Oct
    });

    it('at 2 AM, today is still last night', () => {
      const now = ist(2026, 9, 24, '02:00'); // Sat 2 AM
      const today = resolvePeriod('TODAY', now);
      expect(today.start).toEqual(ist(2026, 9, 23, '05:00')); // Fri 5 AM
      expect(describeRange(today, now)).toBe('Today');
      const yesterday = resolvePeriod('YESTERDAY', now);
      expect(yesterday.start).toEqual(ist(2026, 9, 22, '05:00')); // Thu 5 AM
      expect(describeRange(yesterday, now)).toBe('Yesterday');
    });

    it('at 6 AM a new day has started', () => {
      const now = ist(2026, 9, 24, '06:00'); // Sat 6 AM
      expect(resolvePeriod('TODAY', now).start).toEqual(ist(2026, 9, 24, '05:00'));
      const yesterday = resolvePeriod('YESTERDAY', now);
      expect(yesterday.start).toEqual(ist(2026, 9, 23, '05:00'));
      expect(yesterday.end).toEqual(new Date(ist(2026, 9, 24, '05:00').getTime() - 1)); // includes Friday's late night
    });

    it('a custom date covers that night too', () => {
      const r = resolvePeriod('CUSTOM', NOW, { from: '2026-10-16', to: '2026-10-16' });
      expect(r.start).toEqual(ist(2026, 9, 16, '05:00'));
      expect(r.end).toEqual(new Date(ist(2026, 9, 17, '05:00').getTime() - 1));
      expect(describeRange(r, NOW)).toBe('Fri 16 Oct');
    });

    it('a month ends at 5 AM on the 1st of the next month', () => {
      const lastMonth = resolvePeriod('LAST_MONTH', NOW);
      expect(lastMonth.end).toEqual(new Date(ist(2026, 9, 1, '05:00').getTime() - 1));
      expect(describeRange(lastMonth, NOW)).toBe('Sep 2026');
    });
  });

  it('pctChange', () => {
    expect(pctChange(120, 100)).toBe(20);
    expect(pctChange(0, 0)).toBeNull();
    expect(pctChange(50, 0)).toBeNull();
    expect(pctChange(90, 100)).toBe(-10);
    expect(pctChange(101, 300)).toBe(-66.3);
  });

  it('describeRange', () => {
    const d = (a: Date, b: Date, now = NOW) => describeRange({ start: a, end: b }, now);
    expect(d(startOf(2026, 9, 20), NOW)).toBe('Today');
    expect(d(startOf(2026, 9, 19), endOf(2026, 9, 19))).toBe('Yesterday');
    expect(d(startOf(2026, 9, 19), endOf(2026, 9, 19), ist(2026, 9, 22, '11:00'))).toBe('Mon 19 Oct');
    expect(d(startOf(2026, 9, 1), NOW)).toBe('1–20 Oct 2026');
    expect(d(startOf(2026, 8, 28), endOf(2026, 9, 4))).toBe('28 Sep – 4 Oct 2026');
    expect(d(startOf(2026, 8, 1), endOf(2026, 8, 30))).toBe('Sep 2026');
    expect(d(startOf(2026, 6, 1), endOf(2026, 8, 30))).toBe('Jul–Sep 2026');
    expect(d(startOf(2025, 0, 1), endOf(2025, 11, 31))).toBe('2025');
    expect(d(startOf(2025, 11, 15), endOf(2026, 0, 10))).toBe('15 Dec 2025 – 10 Jan 2026');
  });
});
