/**
 * Inventory Costing & Valuation Utilities
 * Implements Moving Weighted Average Cost (WAC / AVCO)
 */

export interface MovingAverageInput {
  currentStock: number;
  currentUnitCostPence: number;
  incomingQty: number;
  incomingUnitCostPence: number;
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
 * - Integer pence rounding: returns integer pence to avoid fractional floating-point drift.
 */
export function computeMovingAverageCost(input: MovingAverageInput): number {
  const { currentStock, currentUnitCostPence, incomingQty, incomingUnitCostPence } = input;

  if (incomingQty <= 0) {
    return currentUnitCostPence;
  }

  const validCurrentStock = Math.max(0, currentStock);

  if (validCurrentStock === 0) {
    return Math.round(incomingUnitCostPence);
  }

  const currentTotalVal = validCurrentStock * currentUnitCostPence;
  const incomingTotalVal = incomingQty * incomingUnitCostPence;
  const totalQty = validCurrentStock + incomingQty;

  return Math.round((currentTotalVal + incomingTotalVal) / totalQty);
}

/**
 * Calculates the total financial loss for wasted inventory at the given unit cost.
 */
export function computeWasteLossPence(quantity: number, unitCostPence: number): number {
  if (quantity <= 0 || unitCostPence <= 0) return 0;
  return Math.round(quantity * unitCostPence);
}
