-- Refund limit above which two different people must approve
ALTER TABLE "tenants" ADD COLUMN "refundApprovalLimitMinor" BIGINT;
ALTER TABLE "refunds"
  ADD COLUMN "firstApprovedBy" TEXT,
  ADD COLUMN "firstApprovedAt" TIMESTAMP(3);
