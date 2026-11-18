import { formatPONumber, generatePONumber } from '../src/utils/poNumber';
import { documentPrefix as poPrefix } from '../src/utils/documentNumber';
import { NotificationService } from '../src/modules/notifications/notification.service';

jest.mock('../src/config/prisma', () => ({ prisma: {} }));
jest.mock('../src/config/socket', () => ({ emitNotificationToRooms: jest.fn() }));

describe('PO numbers', () => {
  it('builds the prefix like restaurant order numbers', () => {
    expect(poPrefix('Sea Breeze Café')).toBe('SEA');
    expect(poPrefix("D'Cafe")).toBe('DCA');
    expect(poPrefix('Q1')).toBe('QXX');
    expect(poPrefix('')).toBe('ALA');
    expect(poPrefix(null)).toBe('ALA');
  });

  it('pads the running number to 3 digits but never truncates it', () => {
    expect(formatPONumber('SEA', '20261102', 1)).toBe('PO-SEA-20261102-001');
    expect(formatPONumber('SEA', '20261102', 42)).toBe('PO-SEA-20261102-042');
    expect(formatPONumber('SEA', '20261102', 1234)).toBe('PO-SEA-20261102-1234');
  });

  it('takes the next number from the counter for that prefix and India date', async () => {
    const tx: any = {
      outlet: { findUnique: jest.fn().mockResolvedValue({ name: 'Sea Breeze', business: { name: 'SB Hospitality' } }) },
      $queryRaw: jest.fn().mockResolvedValue([{ value: 3 }]),
    };
    // 2 Nov 2026, 20:00 UTC is already 3 Nov in India
    const n = await generatePONumber(tx, 'outlet-1', new Date('2026-11-02T20:00:00Z'));
    expect(n).toBe('PO-SEA-20261103-003');
    expect(tx.$queryRaw.mock.calls[0]).toContain('PO-SEA-20261103');
  });

  it('falls back to the business name when the outlet has none', async () => {
    const tx: any = {
      outlet: { findUnique: jest.fn().mockResolvedValue({ name: '', business: { name: 'Bombay Bites' } }) },
      $queryRaw: jest.fn().mockResolvedValue([{ value: 1 }]),
    };
    expect(await generatePONumber(tx, 'outlet-1', new Date('2026-11-02T06:00:00Z'))).toBe('PO-BOM-20261102-001');
  });

  describe('notifications', () => {
    let createAndEmit: jest.SpyInstance;
    const po = {
      id: '3f2a1c9e-0000-4000-8000-000000000000',
      poNumber: 'PO-SEA-20261102-001',
      supplierId: 'sup-1',
      supplierUserId: 'user-1',
      totalAmountPence: 425000,
      outletId: 'outlet-1',
    };

    beforeEach(() => {
      createAndEmit = jest.spyOn(NotificationService, 'createAndEmit').mockResolvedValue(undefined as any);
    });
    afterEach(() => createAndEmit.mockRestore());

    it.each(['SENT', 'DISPATCHED', 'CANCELLED', 'RECEIVED'])('uses the PO number when a PO is %s', async (status) => {
      await NotificationService.notifyPOStatusChanged({ ...po, status });
      const params = createAndEmit.mock.calls[0][0];
      expect(params.message).toContain('PO-SEA-20261102-001');
      expect(params.message).not.toContain('PO #');
      expect(params.metadata).toMatchObject({ poId: po.id, poNumber: po.poNumber });
    });
  });
});
