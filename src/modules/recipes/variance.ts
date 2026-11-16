/**
 * Theoretical vs actual usage of one stock item (pure, no database).
 *
 * Actual use between two stock counts = first count + purchases/adjustments in between − second count.
 * Theoretical use = what recipe-based sales took out + logged waste in the same stretch.
 * The gap is what went missing (over-portioning, unlogged waste, theft, wrong recipe) when positive,
 * or what the recipes over-count when negative.
 */
import { ONE_DAY_MS } from '../../utils/outletTime';
import { LedgerMove, withBalances } from '../analytics/runOut';

export interface ItemVariance {
  /** The two counts the figures are measured between */
  from: Date;
  to: Date;
  actualUsed: number;
  soldTheoretical: number;
  wasteLogged: number;
  /** actualUsed − (sold + waste). Positive = more went than the books explain */
  variance: number;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * @param moves        the item's moves from the start of the period up to now, oldest first
 * @param currentStock the item's ledger balance now
 * @param until        end of the period; counts after it are ignored
 */
export function itemVariance(moves: LedgerMove[], currentStock: number, until: Date): ItemVariance | null {
  const rows = withBalances(moves, currentStock);
  const counts = rows.filter((r) => r.reason === 'COUNT' && r.createdAt <= until);
  const first = counts[0];
  const last = counts[counts.length - 1];
  if (!first || !last || last.createdAt.getTime() - first.createdAt.getTime() < ONE_DAY_MS) return null;

  const between = rows.filter((r) => r.createdAt > first.createdAt && r.createdAt <= last.createdAt);
  const sum = (reason: LedgerMove['reason'][]) => between.filter((r) => reason.includes(r.reason)).reduce((s, r) => s + r.change, 0);

  const actualUsed = first.balanceAfter + sum(['PURCHASE', 'ADJUSTMENT']) - last.balanceAfter;
  const soldTheoretical = -sum(['SALE']);
  const wasteLogged = -sum(['WASTE']);
  return {
    from: first.createdAt,
    to: last.createdAt,
    actualUsed: round4(actualUsed),
    soldTheoretical: round4(soldTheoretical),
    wasteLogged: round4(wasteLogged),
    variance: round4(actualUsed - soldTheoretical - wasteLogged),
  };
}
