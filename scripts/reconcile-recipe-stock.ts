/**
 * Back-fills recipe stock deduction for bills settled before recipes existed.
 *
 *   npx ts-node scripts/reconcile-recipe-stock.ts --outlet <outlet-uuid> --from 2026-10-01          (preview only)
 *   npx ts-node scripts/reconcile-recipe-stock.ts --outlet <outlet-uuid> --from 2026-10-01 --apply  (writes)
 *
 * Runs against whichever DATABASE_URL is in your .env: check it is the database you mean before using --apply.
 * Bills older than the branch's latest stock count are skipped (that count already reflects them).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { reconcileOutlet } from '../src/modules/recipes/reconcile';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const outletId = arg('outlet');
  const fromText = arg('from');
  const apply = process.argv.includes('--apply');
  if (!outletId || !fromText) {
    console.error('Usage: reconcile-recipe-stock.ts --outlet <outlet-uuid> --from <YYYY-MM-DD> [--apply]');
    process.exit(1);
  }
  const from = new Date(fromText);
  if (Number.isNaN(from.getTime())) {
    console.error(`"${fromText}" is not a valid date.`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const r = await reconcileOutlet(prisma, { outletId, from, apply });
    if (r.clampedToLastCount) {
      console.log(`Note: starting from the latest stock count (${r.effectiveFrom.toISOString()}), not ${from.toISOString()}.`);
    }
    console.log(`Settled bills not yet deducted: ${r.billsFound}`);
    if (!apply) {
      console.log('Preview only. Nothing was written. Add --apply to deduct stock for these bills.');
    } else {
      console.log(`Bills that deducted stock: ${r.billsDeducted} (${r.ingredientMovements} ingredient movements)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
