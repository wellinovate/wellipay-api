-- CreateEnum
CREATE TYPE "PreAuthStatus" AS ENUM ('APPROVED', 'IN_REVIEW', 'DECLINED');

-- CreateTable
CREATE TABLE "pre_authorizations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "hmoPolicyId" TEXT NOT NULL,
    "facilityRef" TEXT NOT NULL,
    "procedure" TEXT NOT NULL,
    "estimatedCostMinor" BIGINT NOT NULL,
    "coveredAmountMinor" BIGINT NOT NULL,
    "patientPortionMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "PreAuthStatus" NOT NULL DEFAULT 'APPROVED',
    "approvalCode" TEXT,
    "notes" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pre_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pre_authorizations_tenantId_patientRef_idx" ON "pre_authorizations"("tenantId", "patientRef");

-- AddForeignKey
ALTER TABLE "pre_authorizations" ADD CONSTRAINT "pre_authorizations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_authorizations" ADD CONSTRAINT "pre_authorizations_hmoPolicyId_fkey" FOREIGN KEY ("hmoPolicyId") REFERENCES "hmo_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
