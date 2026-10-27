import { detectPeriods } from '../src/modules/ai/periodParse';

// Tue 20 Oct 2026 11:00 India time.
const NOW = new Date(Date.UTC(2026, 9, 20, 11, 0) - 330 * 60 * 1000);
const labels = (q: string) => detectPeriods(q, NOW).map((p) => p.label);

describe('detectPeriods', () => {
  it.each<[string, string[]]>([
    ['compare august vs september', ['Aug 2026', 'Sep 2026']],
    ['how was december', ['Dec 2025']],
    ['sales in Q2 2025', ['Apr–Jun 2025']],
    ['1-15 aug vs 16-31 aug', ['1–15 Aug 2026', '16–31 Aug 2026']],
    ['last 30 days', ['21 Sep – 20 Oct 2026']],
    ['this month vs last month', ['1–20 Oct 2026', 'Sep 2026']],
    ['2025 vs 2024', ['2025', '2024']],
    ['who is working today', ['Today']],
    ['how is business', []],
    ['may I see the report', []],
    ['last 900 days', []],
  ])('%s', (question, expected) => {
    expect(labels(question)).toEqual(expected);
  });

  it('uses presets for phrases that map one to one', () => {
    const presets = (q: string) => detectPeriods(q, NOW).map((p) => p.preset);
    expect(presets('today and yesterday')).toEqual(['TODAY', 'YESTERDAY']);
    expect(presets('this week vs last week')).toEqual(['THIS_WEEK', 'LAST_WEEK']);
    expect(presets('this quarter vs last quarter')).toEqual(['THIS_QUARTER', 'LAST_QUARTER']);
    expect(presets('this year vs last year')).toEqual(['THIS_YEAR', 'LAST_YEAR']);
    const [p] = detectPeriods('this month', NOW);
    expect(p.custom).toBeUndefined();
  });

  it('uses CUSTOM with exact day strings for everything else', () => {
    const one = (q: string) => detectPeriods(q, NOW)[0];
    expect(one('last 30 days')).toMatchObject({ preset: 'CUSTOM', custom: { from: '2026-09-21', to: '2026-10-20' } });
    expect(one('august')).toMatchObject({ preset: 'CUSTOM', custom: { from: '2026-08-01', to: '2026-08-31' } });
    expect(one('Q2 2025')).toMatchObject({ custom: { from: '2025-04-01', to: '2025-06-30' } });
    expect(one('2025')).toMatchObject({ custom: { from: '2025-01-01', to: '2025-12-31' } });
    expect(one('1 to 15 aug')).toMatchObject({ custom: { from: '2026-08-01', to: '2026-08-15' } });
    expect(one('2026-08-01 to 2026-08-15')).toMatchObject({ custom: { from: '2026-08-01', to: '2026-08-15' } });
  });

  it('handles current periods, missing years and single dates', () => {
    expect(labels('october')).toEqual(['1–20 Oct 2026']);
    expect(labels('november')).toEqual(['Nov 2025']);
    expect(labels('2026')).toEqual(['1 Jan – 20 Oct 2026']);
    expect(labels('Q4')).toEqual(['1–20 Oct 2026']);
    expect(labels('Q3')).toEqual(['Jul–Sep 2026']);
    expect(labels('Q2 vs Q1')).toEqual(['Apr–Jun 2026', 'Jan–Mar 2026']);
    expect(labels('5 Aug')).toEqual(['Wed 5 Aug']);
    expect(labels('sales on Aug 5')).toEqual(['Wed 5 Aug']);
    expect(labels('aug 1-15')).toEqual(['1–15 Aug 2026']);
    expect(labels('August 2025')).toEqual(['Aug 2025']);
    expect(labels('sept')).toEqual(['Sep 2026']);
    expect(labels('past 7 days')).toEqual(['14–20 Oct 2026']);
  });

  it('treats may and march as months only in month-like contexts', () => {
    expect(labels('sales in may')).toEqual(['May 2026']);
    expect(labels('may vs june')).toEqual(['May 2026', 'Jun 2026']);
    expect(labels('may 2025')).toEqual(['May 2025']);
    expect(labels('we may need the march on')).toEqual([]);
  });

  it('dedupes, keeps mention order and returns at most 3', () => {
    expect(labels('august vs august')).toEqual(['Aug 2026']);
    expect(labels('jan feb mar apr may')).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026']);
    expect(labels('last month vs this month')).toEqual(['Sep 2026', '1–20 Oct 2026']);
  });

  it('drops invalid, future and too-old periods', () => {
    expect(labels('31 feb')).toEqual([]);
    expect(labels('2030')).toEqual([]);
    expect(labels('2022')).toEqual([]);
    expect(labels('last 400 days')).toHaveLength(1);
    expect(labels('last 401 days')).toEqual([]);
    expect(labels('last 0 days')).toEqual([]);
  });

  it('reads ranges across months as one period', () => {
    const one = (q: string) => detectPeriods(q, NOW);
    expect(one('from 1 aug to 15 sep')).toHaveLength(1);
    expect(one('from 1 aug to 15 sep')[0]).toMatchObject({
      preset: 'CUSTOM', label: '1 Aug – 15 Sep 2026', custom: { from: '2026-08-01', to: '2026-09-15' },
    });
    expect(one('1 aug - 15 sep 2025')).toHaveLength(1);
    expect(one('1 aug - 15 sep 2025')[0].custom).toEqual({ from: '2025-08-01', to: '2025-09-15' });
    expect(one('aug 1 to sep 15')[0].custom).toEqual({ from: '2026-08-01', to: '2026-09-15' });
    expect(one('aug 1 to sep 15')).toHaveLength(1);
    expect(one('20 dec to 5 jan')[0].custom).toEqual({ from: '2025-12-20', to: '2026-01-05' });
  });

  it('does not read stray numbers as years', () => {
    expect(labels('₹2025 sales')).toEqual([]);
    expect(labels('rs 2025 sales')).toEqual([]);
    expect(labels('5/8/2025')).toEqual([]);
    expect(labels('table 12')).toEqual([]);
    expect(labels('top 5 items')).toEqual([]);
    expect(labels('order 12025')).toEqual([]);
    expect(labels('sales above 2025 rupees')).toEqual(['2025']);
  });

  it('reads year-month dates', () => {
    expect(detectPeriods('2026-08', NOW)[0]).toMatchObject({ label: 'Aug 2026', custom: { from: '2026-08-01', to: '2026-08-31' } });
    expect(labels('2026-10')).toEqual(['1–20 Oct 2026']);
    expect(detectPeriods('2026-10', NOW)[0].custom).toEqual({ from: '2026-10-01', to: '2026-10-20' });
  });

  it('reads "same period last year" after a period', () => {
    expect(labels('last month vs same month last year')).toEqual(['Sep 2026', 'Sep 2025']);
    expect(labels('this month vs same time last year')).toEqual(['1–20 Oct 2026', '1–20 Oct 2025']);
    expect(labels('this week vs same week last year')).toHaveLength(2);
    expect(labels('same period last year')).toEqual([]);
    expect(detectPeriods('last month vs same month last year', NOW)[1].custom).toEqual({ from: '2025-09-01', to: '2025-09-30' });
  });
});
