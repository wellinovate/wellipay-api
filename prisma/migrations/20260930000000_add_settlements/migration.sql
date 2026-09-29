-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'SETTLED');

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "facilityRef" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "settlementId" TEXT;

-- CreateIndex
CREATE INDEX "settlements_tenantId_facilityRef_status_idx" ON "settlements"("tenantId", "facilityRef", "status");

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
