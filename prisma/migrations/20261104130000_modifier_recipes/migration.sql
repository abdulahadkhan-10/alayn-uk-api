-- Modifier recipes: raw materials used by an add-on / option choice (additive)
CREATE TABLE "ModifierRecipe" (
    "modifierItemId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "quantityPerUnit" DECIMAL(12,4) NOT NULL,
    "wastagePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModifierRecipe_pkey" PRIMARY KEY ("modifierItemId","itemId")
);

CREATE INDEX "ModifierRecipe_outletId_modifierItemId_idx" ON "ModifierRecipe"("outletId", "modifierItemId");

ALTER TABLE "ModifierRecipe" ADD CONSTRAINT "ModifierRecipe_modifierItemId_fkey" FOREIGN KEY ("modifierItemId") REFERENCES "ModifierItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModifierRecipe" ADD CONSTRAINT "ModifierRecipe_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModifierRecipe" ADD CONSTRAINT "ModifierRecipe_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
