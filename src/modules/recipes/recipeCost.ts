/** Pure costing for a recipe: what one portion costs to make and what it leaves from the selling price. */

export interface CostLineInput {
  quantityPerUnit: number;
  wastagePercent: number;
  unitCostPaise: number;
}

export interface RecipeCostSummary {
  /** Cost of the ingredients in one portion, wastage included */
  costPerPortionPaise: number;
  pricePaise: number;
  marginPaise: number;
  /** Ingredient cost as a % of the selling price (1 decimal); null when the price is 0 */
  foodCostPercent: number | null;
}

export const lineCostPaise = (l: CostLineInput) =>
  Math.round(l.quantityPerUnit * (1 + l.wastagePercent / 100) * l.unitCostPaise);

export function summarizeRecipeCost(lines: CostLineInput[], pricePaise: number): RecipeCostSummary {
  const costPerPortionPaise = lines.reduce((sum, l) => sum + lineCostPaise(l), 0);
  return {
    costPerPortionPaise,
    pricePaise,
    marginPaise: pricePaise - costPerPortionPaise,
    foodCostPercent: pricePaise > 0 ? Math.round((costPerPortionPaise / pricePaise) * 1000) / 10 : null,
  };
}
