import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { isAllOutlets, menuItemScope } from '../../utils/tenantScope';
import { EmployeeActor, assertOutletsAccessible } from '../employees/employee.permissions';
import { lineCostPence, summarizeRecipeCost } from './recipeCost';
import { SaveRecipeInput } from './recipe.schema';

type LineInput = { itemId: string; quantity: number; wastagePercent: number };

export class RecipeService {
  /** Recipes are per outlet (ingredients are per-outlet stock items), so a specific branch is required. */
  private requireOutlet(outletId: string | undefined): string {
    if (isAllOutlets(outletId)) {
      throw new AppError('OUTLET_REQUIRED', 'Please choose the branch whose recipe you want.', 400);
    }
    return outletId as string;
  }

  private async findMenuItem(outletId: string, menuItemId: string, businessId?: string | null) {
    const menuItem = await prisma.menuItem.findFirst({
      where: { id: menuItemId, deletedAt: null, ...menuItemScope(outletId, businessId) },
      select: { id: true, name: true, pricePence: true },
    });
    if (!menuItem) throw new AppError('MENU_ITEM_NOT_FOUND', 'Menu item not found', 404);
    return menuItem;
  }

  async getRecipe(outletId: string | undefined, menuItemId: string, businessId?: string | null) {
    const outlet = this.requireOutlet(outletId);
    const menuItem = await this.findMenuItem(outlet, menuItemId, businessId);
    const rows = await prisma.recipe.findMany({
      where: { menuItemId, outletId: outlet, item: { deletedAt: null } },
      include: { item: { select: { id: true, name: true, sku: true, unit: true, unitCostPence: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return this.present(menuItem, outlet, rows);
  }

  private present(
    menuItem: { id: string; name: string; pricePence: number },
    outletId: string,
    rows: {
      quantityPerUnit: Prisma.Decimal;
      wastagePercent: Prisma.Decimal;
      item: { id: string; name: string; sku: string; unit: string; unitCostPence: number };
    }[],
  ) {
    const lines = rows.map((r) => {
      const quantity = r.quantityPerUnit.toNumber();
      const wastagePercent = r.wastagePercent.toNumber();
      return {
        itemId: r.item.id,
        name: r.item.name,
        sku: r.item.sku,
        unit: r.item.unit,
        unitCostPence: r.item.unitCostPence,
        quantity,
        wastagePercent,
        lineCostPence: lineCostPence({ quantityPerUnit: quantity, wastagePercent, unitCostPence: r.item.unitCostPence }),
      };
    });
    const summary = summarizeRecipeCost(
      lines.map((l) => ({ quantityPerUnit: l.quantity, wastagePercent: l.wastagePercent, unitCostPence: l.unitCostPence })),
      menuItem.pricePence,
    );
    return { menuItemId: menuItem.id, menuItemName: menuItem.name, outletId, hasRecipe: lines.length > 0, lines, ...summary };
  }

  /** Replaces the dish's recipe at this outlet (an empty list removes it), optionally copying it to other outlets. */
  async saveRecipe(outletId: string | undefined, menuItemId: string, input: SaveRecipeInput, actor: EmployeeActor) {
    const outlet = this.requireOutlet(outletId);
    await assertOutletsAccessible(actor, [outlet]);
    await this.findMenuItem(outlet, menuItemId, actor.businessId);

    const ingredients = await prisma.item.findMany({
      where: { id: { in: input.lines.map((l) => l.itemId) }, outletId: outlet, deletedAt: null },
      select: { id: true, sku: true },
    });
    if (ingredients.length !== input.lines.length) {
      throw new AppError('INGREDIENT_NOT_FOUND', "Some ingredients were not found in this branch's stock.", 400);
    }

    const lines: LineInput[] = input.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, wastagePercent: l.wastagePercent }));
    await prisma.$transaction((tx) => this.replaceLines(tx, menuItemId, outlet, lines));

    const copiedTo = await this.copyToOutlets(menuItemId, lines, ingredients, outlet, input.applyToOutletIds, actor);
    return { ...(await this.getRecipe(outlet, menuItemId, actor.businessId)), copiedTo };
  }

  async deleteRecipe(outletId: string | undefined, menuItemId: string, actor: EmployeeActor) {
    const outlet = this.requireOutlet(outletId);
    await assertOutletsAccessible(actor, [outlet]);
    await this.findMenuItem(outlet, menuItemId, actor.businessId);
    await prisma.recipe.deleteMany({ where: { menuItemId, outletId: outlet } });
    return { menuItemId, outletId: outlet, hasRecipe: false };
  }

  private async replaceLines(tx: Prisma.TransactionClient, menuItemId: string, outletId: string, lines: LineInput[]) {
    await tx.recipe.deleteMany({ where: { menuItemId, outletId } });
    if (lines.length === 0) return;
    await tx.recipe.createMany({
      data: lines.map((l) => ({
        menuItemId,
        outletId,
        itemId: l.itemId,
        quantityPerUnit: new Prisma.Decimal(l.quantity),
        wastagePercent: new Prisma.Decimal(l.wastagePercent),
      })),
    });
  }

  /** Copies the recipe to other outlets of the same business by matching ingredient SKUs. Outlets that can't take it are reported, not failed. */
  private async copyToOutlets(
    menuItemId: string,
    lines: LineInput[],
    sourceIngredients: { id: string; sku: string }[],
    sourceOutletId: string,
    applyToOutletIds: string[],
    actor: EmployeeActor,
  ) {
    const targets = [...new Set(applyToOutletIds)].filter((id) => id !== sourceOutletId);
    if (targets.length === 0) return [];
    await assertOutletsAccessible(actor, targets);

    const skuById = new Map(sourceIngredients.map((i) => [i.id, i.sku]));
    const results: { outletId: string; copied: boolean; reason?: string }[] = [];

    for (const target of targets) {
      const sold = await prisma.menuItem.findFirst({
        where: { id: menuItemId, deletedAt: null, ...menuItemScope(target, actor.businessId) },
        select: { id: true },
      });
      if (!sold) {
        results.push({ outletId: target, copied: false, reason: "This dish is not on that branch's menu." });
        continue;
      }
      const targetItems = await prisma.item.findMany({
        where: { outletId: target, deletedAt: null, sku: { in: [...skuById.values()] } },
        select: { id: true, sku: true },
      });
      const idBySku = new Map(targetItems.map((i) => [i.sku, i.id]));
      const missing = lines.filter((l) => !idBySku.has(skuById.get(l.itemId)!));
      if (missing.length > 0) {
        results.push({ outletId: target, copied: false, reason: `${missing.length} ingredient(s) have no stock item with the same SKU there.` });
        continue;
      }
      const mapped = lines.map((l) => ({ ...l, itemId: idBySku.get(skuById.get(l.itemId)!)! }));
      await prisma.$transaction((tx) => this.replaceLines(tx, menuItemId, target, mapped));
      results.push({ outletId: target, copied: true });
    }
    return results;
  }

  /** Every menu item of the branch with whether it has a recipe, its cost and margin (the "coverage" view). */
  async listCoverage(outletId: string | undefined, businessId?: string | null) {
    const outlet = this.requireOutlet(outletId);
    const [menuItems, rows] = await Promise.all([
      prisma.menuItem.findMany({
        where: { deletedAt: null, ...menuItemScope(outlet, businessId) },
        select: { id: true, name: true, pricePence: true, isActive: true, category: { select: { name: true } } },
        orderBy: { name: 'asc' },
      }),
      prisma.recipe.findMany({
        where: { outletId: outlet, item: { deletedAt: null } },
        select: { menuItemId: true, quantityPerUnit: true, wastagePercent: true, item: { select: { unitCostPence: true } } },
      }),
    ]);

    const byMenuItem = new Map<string, { quantityPerUnit: number; wastagePercent: number; unitCostPence: number }[]>();
    for (const r of rows) {
      const list = byMenuItem.get(r.menuItemId) ?? [];
      list.push({ quantityPerUnit: r.quantityPerUnit.toNumber(), wastagePercent: r.wastagePercent.toNumber(), unitCostPence: r.item.unitCostPence });
      byMenuItem.set(r.menuItemId, list);
    }

    const items = menuItems.map((m) => {
      const lines = byMenuItem.get(m.id);
      return {
        menuItemId: m.id,
        name: m.name,
        category: m.category?.name ?? null,
        isActive: m.isActive,
        hasRecipe: !!lines,
        ingredientCount: lines?.length ?? 0,
        ...(lines
          ? summarizeRecipeCost(lines, m.pricePence)
          : { pricePence: m.pricePence, costPerPortionPence: null, marginPence: null, foodCostPercent: null }),
      };
    });
    const withRecipe = items.filter((i) => i.hasRecipe).length;
    return { outletId: outlet, totalMenuItems: items.length, withRecipe, withoutRecipe: items.length - withRecipe, items };
  }
}
