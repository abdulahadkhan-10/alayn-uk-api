-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "couponCode" TEXT,
ADD COLUMN     "couponId" UUID;

-- CreateTable
CREATE TABLE "RestaurantCoupon" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "outletId" UUID,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discountType" "DiscountType" NOT NULL DEFAULT 'PERCENTAGE',
    "discountValue" DECIMAL(10,2) NOT NULL,
    "minOrderPaise" INTEGER,
    "maxDiscountPaise" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "usageLimit" INTEGER,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantCoupon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RestaurantCoupon_businessId_isActive_idx" ON "RestaurantCoupon"("businessId", "isActive");

-- CreateIndex
CREATE INDEX "RestaurantCoupon_outletId_idx" ON "RestaurantCoupon"("outletId");

-- CreateIndex
CREATE INDEX "RestaurantCoupon_code_idx" ON "RestaurantCoupon"("code");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantCoupon_businessId_code_key" ON "RestaurantCoupon"("businessId", "code");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "RestaurantCoupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantCoupon" ADD CONSTRAINT "RestaurantCoupon_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantCoupon" ADD CONSTRAINT "RestaurantCoupon_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantCoupon" ADD CONSTRAINT "RestaurantCoupon_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
