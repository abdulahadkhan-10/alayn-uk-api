-- CreateTable
CREATE TABLE "OrderItemRemoval" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "itemName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "itemStage" "OrderStatus" NOT NULL,
    "removedById" UUID,
    "removedByName" TEXT NOT NULL,
    "removedByRole" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItemRemoval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderItemRemoval_outletId_createdAt_idx" ON "OrderItemRemoval"("outletId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderItemRemoval_orderId_idx" ON "OrderItemRemoval"("orderId");

-- AddForeignKey
ALTER TABLE "OrderItemRemoval" ADD CONSTRAINT "OrderItemRemoval_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
