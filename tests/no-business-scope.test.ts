/**
 * "No business" must mean "nothing", never "every business". A login without a business (only a super
 * admin today, but the database allows it) must not be able to reach another business's outlet or data.
 */
import { businessMiddleware } from '../src/middleware/business.middleware';
import { WasteRepository } from '../src/modules/waste/waste.repository';
import { PurchaseOrderRepository } from '../src/modules/purchase-orders/purchaseOrder.repository';
import { PurchaseOrderService } from '../src/modules/purchase-orders/purchaseOrder.service';
import { AttendanceRepository } from '../src/modules/attendance/attendance.repository';
import { EmployeeRepository } from '../src/modules/employees/employee.repository';
import { ShiftRepository } from '../src/modules/shifts/shift.repository';
import { NO_MATCH_UUID } from '../src/utils/tenantScope';
import { prisma } from '../src/config/prisma';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    outlet: { findFirst: jest.fn() },
    userOutlet: { findUnique: jest.fn() },
    wasteLog: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(), aggregate: jest.fn() },
    item: { findMany: jest.fn() },
    purchaseOrder: { findMany: jest.fn(), findFirst: jest.fn() },
    employee: { findFirst: jest.fn() },
    leaveRequest: { findFirst: jest.fn() },
    shiftSwapRequest: { findFirst: jest.fn() },
  },
}));

const OTHER_BUSINESS_OUTLET = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const whereOf = (mock: unknown) => (mock as jest.Mock).mock.calls[0][0].where;
const noBusiness = { outlet: { businessId: NO_MATCH_UUID } };

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.wasteLog.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.wasteLog.count as jest.Mock).mockResolvedValue(0);
  (prisma.wasteLog.groupBy as jest.Mock).mockResolvedValue([]);
  (prisma.wasteLog.aggregate as jest.Mock).mockResolvedValue({ _sum: { costAtLoggingPaise: 0 } });
  (prisma.item.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.purchaseOrder.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.purchaseOrder.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.outlet.findFirst as jest.Mock).mockResolvedValue(null);
});

describe('Access check (business middleware)', () => {
  const run = async (user: any, outletId: string) => {
    const next = jest.fn();
    const req: any = { user, headers: { 'x-outlet-id': outletId }, query: {}, params: {}, body: {} };
    await businessMiddleware(req, {} as any, next);
    return { req, error: next.mock.calls[0][0] };
  };

  it('refuses an owner or manager whose login has no business, for a specific outlet', async () => {
    // Without this, the outlet lookup had no business filter and found any business's outlet
    (prisma.outlet.findFirst as jest.Mock).mockResolvedValue({ id: OTHER_BUSINESS_OUTLET, name: 'Other café' });
    for (const role of ['BUSINESS_OWNER', 'MANAGER', 'STAFF']) {
      const { error } = await run({ id: 'u1', role, businessId: null }, OTHER_BUSINESS_OUTLET);
      expect(error).toMatchObject({ statusCode: 403 });
    }
  });

  it('refuses "All outlets" for an owner whose login has no business', async () => {
    const { req, error } = await run({ id: 'u1', role: 'BUSINESS_OWNER', businessId: null }, 'all');
    expect(error).toMatchObject({ statusCode: 403 });
    expect(req.outletId).toBeUndefined();
  });

  it('still lets a super admin inspect a specific outlet', async () => {
    (prisma.outlet.findFirst as jest.Mock).mockResolvedValue({ id: OTHER_BUSINESS_OUTLET, name: 'Any café' });
    const { req, error } = await run({ id: 'admin', role: 'SUPER_ADMIN', businessId: null }, OTHER_BUSINESS_OUTLET);
    expect(error).toBeUndefined();
    expect(req.outletId).toBe(OTHER_BUSINESS_OUTLET);
  });
});

describe('"All outlets" with no business matches nothing', () => {
  it('waste logs and waste summary (B1)', async () => {
    const repo = new WasteRepository();
    await repo.findMany('all', 20, 0, undefined);
    expect(whereOf(prisma.wasteLog.findMany)).toEqual(noBusiness);
    expect(whereOf(prisma.wasteLog.count)).toEqual(noBusiness);

    await repo.getWasteSummary('all', undefined);
    expect(whereOf(prisma.wasteLog.groupBy)).toEqual(noBusiness);
    expect(whereOf(prisma.wasteLog.aggregate)).toMatchObject(noBusiness);
  });

  it('purchase orders, list and by ID (B2)', async () => {
    const repo = new PurchaseOrderRepository();
    await repo.findPOs('all', undefined);
    expect(whereOf(prisma.purchaseOrder.findMany)).toMatchObject({ supplier: { businessId: NO_MATCH_UUID } });

    await repo.findPOById('all', 'po-1', undefined);
    expect(whereOf(prisma.purchaseOrder.findFirst)).toMatchObject({ id: 'po-1', supplier: { businessId: NO_MATCH_UUID } });
  });

  it('never registers a supplier at another business\'s outlet', async () => {
    const service = new PurchaseOrderService();
    await expect(service.createSupplier('all', undefined, { name: 'Milk Co' })).rejects.toMatchObject({ statusCode: 400 });
    expect(whereOf(prisma.outlet.findFirst)).toMatchObject({ businessId: NO_MATCH_UUID });

    jest.clearAllMocks();
    (prisma.outlet.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(service.createSupplier(OTHER_BUSINESS_OUTLET, undefined, { name: 'Milk Co' })).rejects.toMatchObject({ statusCode: 404 });
    expect(whereOf(prisma.outlet.findFirst)).toMatchObject({ id: OTHER_BUSINESS_OUTLET, businessId: NO_MATCH_UUID });
  });

  it('employee, attendance, leave and shift-swap lookups by ID (B4)', async () => {
    await new AttendanceRepository().findEmployee('all', 'emp-1', null);
    expect(whereOf(prisma.employee.findFirst)).toMatchObject({ id: 'emp-1', ...noBusiness });

    jest.clearAllMocks();
    await new EmployeeRepository().findById('all', 'emp-1', null);
    expect(whereOf(prisma.employee.findFirst)).toMatchObject({ id: 'emp-1', ...noBusiness });

    await new EmployeeRepository().findLeaveRequestById('all', 'leave-1', null);
    expect(whereOf(prisma.leaveRequest.findFirst)).toEqual({ id: 'leave-1', ...noBusiness });

    await new ShiftRepository().findSwapRequestById('all', 'swap-1', null);
    expect(whereOf(prisma.shiftSwapRequest.findFirst)).toEqual({ id: 'swap-1', ...noBusiness });
  });
});

describe('normal use is unchanged', () => {
  it('a business sees its own data in "All outlets"; one outlet sees only itself', async () => {
    await new WasteRepository().findMany('all', 20, 0, 'biz-1');
    expect(whereOf(prisma.wasteLog.findMany)).toEqual({ outlet: { businessId: 'biz-1' } });

    jest.clearAllMocks();
    await new PurchaseOrderRepository().findPOs('outlet-1', 'biz-1');
    expect(whereOf(prisma.purchaseOrder.findMany)).toEqual({ outletId: 'outlet-1', deletedAt: null });

    await new EmployeeRepository().findLeaveRequestById('all', 'leave-1', 'biz-1');
    expect(whereOf(prisma.leaveRequest.findFirst)).toEqual({ id: 'leave-1', outlet: { businessId: 'biz-1' } });
  });
});
