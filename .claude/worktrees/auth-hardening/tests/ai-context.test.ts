import { summariseSales, SettledOrder } from '../src/modules/ai/aiContext';

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
