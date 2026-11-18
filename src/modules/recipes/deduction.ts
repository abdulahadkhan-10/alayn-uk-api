/**
 * Pure maths for recipe-based stock deduction (no database).
 * Given what a bill sold and the recipes of those dishes, work out how much of each ingredient
 * to take out of stock and what each line's ingredients cost.
 */

export interface SoldLine {
  orderItemId: string;
  menuItemId: string;
  quantity: number;
  status: string;
  /** Add-on / option choices on this line (ModifierItem ids) */
  modifierIds?: string[];
}

export interface ModifierRecipeLineInput {
  modifierItemId: string;
  itemId: string;
  quantityPerUnit: number;
  wastagePercent: number;
}

export interface RecipeLineInput {
  menuItemId: string;
  itemId: string;
  /** In the ingredient's own unit, per one portion */
  quantityPerUnit: number;
  /** Trimming / yield loss, on top of quantityPerUnit */
  wastagePercent: number;
}

export interface Deduction {
  itemId: string;
  /** Positive amount to take out of stock, to 4 decimals */
  quantity: number;
  unitCostPence: number;
}

export interface LineCost {
  orderItemId: string;
  /** null when the dish has no recipe */
  recipeCostPence: number | null;
}

export interface DeductionResult {
  deductions: Deduction[];
  lineCosts: LineCost[];
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Ingredient amount for one portion, wastage included */
const perPortion = (l: IngredientUse) => l.quantityPerUnit * (1 + l.wastagePercent / 100);

/** What one recipe line uses of one ingredient; dishes and add-ons share this shape */
interface IngredientUse {
  itemId: string;
  quantityPerUnit: number;
  wastagePercent: number;
}

export function computeDeductions(
  sold: SoldLine[],
  recipeLines: RecipeLineInput[],
  unitCostPenceByItem: Record<string, number>,
  modifierRecipeLines: ModifierRecipeLineInput[] = [],
): DeductionResult {
  const linesByMenuItem = new Map<string, IngredientUse[]>();
  for (const l of recipeLines) {
    const list = linesByMenuItem.get(l.menuItemId) ?? [];
    list.push(l);
    linesByMenuItem.set(l.menuItemId, list);
  }
  const linesByModifier = new Map<string, IngredientUse[]>();
  for (const l of modifierRecipeLines) {
    const list = linesByModifier.get(l.modifierItemId) ?? [];
    list.push(l);
    linesByModifier.set(l.modifierItemId, list);
  }

  const totals = new Map<string, number>();
  const lineCosts: LineCost[] = [];

  for (const s of sold) {
    if (s.status === 'CANCELLED') continue;
    // The dish's own recipe, plus the recipe of each add-on chosen on this line
    const recipe: IngredientUse[] = [
      ...(linesByMenuItem.get(s.menuItemId) ?? []),
      ...(s.modifierIds ?? []).flatMap((id) => linesByModifier.get(id) ?? []),
    ];
    if (recipe.length === 0) {
      lineCosts.push({ orderItemId: s.orderItemId, recipeCostPence: null });
      continue;
    }
    if (s.quantity <= 0) continue;

    let portionCost = 0;
    for (const l of recipe) {
      const amount = perPortion(l);
      totals.set(l.itemId, (totals.get(l.itemId) ?? 0) + amount * s.quantity);
      portionCost += amount * (unitCostPenceByItem[l.itemId] ?? 0);
    }
    lineCosts.push({ orderItemId: s.orderItemId, recipeCostPence: Math.round(portionCost * s.quantity) });
  }

  const deductions: Deduction[] = [];
  for (const [itemId, total] of totals) {
    const quantity = round4(total);
    if (quantity <= 0) continue;
    deductions.push({ itemId, quantity, unitCostPence: unitCostPenceByItem[itemId] ?? 0 });
  }
  return { deductions, lineCosts };
}
