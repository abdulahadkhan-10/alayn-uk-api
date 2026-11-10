import { Prisma } from '@prisma/client';

/**
 * Race-free running numbers for human-readable document numbers (order numbers, PO numbers).
 *
 * Each series (e.g. "ORD-SEA20261102", "PO-SEA-20261102") is one row in "DocumentCounter".
 * Taking a number is a single UPDATE/INSERT ... RETURNING on that row, which Postgres row-locks
 * until the caller's transaction ends:
 *   - two requests in the same series at the same instant queue for milliseconds and get
 *     consecutive numbers, never the same one;
 *   - if the caller's transaction rolls back, the number is released, so a series has no gaps;
 *   - different series (other prefix or day) never wait on each other.
 * Always call it with the transaction client that also saves the document.
 */

/** "Sea Breeze Café" -> "SEA": letters only, first three, upper-case, padded with X. */
export function documentPrefix(name: string | null | undefined): string {
  return (name || 'ALAYN').replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X');
}

/**
 * Next number in `series`. `seed` is called only the first time a series is used, to return the
 * highest number already taken by documents created before the counter existed (default 0).
 */
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  series: string,
  seed?: () => Promise<number>
): Promise<number> {
  const bumped = await tx.$queryRaw<{ value: number }[]>`
    UPDATE "DocumentCounter" SET "value" = "value" + 1 WHERE "key" = ${series} RETURNING "value"
  `;
  if (bumped.length) return Number(bumped[0].value);

  // First number in this series. If another request creates the row at the same moment,
  // ON CONFLICT waits for it and continues from its value instead of reusing the seed.
  const start = (seed ? await seed() : 0) + 1;
  const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "DocumentCounter" ("key", "value") VALUES (${series}, ${start})
    ON CONFLICT ("key") DO UPDATE SET "value" = "DocumentCounter"."value" + 1
    RETURNING "value"
  `;
  return Number(value);
}

/** Prefix for an outlet's documents: its name, else its business name, else "ALAYN". */
export async function outletDocumentPrefix(tx: Prisma.TransactionClient, outletId: string): Promise<string> {
  const outlet = await tx.outlet.findUnique({
    where: { id: outletId },
    select: { name: true, business: { select: { name: true } } },
  });
  return documentPrefix(outlet?.name || outlet?.business?.name);
}

/**
 * Transaction options for anything that takes a document number. The counter row stays locked until
 * the transaction commits, so during a rush requests in one series queue; let them wait up to 10 s
 * for a connection instead of Prisma's 2 s default.
 */
export const DOCUMENT_NUMBER_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;
