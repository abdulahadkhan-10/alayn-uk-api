-- Replace India's CGST/SGST/GSTIN model with UK VAT (VAT is included in menu prices).

-- Outlet
ALTER TABLE "Outlet"
  ADD COLUMN "vatRateDecimal" DECIMAL(5,2) NOT NULL DEFAULT 20.0,
  ADD COLUMN "vatRegistered" BOOLEAN NOT NULL DEFAULT true;

UPDATE "Outlet" SET "vatRegistered" = ("gstRegistrationType" = 'REGULAR');

ALTER TABLE "Outlet" RENAME COLUMN "gstin" TO "vatNumber";
ALTER TABLE "Outlet"
  DROP COLUMN "cgstRateDecimal",
  DROP COLUMN "sgstRateDecimal",
  DROP COLUMN "gstRegistrationType";

DROP TYPE "GstRegistrationType";

-- Supplier
ALTER TABLE "Supplier" RENAME COLUMN "gstNumber" TO "vatNumber";

-- Order: carry the tax already charged on existing bills into the VAT columns
ALTER TABLE "Order"
  ADD COLUMN "vatPaise" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "vatRate" DECIMAL(5,2);

UPDATE "Order" SET
  "vatPaise" = "cgstPaise" + "sgstPaise",
  "vatRate" = CASE WHEN "cgstRate" IS NULL AND "sgstRate" IS NULL THEN NULL
                   ELSE COALESCE("cgstRate", 0) + COALESCE("sgstRate", 0) END;

ALTER TABLE "Order"
  DROP COLUMN "cgstPaise",
  DROP COLUMN "sgstPaise",
  DROP COLUMN "cgstRate",
  DROP COLUMN "sgstRate";

-- Subscription VAT default
ALTER TABLE "OutletSubscription" ALTER COLUMN "taxRatePercent" SET DEFAULT 20.0;
