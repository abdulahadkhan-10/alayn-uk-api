-- Reports read orders by outlet and date, then their items by order
CREATE INDEX IF NOT EXISTS "Order_outletId_createdAt_idx" ON "Order"("outletId", "createdAt");

CREATE INDEX IF NOT EXISTS "OrderItem_orderId_idx" ON "OrderItem"("orderId");
