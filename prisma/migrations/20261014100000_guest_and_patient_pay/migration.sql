-- AlterTable
ALTER TABLE "invoices" ADD COLUMN "payToken" TEXT;

-- AlterTable
ALTER TABLE "paystack_charges" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'PROVIDER',
ADD COLUMN "payerPatientRef" TEXT,
ADD COLUMN "payerPhone" TEXT,
ADD COLUMN "claimCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "invoices_payToken_key" ON "invoices"("payToken");

-- CreateIndex
CREATE UNIQUE INDEX "paystack_charges_claimCode_key" ON "paystack_charges"("claimCode");

-- CreateIndex
CREATE INDEX "paystack_charges_tenantId_payerPatientRef_idx" ON "paystack_charges"("tenantId", "payerPatientRef");
