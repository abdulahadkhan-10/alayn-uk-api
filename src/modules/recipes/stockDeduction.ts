import { Prisma } from '@prisma/client';
import { computeDeductions } from './deduction';

export interface LowStockHit {
  itemId: string;
  itemName: string;
  unit: string;
  stock: number;
  threshold: number;
}

export interface DeductionOutcome {
  /** Ingredients taken out of stock for this bill */
  deducted: number;
  /** Ingredients that dropped to or below their reorder level because of this bill */
  lowStock: LowStockHit[];
}

const NOTHING: DeductionOutcome = { deducted: 0, lowStock: [] };

/** Ids of the add-on choices saved on an order line (OrderItem.modifiersJson); unreadable data counts as none. */
function modifierIdsOf(modifiersJson: string | null): string[] {
  if (!modifiersJson) return [];
  try {
    const parsed = JSON.parse(modifiersJson);
    return Array.isArray(parsed) ? parsed.map((m) => m?.id).filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Takes a settled bill's recipe ingredients out of stock. Call inside the settle transaction.
 *
 * - Dishes without a recipe are ignored, so recipes stay optional.
 * - Runs at most once per bill (Order.stockDeductedAt is claimed before anything is written).
 * - Never refuses a sale for lack of stock: the balance may go negative and shows up as a low-stock alert.
 */
export async function deductStockForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  /** When the stock left; defaults to now. Back-filling an old bill passes the time it was sold. */
  at?: Date,
): Promise<DeductionOutcome> {
  // Claim the bill. A second call (or a retry) matches nothing and exits.
  const claimed = await tx.order.updateMany({
    where: { id: orderId, stockDeductedAt: null },
    data: { stockDeductedAt: new Date() },
  });
  if (claimed.count === 0) return NOTHING;

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { outletId: true, items: { select: { id: true, menuItemId: true, quantity: true, status: true, modifiersJson: true } } },
  });
  if (!order) return NOTHING;

  const sold = order.items
    .filter((i) => i.status !== 'CANCELLED')
    .map((i) => ({
      orderItemId: i.id,
      menuItemId: i.menuItemId,
      quantity: i.quantity,
      status: i.status,
      modifierIds: modifierIdsOf(i.modifiersJson),
    }));
  if (sold.length === 0) return NOTHING;

  const modifierIds = [...new Set(sold.flatMap((s) => s.modifierIds))];
  const [recipeRows, modifierRows] = await Promise.all([
    tx.recipe.findMany({
      where: { outletId: order.outletId, menuItemId: { in: [...new Set(sold.map((s) => s.menuItemId))] } },
    }),
    modifierIds.length === 0
      ? Promise.resolve([])
      : tx.modifierRecipe.findMany({ where: { outletId: order.outletId, modifierItemId: { in: modifierIds } } }),
  ]);
  if (recipeRows.length === 0 && modifierRows.length === 0) return NOTHING;

  // Ingredients that were deleted from stock are skipped
  const ingredientIds = [...new Set([...recipeRows.map((r) => r.itemId), ...modifierRows.map((r) => r.itemId)])];
  const items = await tx.item.findMany({
    where: { id: { in: ingredientIds }, outletId: order.outletId, deletedAt: null },
    select: { id: true, name: true, unit: true, unitCostPence: true, reorderThreshold: true },
  });
  const itemById = new Map(items.map((i) => [i.id, i]));
  const recipeLines = recipeRows
    .filter((r) => itemById.has(r.itemId))
    .map((r) => ({
      menuItemId: r.menuItemId,
      itemId: r.itemId,
      quantityPerUnit: r.quantityPerUnit.toNumber(),
      wastagePercent: r.wastagePercent.toNumber(),
    }));

  const modifierLines = modifierRows
    .filter((r) => itemById.has(r.itemId))
    .map((r) => ({
      modifierItemId: r.modifierItemId,
      itemId: r.itemId,
      quantityPerUnit: r.quantityPerUnit.toNumber(),
      wastagePercent: r.wastagePercent.toNumber(),
    }));

  const costs = Object.fromEntries(items.map((i) => [i.id, i.unitCostPence]));
  const { deductions, lineCosts } = computeDeductions(sold, recipeLines, costs, modifierLines);
  if (deductions.length === 0) return NOTHING;

  await tx.stockLedgerEntry.createMany({
    data: deductions.map((d) => ({
      outletId: order.outletId,
      itemId: d.itemId,
      change: new Prisma.Decimal(-d.quantity),
      reason: 'SALE' as const,
      referenceId: orderId,
      unitCostPence: d.unitCostPence,
      ...(at ? { createdAt: at } : {}),
    })),
  });

  await Promise.all(
    lineCosts
      .filter((c) => c.recipeCostPence !== null)
      .map((c) => tx.orderItem.update({ where: { id: c.orderItemId }, data: { recipeCostPence: c.recipeCostPence } })),
  );

  // Which ingredients are now at or below their reorder level because of this bill?
  const balances = await tx.stockLedgerEntry.groupBy({
    by: ['itemId'],
    where: { itemId: { in: deductions.map((d) => d.itemId) } },
    _sum: { change: true },
  });
  const after = new Map(balances.map((b) => [b.itemId, b._sum.change?.toNumber() ?? 0]));
  const lowStock: LowStockHit[] = [];
  for (const d of deductions) {
    const item = itemById.get(d.itemId)!;
    const stock = after.get(d.itemId) ?? 0;
    const threshold = item.reorderThreshold.toNumber();
    // Only items this bill pushed across the line, so a long-low item doesn't alert on every sale
    if (stock <= threshold && stock + d.quantity > threshold) {
      lowStock.push({ itemId: item.id, itemName: item.name, unit: item.unit, stock: Math.round(stock * 10000) / 10000, threshold });
    }
  }
  return { deducted: deductions.length, lowStock };
}
