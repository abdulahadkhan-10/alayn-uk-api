-- One-time key per "Create PO" attempt, so a double-click or a network retry can't create the PO twice.
ALTER TABLE "PurchaseOrder" ADD COLUMN "clientRequestId" TEXT;

CREATE UNIQUE INDEX "PurchaseOrder_clientRequestId_key" ON "PurchaseOrder"("clientRequestId");
