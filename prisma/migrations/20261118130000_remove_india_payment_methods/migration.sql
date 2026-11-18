-- Remove India-only payment methods (UPI, Swiggy, Zomato, EazyDiner) from the UK product.
-- Stops instead of rewriting history if any saved payment still uses one of them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Payment" WHERE "method"::text IN ('UPI', 'SWIGGY', 'ZOMATO', 'EAZYDINER')) THEN
    RAISE EXCEPTION 'Payments recorded as UPI / SWIGGY / ZOMATO / EAZYDINER exist. Decide what to convert them to (or delete them) before running this migration.';
  END IF;
END $$;

ALTER TYPE "PaymentMethod" RENAME TO "PaymentMethod_old";
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'CASH', 'DELIVEROO', 'UBER_EATS', 'JUST_EAT');
ALTER TABLE "Payment" ALTER COLUMN "method" TYPE "PaymentMethod" USING ("method"::text::"PaymentMethod");
DROP TYPE "PaymentMethod_old";
