-- Rename money columns from Indian units (paise) to UK units (pence). Amounts are unchanged:
-- they were always stored in hundredths of a pound; only the names said "paise".

ALTER TABLE "OutletSubscription" RENAME COLUMN "monthlyFeePaise" TO "monthlyFeePence";
ALTER TABLE "SubscriptionPayment" RENAME COLUMN "amountPaise" TO "amountPence";
ALTER TABLE "SubscriptionPayment" RENAME COLUMN "taxAmountPaise" TO "taxAmountPence";
ALTER TABLE "SubscriptionPayment" RENAME COLUMN "discountAmountPaise" TO "discountAmountPence";
ALTER TABLE "Item" RENAME COLUMN "unitCostPaise" TO "unitCostPence";
ALTER TABLE "StockBatch" RENAME COLUMN "unitCostPaise" TO "unitCostPence";
ALTER TABLE "StockLedgerEntry" RENAME COLUMN "unitCostPaise" TO "unitCostPence";
ALTER TABLE "SupplierItem" RENAME COLUMN "pricePaise" TO "pricePence";
ALTER TABLE "PurchaseOrder" RENAME COLUMN "totalAmountPaise" TO "totalAmountPence";
ALTER TABLE "PurchaseOrderItem" RENAME COLUMN "unitCostPaise" TO "unitCostPence";
ALTER TABLE "MenuItem" RENAME COLUMN "pricePaise" TO "pricePence";
ALTER TABLE "Order" RENAME COLUMN "subtotalPaise" TO "subtotalPence";
ALTER TABLE "Order" RENAME COLUMN "vatPaise" TO "vatPence";
ALTER TABLE "Order" RENAME COLUMN "serviceTaxPaise" TO "serviceTaxPence";
ALTER TABLE "Order" RENAME COLUMN "taxPaise" TO "taxPence";
ALTER TABLE "Order" RENAME COLUMN "totalPaise" TO "totalPence";
ALTER TABLE "Order" RENAME COLUMN "discountPaise" TO "discountPence";
ALTER TABLE "Order" RENAME COLUMN "roundOffPaise" TO "roundOffPence";
ALTER TABLE "OrderItem" RENAME COLUMN "unitPricePaise" TO "unitPricePence";
ALTER TABLE "OrderItem" RENAME COLUMN "subtotalPaise" TO "subtotalPence";
ALTER TABLE "OrderItem" RENAME COLUMN "recipeCostPaise" TO "recipeCostPence";
ALTER TABLE "OrderItemRemoval" RENAME COLUMN "amountPaise" TO "amountPence";
ALTER TABLE "Payment" RENAME COLUMN "amountPaise" TO "amountPence";
ALTER TABLE "WasteLog" RENAME COLUMN "unitCostAtLoggingPaise" TO "unitCostAtLoggingPence";
ALTER TABLE "WasteLog" RENAME COLUMN "costAtLoggingPaise" TO "costAtLoggingPence";
ALTER TABLE "DailySalesSummary" RENAME COLUMN "grossSalesPaise" TO "grossSalesPence";
ALTER TABLE "DailySalesSummary" RENAME COLUMN "cogsPaise" TO "cogsPence";
ALTER TABLE "DailySalesSummary" RENAME COLUMN "grossProfitPaise" TO "grossProfitPence";
ALTER TABLE "RestaurantCoupon" RENAME COLUMN "minOrderPaise" TO "minOrderPence";
ALTER TABLE "RestaurantCoupon" RENAME COLUMN "maxDiscountPaise" TO "maxDiscountPence";
ALTER TABLE "ModifierItem" RENAME COLUMN "pricePaise" TO "pricePence";

-- Money keys saved inside JSON text
UPDATE "OrderItem" SET "modifiersJson" = replace("modifiersJson", 'Paise"', 'Pence"')
  WHERE "modifiersJson" LIKE '%Paise"%';
UPDATE "Notification" SET "metadata" = replace("metadata"::text, 'Paise"', 'Pence"')::jsonb
  WHERE "metadata"::text LIKE '%Paise"%';

-- Leftover column from an old build (previously dropped at app startup)
ALTER TABLE "Payment" DROP COLUMN IF EXISTS "platformDiscountPaise";
