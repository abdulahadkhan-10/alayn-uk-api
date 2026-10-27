-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "cancelledQuantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledFromStatus" "OrderStatus";
