-- Split payments: a bill can be settled with several payments (e.g. part cash, part UPI)

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'VOID';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "reference" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "verifiedById" UUID;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "settlementKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Order_settlementKey_key" ON "Order"("settlementKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Payment_orderId_idx" ON "Payment"("orderId");
