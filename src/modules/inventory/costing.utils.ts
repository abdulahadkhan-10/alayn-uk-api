/**
 * Inventory Costing & Valuation Utilities
 * Implements Moving Weighted Average Cost (WAC / AVCO)
 */

export interface MovingAverageInput {
  currentStock: number;
  currentUnitCostPaise: number;
  incomingQty: number;
  incomingUnitCostPaise: number;
}

/**
 * Calculates the new Moving Weighted Average Cost (WAC) when new stock arrives.
 *
 * Formula:
 * New Avg = ((Current Stock * Current Unit Cost) + (Incoming Qty * Incoming Unit Cost)) / (Current Stock + Incoming Qty)
 *
 * Edge cases handled:
 * - If incoming quantity <= 0: keeps current unit cost.
 * - If current stock <= 0 (out of stock / negative stock drift): sets new unit cost to incoming cost.
 * - Integer paise rounding: returns integer paise to avoid fractional floating-point drift.
 */
export function computeMovingAverageCost(input: MovingAverageInput): number {
  const { currentStock, currentUnitCostPaise, incomingQty, incomingUnitCostPaise } = input;

  if (incomingQty <= 0) {
    return currentUnitCostPaise;
  }

  const validCurrentStock = Math.max(0, currentStock);

  if (validCurrentStock === 0) {
    return Math.round(incomingUnitCostPaise);
  }

  const currentTotalVal = validCurrentStock * currentUnitCostPaise;
  const incomingTotalVal = incomingQty * incomingUnitCostPaise;
  const totalQty = validCurrentStock + incomingQty;

  return Math.round((currentTotalVal + incomingTotalVal) / totalQty);
}

/**
 * Calculates the total financial loss for wasted inventory at the given unit cost.
 */
export function computeWasteLossPaise(quantity: number, unitCostPaise: number): number {
  if (quantity <= 0 || unitCostPaise <= 0) return 0;
  return Math.round(quantity * unitCostPaise);
}
