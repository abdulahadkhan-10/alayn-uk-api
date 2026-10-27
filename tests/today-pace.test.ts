import { computeTodayPace } from '../src/modules/analytics/todayPace';

jest.mock('../src/config/prisma', () => ({ prisma: {} }));

// An instant from an India-time wall clock in October 2026 (16 Oct is a Friday)
const ist = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60 * 1000);
};
const order = (day: number, hhmm: string, rupees: number) => ({ createdAt: ist(day, hhmm), subtotalPaise: rupees * 100 });

describe("Today's pace", () => {
  // Two past Fridays: ₹1,000 in the morning, ₹3,000 in the evening, so a quarter of the day is sold by 2 PM
  const pastFridays = [order(9, '10:00', 1000), order(9, '18:00', 3000), order(2, '10:30', 1000), order(2, '18:30', 3000)];

  it('compares sales so far with what the forecast implies by now', () => {
    const now = ist(16, '14:00');
    const result = computeTodayPace([...pastFridays, order(16, '11:00', 1100)], now, 4000 * 100);

    expect(result.status).toBe('ok');
    expect(result.weekday).toBe('Friday');
    expect(result.typicalDays).toBe(2);
    expect(result.soFarPaise).toBe(110000);
    expect(result.expectedByNowPaise).toBe(100000); // 25% of a ₹4,000 day
    expect(result.pacePct).toBe(10);
  });

  it('only counts the same weekday as "typical"', () => {
    const thursday = order(15, '10:00', 50000);
    const result = computeTodayPace([...pastFridays, thursday], ist(16, '14:00'), 4000 * 100);
    expect(result.expectedByNowPaise).toBe(100000);
  });

  it('shows India-time 2-hour slots from the 5 AM start of the day', () => {
    const result = computeTodayPace([...pastFridays, order(16, '11:00', 1100)], ist(16, '14:00'), 4000 * 100);
    expect(result.slots.map((s) => s.label)).toEqual(['9 AM', '11 AM', '1 PM', '3 PM', '5 PM']);
    expect(result.slots.find((s) => s.isNow)?.label).toBe('1 PM');
    expect(result.slots[0]).toMatchObject({ actualPaise: 0, typicalPaise: 100000, isFuture: false });
    expect(result.slots[1]).toMatchObject({ actualPaise: 110000, typicalPaise: 0, isFuture: false });
    expect(result.slots[4]).toMatchObject({ typicalPaise: 300000, isFuture: true });
  });

  it('counts part of the current slot', () => {
    // Half way through the 9–11 AM slot: half of that slot's typical ₹1,000 is expected
    const result = computeTodayPace(pastFridays, ist(16, '10:00'), 4000 * 100);
    expect(result.expectedByNowPaise).toBe(50000);
  });

  it('counts 1 AM sales towards last night, not the new day', () => {
    // Fri 16 Oct evening plus a 1 AM sale (Saturday on the calendar): at 2 AM it is still Friday's business day
    const now = ist(17, '02:00');
    const result = computeTodayPace([...pastFridays, order(16, '18:00', 2000), order(17, '01:00', 500)], now, 4000 * 100);
    expect(result.weekday).toBe('Friday');
    expect(result.soFarPaise).toBe(250000);
  });

  it('gives no percentage for a new café without a pattern yet', () => {
    const result = computeTodayPace([order(9, '10:00', 1000), order(16, '11:00', 500)], ist(16, '14:00'), 4000 * 100);
    expect(result.status).toBe('no_pattern');
    expect(result.soFarPaise).toBe(50000);
    expect(result.expectedByNowPaise).toBeNull();
    expect(result.pacePct).toBeNull();
  });

  it('gives no percentage without a forecast for today', () => {
    const result = computeTodayPace(pastFridays, ist(16, '14:00'), null);
    expect(result.status).toBe('ok');
    expect(result.pacePct).toBeNull();
  });
});
