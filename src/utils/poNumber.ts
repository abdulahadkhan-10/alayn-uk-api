import { Prisma } from '@prisma/client';
import { outletDateKey } from './outletTime';
import { nextDocumentNumber, outletDocumentPrefix } from './documentNumber';

/**
 * Purchase order numbers, in the same spirit as restaurant order numbers:
 *
 *   PO-SEA-20261102-001
 *   │  │   │        └ running number for this prefix and day (3+ digits)
 *   │  │   └ date in India time
 *   │  └ first three letters of the outlet (else business) name
 *   └ document type
 *
 * Race-free and gapless per prefix and day; see documentNumber.ts. Call with the transaction
 * client that also creates the PO.
 */
export function formatPONumber(prefix: string, dateKey: string, seq: number): string {
  return `PO-${prefix}-${dateKey}-${String(seq).padStart(3, '0')}`;
}

export async function generatePONumber(
  tx: Prisma.TransactionClient,
  outletId: string,
  now: Date = new Date()
): Promise<string> {
  const prefix = await outletDocumentPrefix(tx, outletId);
  const dateKey = outletDateKey(now);
  // Counters for existing POs were seeded by the 20261102150000_purchase_order_code migration
  const seq = await nextDocumentNumber(tx, `PO-${prefix}-${dateKey}`);
  return formatPONumber(prefix, dateKey, seq);
}
