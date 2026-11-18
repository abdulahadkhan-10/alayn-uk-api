/** Pure costing for a recipe: what one portion costs to make and what it leaves from the selling price. */

export interface CostLineInput {
  quantityPerUnit: number;
  wastagePercent: number;
  unitCostPence: number;
}

export interface RecipeCostSummary {
  /** Cost of the ingredients in one portion, wastage included */
  costPerPortionPence: number;
  pricePence: number;
  marginPence: number;
  /** Ingredient cost as a % of the selling price (1 decimal); null when the price is 0 */
  foodCostPercent: number | null;
}

export const lineCostPence = (l: CostLineInput) =>
  Math.round(l.quantityPerUnit * (1 + l.wastagePercent / 100) * l.unitCostPence);

export function summarizeRecipeCost(lines: CostLineInput[], pricePence: number): RecipeCostSummary {
  const costPerPortionPence = lines.reduce((sum, l) => sum + lineCostPence(l), 0);
  return {
    costPerPortionPence,
    pricePence,
    marginPence: pricePence - costPerPortionPence,
    foodCostPercent: pricePence > 0 ? Math.round((costPerPortionPence / pricePence) * 1000) / 10 : null,
  };
}
