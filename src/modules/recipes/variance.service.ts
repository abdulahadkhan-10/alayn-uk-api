import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { ONE_DAY_MS } from '../../utils/outletTime';
import { isAllOutlets } from '../../utils/tenantScope';
import { LedgerMove } from '../analytics/runOut';
import { itemVariance } from './variance';

export const DEFAULT_VARIANCE_DAYS = 30;
export const MAX_VARIANCE_DAYS = 90;

function parseDate(value: string | undefined, fallback: Date, label: string): Date {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new AppError('INVALID_DATE', `"${label}" is not a valid date.`, 400);
  return d;
}

export class VarianceService {
  /**
   * Theoretical vs actual usage per ingredient at one branch. Only items counted at least twice (a day or
   * more apart) in the period can be measured; the rest are reported as a count so the screen can say so.
   */
  async getVariance(outletId: string | undefined, input: { from?: string; to?: string }, now: Date = new Date()) {
    if (isAllOutlets(outletId)) {
      throw new AppError('OUTLET_REQUIRED', 'Please choose the branch whose usage you want to see.', 400);
    }
    const outlet = outletId as string;

    const to = parseDate(input.to, now, 'to');
    const from = parseDate(input.from, new Date(to.getTime() - DEFAULT_VARIANCE_DAYS * ONE_DAY_MS), 'from');
    if (from >= to) throw new AppError('INVALID_PERIOD', 'The start date must be before the end date.', 400);
    if (to.getTime() - from.getTime() > MAX_VARIANCE_DAYS * ONE_DAY_MS) {
      throw new AppError('PERIOD_TOO_LONG', `Please choose a period of ${MAX_VARIANCE_DAYS} days or less.`, 400);
    }

    const [items, balances, rows, recipeRows, modifierRecipeRows] = await Promise.all([
      prisma.item.findMany({
        where: { outletId: outlet, deletedAt: null },
        select: { id: true, name: true, unit: true, unitCostPaise: true },
      }),
      prisma.stockLedgerEntry.groupBy({ by: ['itemId'], where: { outletId: outlet }, _sum: { change: true } }),
      // Everything since the start of the period, to now: balances are worked back from today's stock
      prisma.stockLedgerEntry.findMany({
        where: { outletId: outlet, createdAt: { gte: from } },
        select: { itemId: true, outletId: true, change: true, reason: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.recipe.findMany({ where: { outletId: outlet }, select: { itemId: true }, distinct: ['itemId'] }),
      prisma.modifierRecipe.findMany({ where: { outletId: outlet }, select: { itemId: true }, distinct: ['itemId'] }),
    ]);

    const stockNow = new Map(balances.map((b) => [b.itemId, b._sum.change?.toNumber() ?? 0]));
    const inRecipes = new Set([...recipeRows, ...modifierRecipeRows].map((r) => r.itemId));
    const movesByItem = new Map<string, LedgerMove[]>();
    for (const r of rows) {
      const list = movesByItem.get(r.itemId) ?? [];
      list.push({ ...r, change: r.change.toNumber() });
      movesByItem.set(r.itemId, list);
    }

    const measured = [];
    let notMeasured = 0;
    for (const item of items) {
      const v = itemVariance(movesByItem.get(item.id) ?? [], stockNow.get(item.id) ?? 0, to);
      if (!v) {
        notMeasured++;
        continue;
      }
      measured.push({
        itemId: item.id,
        name: item.name,
        unit: item.unit,
        unitCostPaise: item.unitCostPaise,
        // False for an ingredient no recipe uses: all its use shows as "unexplained", which says nothing about loss
        inRecipes: inRecipes.has(item.id),
        measuredFrom: v.from,
        measuredTo: v.to,
        actualUsed: v.actualUsed,
        soldTheoretical: v.soldTheoretical,
        wasteLogged: v.wasteLogged,
        variance: v.variance,
        variancePaise: Math.round(v.variance * item.unitCostPaise),
      });
    }
    measured.sort((a, b) => Math.abs(b.variancePaise) - Math.abs(a.variancePaise));

    const comparable = measured.filter((m) => m.inRecipes);
    return {
      outletId: outlet,
      from,
      to,
      items: measured,
      notMeasured,
      totalVariancePaise: comparable.reduce((s, m) => s + m.variancePaise, 0),
      totalLossPaise: comparable.filter((m) => m.variancePaise > 0).reduce((s, m) => s + m.variancePaise, 0),
    };
  }
}
