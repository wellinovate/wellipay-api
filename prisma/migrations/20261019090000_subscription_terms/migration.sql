-- Commercial terms per provider. Nullable: nothing is assumed for existing tenants.
ALTER TABLE "tenants" ADD COLUMN "planName" TEXT;
ALTER TABLE "tenants" ADD COLUMN "planMonthlyFeeMinor" BIGINT;
ALTER TABLE "tenants" ADD COLUMN "platformFeePercent" DECIMAL(5,2);
ALTER TABLE "tenants" ADD COLUMN "planStartedAt" TIMESTAMP(3);
