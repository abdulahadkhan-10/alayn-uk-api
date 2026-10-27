-- Look up a UPI UTR / card approval code quickly when checking it was not used on another bill
CREATE INDEX IF NOT EXISTS "Payment_reference_idx" ON "Payment"("reference");
