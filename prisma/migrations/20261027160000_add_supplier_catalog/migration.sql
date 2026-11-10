-- AlterTable
ALTER TABLE "Supplier" ALTER COLUMN "outletId" DROP NOT NULL,
ADD COLUMN "gstNumber" TEXT,
ADD COLUMN "rating" DECIMAL(3,2) DEFAULT 5.0,
ADD COLUMN "deliveryTerms" TEXT;

-- CreateIndex
CREATE INDEX "Supplier_category_idx" ON "Supplier"("category");

-- CreateTable
CREATE TABLE "SupplierItem" (
    "id" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "category" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "pricePaise" INTEGER NOT NULL,
    "minOrderQty" DECIMAL(12,4) NOT NULL DEFAULT 1,
    "inStock" BOOLEAN NOT NULL DEFAULT true,
    "qualityGrade" TEXT,
    "leadTimeHours" INTEGER NOT NULL DEFAULT 24,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SupplierItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierItem_supplierId_idx" ON "SupplierItem"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierItem_category_idx" ON "SupplierItem"("category");

-- CreateIndex
CREATE INDEX "SupplierItem_name_idx" ON "SupplierItem"("name");

-- AddForeignKey
ALTER TABLE "SupplierItem" ADD CONSTRAINT "SupplierItem_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
