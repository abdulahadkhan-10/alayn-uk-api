-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN "freeDurationDays" INTEGER;

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "outletId" UUID,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CouponRedemption_businessId_idx" ON "CouponRedemption"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_couponId_businessId_key" ON "CouponRedemption"("couponId", "businessId");

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill 1: business-level coupon subscriptions (planId COUPON_*) stop unlocking outlets.
-- Businesses that hold one without any outlet on that coupon plan (e.g. FIRST25 at registration)
-- get it moved onto their oldest outlet that is not already paid, for the same remaining period.
INSERT INTO "OutletSubscription" (
    "id", "outletId", "businessId", "status", "planCode", "planName", "monthlyFeePaise",
    "taxRatePercent", "currency", "currentPeriodStart", "currentPeriodEnd", "autoRenew",
    "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid(), o."id", s."businessId", 'ACTIVE', s."planId",
    substr(s."planId", 8) || ' VIP Promo Access', 0, 0, 'INR', s."currentPeriodStart",
    s."currentPeriodEnd", false, now(), now()
FROM "Subscription" s
JOIN LATERAL (
    SELECT ot."id"
    FROM "Outlet" ot
    WHERE ot."businessId" = s."businessId"
      AND ot."deletedAt" IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM "OutletSubscription" paid
          WHERE paid."outletId" = ot."id"
            AND paid."status" = 'ACTIVE'
            AND paid."currentPeriodEnd" > now()
      )
    ORDER BY ot."createdAt" ASC
    LIMIT 1
) o ON true
WHERE s."status" = 'ACTIVE'
  AND s."planId" LIKE 'COUPON\_%'
  AND s."currentPeriodEnd" > now()
  AND NOT EXISTS (
      SELECT 1 FROM "OutletSubscription" os
      WHERE os."businessId" = s."businessId" AND os."planCode" = s."planId"
  )
ON CONFLICT ("outletId") DO UPDATE SET
    "status" = EXCLUDED."status",
    "planCode" = EXCLUDED."planCode",
    "planName" = EXCLUDED."planName",
    "monthlyFeePaise" = 0,
    "taxRatePercent" = 0,
    "currentPeriodStart" = EXCLUDED."currentPeriodStart",
    "currentPeriodEnd" = EXCLUDED."currentPeriodEnd",
    "autoRenew" = false,
    "updatedAt" = now();

-- Backfill 2: record past free redemptions (earliest outlet per business per coupon), so a business
-- that already used a coupon cannot redeem it again.
INSERT INTO "CouponRedemption" ("id", "couponId", "businessId", "outletId", "redeemedAt")
SELECT DISTINCT ON (c."id", os."businessId")
    gen_random_uuid(), c."id", os."businessId", os."outletId", os."createdAt"
FROM "OutletSubscription" os
JOIN "Coupon" c ON os."planCode" = 'COUPON_' || c."code"
ORDER BY c."id", os."businessId", os."createdAt" ASC
ON CONFLICT ("couponId", "businessId") DO NOTHING;
