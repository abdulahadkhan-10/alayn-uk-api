import { summariseSales, SettledOrder, reportToContextLines, reportsSection } from '../src/modules/ai/aiContext';
import { businessOutletIds } from '../src/modules/reports/access';
import { buildReport } from '../src/modules/reports/report.service';

jest.mock('../src/modules/reports/report.service', () => ({ buildReport: jest.fn() }));
jest.mock('../src/modules/reports/access', () => ({ businessOutletIds: jest.fn(async () => ['o1', 'o2']) }));

// An instant from an India-time wall clock
const ist = (y: number, m: number, d: number, hhmm: string) => {
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min) - 330 * 60 * 1000);
};

describe('AlaynAI sales history facts', () => {
  // Fri 16 Oct 2026, 3 PM India time
  const NOW = ist(2026, 10, 16, '15:00');
  const orders: SettledOrder[] = [];
  const add = (y: number, m: number, d: number, hhmm: string, rupees: number) =>
    orders.push({ createdAt: ist(y, m, d, hhmm), subtotalPaise: rupees * 100, outletId: 'A' });

  // Every day of September and 1–16 October: ₹600 at 9 AM, ₹400 at 1 PM, ₹1,000 at 11:50 PM
  for (const [m, days] of [[9, 30], [10, 16]] as const) {
    for (let d = 1; d <= days; d++) {
      add(2026, m, d, '09:00', 600);
      add(2026, m, d, '13:00', 400);
      if (!(m === 10 && d === 16)) add(2026, m, d, '23:50', 1000); // tonight hasn't happened yet
    }
  }
  const lines = summariseSales(orders, NOW);
  const line = (start: string) => lines.find((l) => l.startsWith(start))!;

  it('lists the last 14 complete days with weekday names, late-night orders on the right day', () => {
    const daily = line('- Daily sales, last 14 days:');
    expect(daily).toContain('Fri 2 Oct ₹2,000');
    expect(daily).toContain('Thu 15 Oct ₹2,000');
    expect(daily).not.toContain('16 Oct'); // today is not a complete day
  });

  it('compares the last 7 days with the 7 before', () => {
    expect(line('- Last 7 days')).toBe('- Last 7 days ₹14,000 vs the 7 days before ₹14,000 (+0.0%)');
  });

  it('compares complete days this month with the same days last month', () => {
    expect(line('- This month')).toBe('- This month, 1–15 Oct (complete days): ₹30,000 vs 1–15 Sep: ₹30,000 (+0.0%)');
    expect(line('- Last month')).toBe('- Last month (Sep 2026) total: ₹60,000');
  });

  it('gives typical sales per hour and the busiest hours', () => {
    expect(line('- Typical sales by hour')).toContain('9 AM ₹600, 1 PM ₹400, 11 PM ₹1,000');
    expect(line('- Busiest hours')).toBe('- Busiest hours: 11 PM, 9 AM, 1 PM');
  });

  it('handles January (last month is December of the previous year)', () => {
    const jan = summariseSales([{ createdAt: ist(2026, 12, 20, '12:00'), subtotalPaise: 50_000, outletId: 'A' }], ist(2027, 1, 5, '10:00'));
    expect(jan.find((l) => l.startsWith('- Last month'))).toBe('- Last month (Dec 2026) total: ₹500');
  });

  it('says so when there were no sales recently', () => {
    expect(summariseSales([], NOW)).toContain('- Typical sales by hour: no sales in the last 4 weeks');
  });
});


