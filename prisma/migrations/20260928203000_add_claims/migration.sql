-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "claims" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerClaimRef" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "facilityRef" TEXT NOT NULL,
    "payerRef" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "approvedAmountMinor" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "ClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "claims_tenantId_providerClaimRef_key" ON "claims"("tenantId", "providerClaimRef");

-- CreateIndex
CREATE INDEX "claims_tenantId_facilityRef_idx" ON "claims"("tenantId", "facilityRef");

-- CreateIndex
CREATE INDEX "claims_tenantId_patientRef_idx" ON "claims"("tenantId", "patientRef");

-- CreateIndex
CREATE INDEX "claims_tenantId_invoiceId_idx" ON "claims"("tenantId", "invoiceId");

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
