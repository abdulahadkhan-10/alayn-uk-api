-- Cashfree collects in rupees while plan prices are in pounds: keep what Cashfree was asked to collect
ALTER TABLE "SubscriptionPayment" ADD COLUMN "chargedAmount" DECIMAL(12,2);
ALTER TABLE "SubscriptionPayment" ADD COLUMN "chargedCurrency" TEXT;
