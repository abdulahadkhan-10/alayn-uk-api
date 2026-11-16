-- Recipe-linked inventory (additive; every new column is nullable or defaulted)

-- Recipe: per-outlet ingredient lines with wastage
ALTER TABLE "Recipe" ADD COLUMN "outletId" UUID;
ALTER TABLE "Recipe" ADD COLUMN "wastagePercent" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "Recipe" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Recipe" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Any existing line belongs to its ingredient's outlet
UPDATE "Recipe" r SET "outletId" = i."outletId" FROM "Item" i WHERE i."id" = r."itemId";

ALTER TABLE "Recipe" ALTER COLUMN "outletId" SET NOT NULL;
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Recipe_outletId_menuItemId_idx" ON "Recipe"("outletId", "menuItemId");

-- Cost snapshot on stock movements, and a lookup of everything one bill deducted
ALTER TABLE "StockLedgerEntry" ADD COLUMN "unitCostPaise" INTEGER;
CREATE INDEX "StockLedgerEntry_referenceId_idx" ON "StockLedgerEntry"("referenceId");

-- Bill-level marker and per-line ingredient cost
ALTER TABLE "Order" ADD COLUMN "stockDeductedAt" TIMESTAMP(3);
ALTER TABLE "OrderItem" ADD COLUMN "recipeCostPaise" INTEGER;
