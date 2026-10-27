import { WasteRepository } from '../src/modules/waste/waste.repository';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    wasteLog: { groupBy: jest.fn(), aggregate: jest.fn() },
  },
}));

// An instant from an India-time wall clock
const ist = (y: number, m: number, d: number, hhmm: string) => {
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min) - 330 * 60 * 1000);
};

describe('Waste "this month" is India time', () => {
  beforeEach(() => {
    (prisma.wasteLog.groupBy as jest.Mock).mockResolvedValue([]);
    (prisma.wasteLog.aggregate as jest.Mock).mockResolvedValue({ _sum: { costAtLoggingPaise: 0 } });
  });
  afterEach(() => jest.useRealTimers());

  it('at 2 AM on 1 November it is still 31 October\'s business day, so the month is October', async () => {
    jest.useFakeTimers({ now: ist(2026, 11, 1, '02:00'), doNotFake: ['nextTick', 'setImmediate'] });
    await new WasteRepository().getWasteSummary('outlet-1', 'biz-1');
    const where = (prisma.wasteLog.aggregate as jest.Mock).mock.calls[0][0].where;
    expect(where.createdAt.gte).toEqual(ist(2026, 10, 1, '05:00'));
  });

  it('from 5 AM on 1 November (India), the month starts at 5 AM on 1 November India time', async () => {
    jest.useFakeTimers({ now: ist(2026, 11, 1, '09:00'), doNotFake: ['nextTick', 'setImmediate'] });
    await new WasteRepository().getWasteSummary('outlet-1', 'biz-1');
    const where = (prisma.wasteLog.aggregate as jest.Mock).mock.calls[0][0].where;
    expect(where.createdAt.gte).toEqual(ist(2026, 11, 1, '05:00'));
  });
});
