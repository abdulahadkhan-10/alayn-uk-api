-- Switch purchase order numbers from a global integer (PO-1042) to the restaurant-order style:
--   PO-<3-letter outlet prefix>-<YYYYMMDD in India time>-<running number for that prefix and day>
--   e.g. PO-SEA-20261102-001
--
-- Numbers come from "DocumentCounter", one row per prefix+day, incremented atomically by the app.
-- Existing orders are renumbered here and the counters seeded so new orders continue after them.
-- The prefix rule matches the app: outlet name, else business name, else "ALAYN"; letters only,
-- first three, upper-case, padded with X.

BEGIN;

LOCK TABLE "PurchaseOrder" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE "DocumentCounter" (
    "key"   TEXT    NOT NULL,
    "value" INTEGER NOT NULL,
    CONSTRAINT "DocumentCounter_pkey" PRIMARY KEY ("key")
);

CREATE TEMP TABLE po_renumber ON COMMIT DROP AS
WITH keyed AS (
  SELECT
    po."id",
    po."createdAt",
    'PO-'
      || rpad(upper(left(regexp_replace(COALESCE(NULLIF(o."name", ''), NULLIF(b."name", ''), 'ALAYN'), '[^a-zA-Z]', '', 'g'), 3)), 3, 'X')
      || '-'
      || to_char(po."createdAt" + INTERVAL '330 minutes', 'YYYYMMDD') AS "key"
  FROM "PurchaseOrder" po
  LEFT JOIN "Outlet" o ON o."id" = po."outletId"
  LEFT JOIN "Business" b ON b."id" = o."businessId"
)
SELECT "id", "key", ROW_NUMBER() OVER (PARTITION BY "key" ORDER BY "createdAt", "id") AS n
FROM keyed;

ALTER TABLE "PurchaseOrder" ADD COLUMN "poCode" TEXT;

UPDATE "PurchaseOrder" p
SET "poCode" = r."key" || '-' || CASE WHEN r.n < 1000 THEN lpad(r.n::text, 3, '0') ELSE r.n::text END
FROM po_renumber r
WHERE p."id" = r."id";

INSERT INTO "DocumentCounter" ("key", "value")
SELECT "key", MAX(n) FROM po_renumber GROUP BY "key";

-- Replace the integer column (its sequence and unique index go with it)
ALTER TABLE "PurchaseOrder" DROP COLUMN "poNumber";
ALTER TABLE "PurchaseOrder" RENAME COLUMN "poCode" TO "poNumber";
ALTER TABLE "PurchaseOrder" ALTER COLUMN "poNumber" SET NOT NULL;
CREATE UNIQUE INDEX "PurchaseOrder_poNumber_key" ON "PurchaseOrder"("poNumber");

COMMIT;
