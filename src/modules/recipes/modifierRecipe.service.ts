import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { isAllOutlets } from '../../utils/tenantScope';
import { EmployeeActor, assertOutletsAccessible } from '../employees/employee.permissions';
import { lineCostPaise, summarizeRecipeCost } from './recipeCost';
import { SaveModifierRecipeInput } from './recipe.schema';

/** Recipes of add-ons / options ("Extra cheese"): taken out of stock on top of the dish's own recipe when sold. */
export class ModifierRecipeService {
  private requireOutlet(outletId: string | undefined): string {
    if (isAllOutlets(outletId)) {
      throw new AppError('OUTLET_REQUIRED', 'Please choose the branch whose recipe you want.', 400);
    }
    return outletId as string;
  }

  /** The option must belong to a group of the caller's business, and to that branch (or be shared by every branch). */
  private async findModifier(outletId: string, modifierItemId: string, businessId?: string | null) {
    if (!businessId) throw new AppError('FORBIDDEN', 'Your account is not linked to a business.', 403);
    const modifier = await prisma.modifierItem.findFirst({
      where: {
        id: modifierItemId,
        group: { businessId, deletedAt: null, OR: [{ outletId: null }, { outletId }] },
      },
      select: { id: true, name: true, pricePaise: true },
    });
    if (!modifier) throw new AppError('MODIFIER_NOT_FOUND', 'Add-on not found', 404);
    return modifier;
  }

  async getRecipe(outletId: string | undefined, modifierItemId: string, businessId?: string | null) {
    const outlet = this.requireOutlet(outletId);
    const modifier = await this.findModifier(outlet, modifierItemId, businessId);
    const rows = await prisma.modifierRecipe.findMany({
      where: { modifierItemId, outletId: outlet, item: { deletedAt: null } },
      include: { item: { select: { id: true, name: true, sku: true, unit: true, unitCostPaise: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const lines = rows.map((r) => {
      const quantity = r.quantityPerUnit.toNumber();
      const wastagePercent = r.wastagePercent.toNumber();
      return {
        itemId: r.item.id,
        name: r.item.name,
        sku: r.item.sku,
        unit: r.item.unit,
        unitCostPaise: r.item.unitCostPaise,
        quantity,
        wastagePercent,
        lineCostPaise: lineCostPaise({ quantityPerUnit: quantity, wastagePercent, unitCostPaise: r.item.unitCostPaise }),
      };
    });
    const summary = summarizeRecipeCost(
      lines.map((l) => ({ quantityPerUnit: l.quantity, wastagePercent: l.wastagePercent, unitCostPaise: l.unitCostPaise })),
      modifier.pricePaise,
    );
    return { modifierItemId: modifier.id, modifierName: modifier.name, outletId: outlet, hasRecipe: lines.length > 0, lines, ...summary };
  }

  async saveRecipe(outletId: string | undefined, modifierItemId: string, input: SaveModifierRecipeInput, actor: EmployeeActor) {
    const outlet = this.requireOutlet(outletId);
    await assertOutletsAccessible(actor, [outlet]);
    await this.findModifier(outlet, modifierItemId, actor.businessId);

    const ingredients = await prisma.item.findMany({
      where: { id: { in: input.lines.map((l) => l.itemId) }, outletId: outlet, deletedAt: null },
      select: { id: true },
    });
    if (ingredients.length !== input.lines.length) {
      throw new AppError('INGREDIENT_NOT_FOUND', "Some ingredients were not found in this branch's stock.", 400);
    }

    await prisma.$transaction(async (tx) => {
      await tx.modifierRecipe.deleteMany({ where: { modifierItemId, outletId: outlet } });
      if (input.lines.length === 0) return;
      await tx.modifierRecipe.createMany({
        data: input.lines.map((l) => ({
          modifierItemId,
          outletId: outlet,
          itemId: l.itemId,
          quantityPerUnit: new Prisma.Decimal(l.quantity),
          wastagePercent: new Prisma.Decimal(l.wastagePercent),
        })),
      });
    });
    return this.getRecipe(outlet, modifierItemId, actor.businessId);
  }

  async deleteRecipe(outletId: string | undefined, modifierItemId: string, actor: EmployeeActor) {
    const outlet = this.requireOutlet(outletId);
    await assertOutletsAccessible(actor, [outlet]);
    await this.findModifier(outlet, modifierItemId, actor.businessId);
    await prisma.modifierRecipe.deleteMany({ where: { modifierItemId, outletId: outlet } });
    return { modifierItemId, outletId: outlet, hasRecipe: false };
  }
}
