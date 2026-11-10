-- Human-readable purchase order numbers (PO-1001, PO-1002, ...).
--
-- Equivalent to Prisma's `Int @unique @default(autoincrement())` (a SERIAL column),
-- but written by hand so existing orders are numbered in the order they were created
-- instead of in arbitrary physical row order, and so numbering starts at 1001.
-- Runs in one transaction; the table lock keeps new orders from slipping in mid-backfill.

BEGIN;

LOCK TABLE "PurchaseOrder" IN ACCESS EXCLUSIVE MODE;

CREATE SEQUENCE "PurchaseOrder_poNumber_seq" AS INTEGER START WITH 1001;

ALTER TABLE "PurchaseOrder" ADD COLUMN "poNumber" INTEGER;

-- Backfill: oldest order gets 1001. Soft-deleted orders are numbered too, so a number is never reused.
WITH numbered AS (
  SELECT "id", 1000 + ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS n
  FROM "PurchaseOrder"
)
UPDATE "PurchaseOrder" p
SET "poNumber" = numbered.n
FROM numbered
WHERE p."id" = numbered."id";

-- Continue the sequence after the highest backfilled number (next value is 1001 on an empty table).
SELECT setval('"PurchaseOrder_poNumber_seq"', COALESCE((SELECT MAX("poNumber") FROM "PurchaseOrder"), 1000), true);

ALTER TABLE "PurchaseOrder"
  ALTER COLUMN "poNumber" SET DEFAULT nextval('"PurchaseOrder_poNumber_seq"'),
  ALTER COLUMN "poNumber" SET NOT NULL;

ALTER SEQUENCE "PurchaseOrder_poNumber_seq" OWNED BY "PurchaseOrder"."poNumber";

CREATE UNIQUE INDEX "PurchaseOrder_poNumber_key" ON "PurchaseOrder"("poNumber");

COMMIT;
