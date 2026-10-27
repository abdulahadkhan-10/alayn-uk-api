/**
 * Split payments — settling one bill with several payments (e.g. ₹100 cash + ₹185 UPI on a ₹285 bill).
 *
 * All amounts are integer paise. A settlement is accepted only when the payments add up to exactly the
 * balance still due, and every online payment (UPI / card) has been confirmed as received by the cashier.
 * The frontend checkout mirrors these rules in alayn-frontend/src/lib/splitPayment.ts — keep them in sync.
 */
import { AppError } from '../../utils/AppError';

export type PaymentMethodCode = 'CASH' | 'CARD' | 'UPI';

/** Methods where the money arrives outside the till, so the cashier must confirm it was received */
export const ONLINE_METHODS: PaymentMethodCode[] = ['UPI', 'CARD'];

export const MAX_SPLIT_PAYMENTS = 6;

export interface SettlementPaymentInput {
  method: PaymentMethodCode;
  amountPaise: number;
  reference?: string;
  verified?: boolean;
}

export interface SettlementPayment {
  method: PaymentMethodCode;
  amountPaise: number;
  reference: string | null;
  isOnline: boolean;
}

export interface PaymentLike {
  method: string;
  amountPaise: number;
  status: string;
  reference?: string | null;
}

export const isOnlineMethod = (method: string) => ONLINE_METHODS.includes(method as PaymentMethodCode);

export const formatRupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

const METHOD_LABELS: Record<string, string> = { CASH: 'Cash', CARD: 'Card', UPI: 'UPI' };

/** Sum of payments that count towards the bill (confirmed only) */
export function confirmedPaidPaise(payments: PaymentLike[] = []): number {
  return payments.filter((p) => p.status === 'CONFIRMED').reduce((sum, p) => sum + p.amountPaise, 0);
}

/**
 * Check the payments a cashier entered against the balance due. Throws an AppError the cashier can act on;
 * returns the payments to record.
 */
export function validateSettlementPayments(
  payments: SettlementPaymentInput[],
  balanceDuePaise: number
): SettlementPayment[] {
  if (payments.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Add at least one payment to settle the bill.', 400);
  }
  if (payments.length > MAX_SPLIT_PAYMENTS) {
    throw new AppError('VALIDATION_ERROR', `A bill can be split across at most ${MAX_SPLIT_PAYMENTS} payments.`, 400);
  }

  const normalized = payments.map((p) => {
    if (!Number.isSafeInteger(p.amountPaise) || p.amountPaise <= 0) {
      throw new AppError('VALIDATION_ERROR', 'Every payment needs an amount greater than zero.', 400);
    }
    return {
      method: p.method,
      amountPaise: p.amountPaise,
      reference: p.reference?.trim() || null,
      isOnline: isOnlineMethod(p.method),
      verified: p.verified === true,
    };
  });

  const allocatedPaise = normalized.reduce((sum, p) => sum + p.amountPaise, 0);
  if (allocatedPaise !== balanceDuePaise) {
    const gap = balanceDuePaise - allocatedPaise;
    throw new AppError(
      'PAYMENT_AMOUNT_MISMATCH',
      gap > 0
        ? `Payments add up to ${formatRupees(allocatedPaise)} but ${formatRupees(balanceDuePaise)} is due — ${formatRupees(gap)} is still unallocated.`
        : `Payments add up to ${formatRupees(allocatedPaise)}, which is ${formatRupees(-gap)} more than the ${formatRupees(balanceDuePaise)} due.`,
      400
    );
  }

  const unverified = normalized.find((p) => p.isOnline && !p.verified);
  if (unverified) {
    throw new AppError(
      'PAYMENT_NOT_VERIFIED',
      `Confirm the ${METHOD_LABELS[unverified.method]} payment of ${formatRupees(unverified.amountPaise)} was received before settling.`,
      400
    );
  }

  return normalized.map(({ verified: _verified, ...p }) => p);
}

/** e.g. "Cash ₹100.00 + UPI ₹185.00" — used in the bill's status history */
export function describePayments(payments: Pick<PaymentLike, 'method' | 'amountPaise'>[]): string {
  return payments.map((p) => `${METHOD_LABELS[p.method] || p.method} ${formatRupees(p.amountPaise)}`).join(' + ');
}

/**
 * How a bill was paid, for responses, receipts and reports. `paymentMethod` stays a single value for
 * older screens: the method when one was used, 'SPLIT' when several were.
 */
export function summarizePayments(payments: PaymentLike[] = [], totalPaise = 0) {
  const confirmed = payments.filter((p) => p.status === 'CONFIRMED');
  const paidPaise = confirmed.reduce((sum, p) => sum + p.amountPaise, 0);
  const methods = Array.from(new Set(confirmed.map((p) => p.method)));
  // Voided intents never describe the bill; before any confirmed payment, show the open intent (legacy behaviour)
  const live = payments.filter((p) => p.status !== 'VOID');

  return {
    paymentMethod: methods.length > 1 ? 'SPLIT' : methods[0] || live[0]?.method || undefined,
    paymentStatus: confirmed.length > 0 ? 'CONFIRMED' : live[0]?.status || 'PENDING',
    isSplitPayment: confirmed.length > 1,
    paymentSplits: confirmed.map((p) => ({
      method: p.method,
      amountPaise: p.amountPaise,
      amount: p.amountPaise / 100,
      reference: p.reference || null,
    })),
    paidAmount: paidPaise / 100,
    balanceDuePaise: Math.max(0, totalPaise - paidPaise),
    balanceDue: Math.max(0, totalPaise - paidPaise) / 100,
  };
}
