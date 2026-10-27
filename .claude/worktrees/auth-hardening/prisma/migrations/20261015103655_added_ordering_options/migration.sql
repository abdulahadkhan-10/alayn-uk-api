-- CreateEnum
CREATE TYPE "TableOrderMode" AS ENUM ('WAITER_SERVICE', 'ORDER_AND_PAY');

-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "allowPayAtCounter" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "tableOrderMode" "TableOrderMode" NOT NULL DEFAULT 'WAITER_SERVICE';
