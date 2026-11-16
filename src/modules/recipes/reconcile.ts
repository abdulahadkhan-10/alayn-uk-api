import { Prisma, PrismaClient } from '@prisma/client';
import { deductStockForOrder } from './stockDeduction';

export interface ReconcileOptions {
  outletId: string;
  /** Only bills settled on or after this moment */
  from: Date;
  /** False (the default everywhere) only counts what would be deducted and writes nothing */
  apply: boolean;
}

export interface ReconcileResult {
  /** The date actually used: never earlier than the branch's latest stock count */
  effectiveFrom: Date;
  clampedToLastCount: boolean;
  billsFound: number;
  billsDeducted: number;
  ingredientMovements: number;
  applied: boolean;
}

/**
 * Takes recipe ingredients out of stock for bills that were settled before recipes existed (or before the
 * feature was switched on) and so were never deducted.
 *
 * A stock count already sets stock to what was on the shelf, so a sale from before that count is already
 * reflected in it. Back-filling such a sale would count it twice, so bills older than the branch's latest
 * count are left alone.
 */
export async function reconcileOutlet(
  db: Pick<PrismaClient, 'stockLedgerEntry' | 'order' | '$transaction'>,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const { outletId, from, apply } = options;

  const lastCount = await db.stockLedgerEntry.findFirst({
    where: { outletId, reason: 'COUNT' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const clamped = !!lastCount && lastCount.createdAt > from;
  const effectiveFrom = clamped ? lastCount!.createdAt : from;

  const bills = await db.order.findMany({
    where: { outletId, status: 'COMPLETED', deletedAt: null, stockDeductedAt: null, updatedAt: { gte: effectiveFrom } },
    select: { id: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
  });

  const result: ReconcileResult = {
    effectiveFrom,
    clampedToLastCount: clamped,
    billsFound: bills.length,
    billsDeducted: 0,
    ingredientMovements: 0,
    applied: apply,
  };
  if (!apply) return result;

  for (const bill of bills) {
    // One bill per transaction: a failure leaves the bills already done in place and can simply be re-run
    const outcome = await db.$transaction((tx: Prisma.TransactionClient) => deductStockForOrder(tx, bill.id, bill.updatedAt));
    if (outcome.deducted > 0) {
      result.billsDeducted++;
      result.ingredientMovements += outcome.deducted;
    }
  }
  return result;
}
