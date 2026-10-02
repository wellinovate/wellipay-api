-- CreateEnum
CREATE TYPE "HmoPolicyStatus" AS ENUM ('ACTIVE', 'PENDING', 'EXPIRED');

-- CreateTable
CREATE TABLE "hmo_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "policyNo" TEXT NOT NULL,
    "enrolleeName" TEXT NOT NULL,
    "planTier" TEXT NOT NULL,
    "coPayPercent" INTEGER NOT NULL,
    "annualLimitMinor" BIGINT NOT NULL,
    "usedAmountMinor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "HmoPolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hmo_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hmo_policies_tenantId_patientRef_idx" ON "hmo_policies"("tenantId", "patientRef");

-- CreateIndex
CREATE UNIQUE INDEX "hmo_policies_tenantId_patientRef_policyNo_key" ON "hmo_policies"("tenantId", "patientRef", "policyNo");

-- AddForeignKey
ALTER TABLE "hmo_policies" ADD CONSTRAINT "hmo_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
