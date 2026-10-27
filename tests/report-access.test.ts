import { prisma } from '../src/config/prisma';
import { accessibleOutletIds, resolveReportOutlets } from '../src/modules/reports/access';
import { parseReportQuery } from '../src/modules/reports/query';
import { buildReport } from '../src/modules/reports/report.service';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    outlet: { findMany: jest.fn() },
    userOutlet: { findMany: jest.fn() },
    order: { findMany: jest.fn(), findFirst: jest.fn() },
    wasteLog: { findMany: jest.fn() },
    menuItem: { findMany: jest.fn() },
    menuCategory: { findMany: jest.fn() },
  },
}));

const p = prisma as any;
const owner = { id: 'u1', role: 'BUSINESS_OWNER', businessId: 'b1' };
const manager = { id: 'u2', role: 'MANAGER', businessId: 'b1' };

beforeEach(() => {
  jest.resetAllMocks();
  p.outlet.findMany.mockImplementation(async (args: any) =>
    args.where.businessId === 'b1' || args.where.id
      ? [{ id: 'o1', name: 'One', business: { name: 'Biz' } }, { id: 'o2', name: 'Two', business: { name: 'Biz' } }]
      : [],
  );
  p.userOutlet.findMany.mockResolvedValue([{ outletId: 'o1' }]);
});

describe('outlet access', () => {
  it('owner gets every outlet of their business only', async () => {
    expect(await accessibleOutletIds(owner)).toEqual(['o1', 'o2']);
    expect(p.outlet.findMany.mock.calls[0][0].where).toMatchObject({ businessId: 'b1', deletedAt: null });
  });

  it('manager gets only assigned outlets', async () => {
    expect(await accessibleOutletIds(manager)).toEqual(['o1']);
    expect(p.outlet.findMany).not.toHaveBeenCalled();
  });

  it('manager asking for an unassigned outlet gets 403', async () => {
    await expect(resolveReportOutlets(manager, 'o1', ['o2'])).rejects.toMatchObject({ statusCode: 403 });
  });

  it('several outlets need the all-outlets selection', async () => {
    await expect(resolveReportOutlets(owner, 'o1', ['o1', 'o2'])).rejects.toMatchObject({ statusCode: 403 });
    await expect(resolveReportOutlets(owner, 'all', ['o1', 'o2'])).resolves.toEqual(['o1', 'o2']);
  });

  it('with one outlet selected, only that outlet can be asked for', async () => {
    await expect(resolveReportOutlets(owner, 'o1', ['o2'])).rejects.toMatchObject({ statusCode: 403 });
    await expect(resolveReportOutlets(owner, 'o1', ['o1'])).resolves.toEqual(['o1']);
    await expect(resolveReportOutlets(owner, 'o1', ['o1', 'o1'])).resolves.toEqual(['o1']);
  });

  it('defaults to the selected outlet, or every accessible one for all', async () => {
    await expect(resolveReportOutlets(owner, 'o2')).resolves.toEqual(['o2']);
    await expect(resolveReportOutlets(owner, 'all')).resolves.toEqual(['o1', 'o2']);
  });

  it('super admin without a business only gets the selected outlet', async () => {
    const sa = { id: 'u3', role: 'SUPER_ADMIN', businessId: null };
    await expect(resolveReportOutlets(sa, 'o9')).resolves.toEqual(['o9']);
    await expect(resolveReportOutlets(sa, 'all')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('parseReportQuery', () => {
  it('defaults to THIS_MONTH vs PREVIOUS', () => {
    const r = parseReportQuery({});
    expect(r.preset).toBe('THIS_MONTH');
    expect(r.compare).toBe('PREVIOUS');
  });

  it('rejects hourFrom >= hourTo with a 400', () => {
    expect(() => parseReportQuery({ hourFrom: '14', hourTo: '10' })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('parses lists and numbers', () => {
    const r = parseReportQuery({ outlets: 'a,b', sources: 'QR,TABLE', weekdays: '0,6', hourFrom: '9', hourTo: '17' });
    expect(r.outlets).toEqual(['a', 'b']);
    expect(r.filters).toMatchObject({ sources: ['QR', 'TABLE'], weekdays: [0, 6], hourFrom: 9, hourTo: 17 });
  });
});

describe('buildReport', () => {
  it('loads only the allowed outlets', async () => {
    p.order.findMany.mockResolvedValue([]);
    p.wasteLog.findMany.mockResolvedValue([]);
    p.menuItem.findMany.mockResolvedValue([]);
    const report = await buildReport(parseReportQuery({ preset: 'LAST_MONTH' }), ['o1'], new Date('2026-10-20T06:00:00Z'));
    expect(p.order.findMany).toHaveBeenCalledTimes(2);
    for (const call of p.order.findMany.mock.calls) {
      expect(call[0].where.outletId).toEqual({ in: ['o1'] });
      expect(call[0].where.deletedAt).toBeNull();
    }
    for (const call of p.wasteLog.findMany.mock.calls) expect(call[0].where.outletId).toEqual({ in: ['o1'] });
    expect(report.scope.businessName).toBe('Biz');
  });

  it('has no comparison when compare is NONE', async () => {
    p.order.findMany.mockResolvedValue([]);
    p.wasteLog.findMany.mockResolvedValue([]);
    p.menuItem.findMany.mockResolvedValue([]);
    const report = await buildReport(parseReportQuery({ compare: 'NONE' }), ['o1']);
    expect(p.order.findMany).toHaveBeenCalledTimes(1);
    expect(report.comparison).toBeNull();
    expect(report.totals.previous).toBeNull();
  });

  it('refuses the hourly view for periods longer than 7 days', async () => {
    p.order.findMany.mockResolvedValue([]);
    p.wasteLog.findMany.mockResolvedValue([]);
    const now = new Date('2026-10-20T06:00:00Z');
    await expect(buildReport(parseReportQuery({ preset: 'LAST_MONTH', granularity: 'hour' }), ['o1'], now)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Hourly view works for up to 7 days. Pick Day, Week or Month.',
    });
    expect(p.order.findMany).not.toHaveBeenCalled();
    await expect(buildReport(parseReportQuery({ preset: 'LAST_7_DAYS', granularity: 'hour' }), ['o1'], now)).resolves.toBeDefined();
  });
});
