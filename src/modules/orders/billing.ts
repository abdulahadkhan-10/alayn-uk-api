/**
 * Bill calculation — the single source of truth for every amount on a restaurant bill.
 *
 * Professional model (standard for restaurant POS): each round sent to the kitchen is a KOT
 * with no money on it; the bill is always calculated from ALL items on the order with this function,
 * recalculated whenever the bill changes, and frozen at settlement. Never add amounts round by round.
 *
 * UK pricing: menu prices INCLUDE VAT, so VAT is the part of the price already paid, not an extra.
 *
 *   subtotal       = Σ unit price × qty          (VAT-inclusive)
 *   net            = subtotal − discount
 *   VAT            = net × rate / (100 + rate)   (0 when the outlet isn't VAT-registered)
 *   service charge = net × rate                  (dine-in only; voluntary — the customer may ask to
 *                                                 remove it, so it is outside the scope of VAT)
 *   total          = net + service charge        (bills are not rounded)
 *
 * The frontend POS preview mirrors this in alayn-uk/src/lib/billing.ts — keep them in sync.
 */

export interface BillRates {
  /** Percentages, e.g. 20 for 20% */
  vatRate: number;
  serviceChargeRate: number;
}

export interface BillOptions {
  /** Service charge only applies to dine-in (table) orders */
  dineIn: boolean;
  serviceChargeWaived?: boolean;
  discountPence?: number;
  /** false: the outlet is below the VAT threshold, so its bills carry no VAT */
  vatRegistered?: boolean;
}

export interface BillLine {
  unitPricePence: number;
  quantity: number;
}

export interface BillTotals {
  subtotalPence: number;
  discountPence: number;
  serviceChargePence: number;
  /** Value of the goods excluding VAT (net − VAT) */
  netOfVatPence: number;
  vatPence: number;
  roundOffPence: number;
  totalPence: number;
  /** Rates actually applied (0 where not applicable) — saved on the order so receipts never drift */
  appliedRates: BillRates;
}

export const DINE_IN_SOURCES = ['TABLE', 'QR'];

export function isDineIn(source?: string | null): boolean {
  return !!source && DINE_IN_SOURCES.includes(source);
}

export function calculateBill(items: BillLine[], rates: BillRates, options: BillOptions): BillTotals {
  const subtotalPence = items.reduce((sum, item) => sum + item.unitPricePence * item.quantity, 0);
  const discountPence = Math.min(Math.max(0, Math.round(options.discountPence || 0)), subtotalPence);
  const netPence = subtotalPence - discountPence;

  const serviceChargeRate =
    options.dineIn && !options.serviceChargeWaived ? Math.max(0, rates.serviceChargeRate || 0) : 0;
  const serviceChargePence = Math.round((netPence * serviceChargeRate) / 100);

  const vatRate = options.vatRegistered === false ? 0 : Math.max(0, rates.vatRate || 0);
  const vatPence = Math.round((netPence * vatRate) / (100 + vatRate));

  return {
    subtotalPence,
    discountPence,
    serviceChargePence,
    netOfVatPence: netPence - vatPence,
    vatPence,
    roundOffPence: 0,
    totalPence: netPence + serviceChargePence,
    appliedRates: { vatRate, serviceChargeRate },
  };
}