describe('AlaynAI report answers', () => {
  const NOW = ist(2026, 10, 16, '15:00');
  const totals = (sales: number) => ({
    netSalesPaise: sales, orders: 10, avgOrderPaise: 10000, discountPaise: 0, taxPaise: 0,
    serviceChargePaise: 0, cancelledOrders: 0, cancelledPaise: 0, wastePaise: 0, itemsSold: 20,
  });
  const fixture = (): any => ({
    period: { start: '', end: '', label: 'Aug 2026' },
    comparison: { start: '', end: '', label: 'Sep 2026', compareLabel: 'vs Sep 2026' },
    totals: { current: totals(12000000), previous: totals(10000000), changePct: { netSalesPaise: 20 } },
    trend: { granularity: 'day', current: [], previous: [] },
    channels: [], payments: [], categories: [], outlets: [], hours: [], weekdays: [], waste: [],
    items: [], highlights: ['Sales are up'], notes: [],
  });

  it('reportToContextLines formats a comparison', () => {
    expect(reportToContextLines(fixture())).toContain('- Sales: ₹1,20,000 now vs ₹1,00,000 before (+20.0%)');
  });

  it('reportsSection returns nothing without a period', async () => {
    expect(await reportsSection('how many tables are free', 'o1', 'b1', NOW)).toEqual([]);
  });

  it('two months build one comparison with a link', async () => {
    (buildReport as jest.Mock).mockResolvedValue(fixture());
    const lines = await reportsSection('Give me an August vs September report', 'o1', 'b1', NOW);
    expect(lines[lines.length - 1]).toBe(
      '- Full report link: /reports?preset=CUSTOM&from=2026-09-01&to=2026-09-30&compare=CUSTOM&cFrom=2026-08-01&cTo=2026-08-31',
    );
  });

  it('one named period always compares with the one before', async () => {
    (buildReport as jest.Mock).mockResolvedValue(fixture());
    const lines = await reportsSection('show me last month', 'o1', 'b1', NOW);
    expect(lines[lines.length - 1]).toBe('- Full report link: /reports?preset=LAST_MONTH&compare=PREVIOUS');
  });

  const mockBuild = buildReport as jest.Mock;
  beforeEach(() => { mockBuild.mockReset(); mockBuild.mockResolvedValue(fixture()); });

  it("'all' uses the business outlets and nothing else", async () => {
    await reportsSection('last month report', 'all', 'biz1', NOW);
    expect(businessOutletIds).toHaveBeenCalledWith('biz1');
    expect(mockBuild.mock.calls[0][1]).toEqual(['o1', 'o2']);
  });

  it('a single outlet passes through unchanged', async () => {
    await reportsSection('last month report', 'outlet-x', 'biz1', NOW);
    expect(mockBuild.mock.calls[0][1]).toEqual(['outlet-x']);
  });

  it('degrades without an outlet or a business for all', async () => {
    const unavailable = ['- Unavailable right now. Do NOT guess these figures.'];
    expect(await reportsSection('last month report', undefined, 'biz1', NOW)).toEqual(unavailable);
    expect(await reportsSection('last month report', 'all', undefined, NOW)).toEqual(unavailable);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('says unavailable when the report fails', async () => {
    mockBuild.mockRejectedValue(new Error('boom'));
    expect(await reportsSection('last month report', 'o1', 'biz1', NOW)).toEqual([
      '- Unavailable right now. Do NOT guess these figures.',
    ]);
  });

  it('three periods give two reports, latest against each earlier one', async () => {
    const lines = await reportsSection('compare July, August and September', 'o1', 'biz1', NOW);
    expect(mockBuild).toHaveBeenCalledTimes(2);
    expect(lines.filter((l) => l.startsWith('- Report:'))).toHaveLength(2);
    const links = lines.filter((l) => l.startsWith('- Full report link:'));
    expect(links[0]).toContain('from=2026-09-01&to=2026-09-30&compare=CUSTOM&cFrom=2026-08-01&cTo=2026-08-31');
    expect(links[1]).toContain('from=2026-09-01&to=2026-09-30&compare=CUSTOM&cFrom=2026-07-01&cTo=2026-07-31');
  });

  it('a range named twice is not compared with itself', async () => {
    const lines = await reportsSection('September vs September', 'o1', 'biz1', NOW);
    expect(lines[lines.length - 1]).toContain('compare=PREVIOUS');
  });

  it('a custom single period compares with the previous one', async () => {
    const lines = await reportsSection('report for 1 to 10 September', 'o1', 'biz1', NOW);
    expect(lines[lines.length - 1]).toBe('- Full report link: /reports?preset=CUSTOM&from=2026-09-01&to=2026-09-10&compare=PREVIOUS');
  });
});
