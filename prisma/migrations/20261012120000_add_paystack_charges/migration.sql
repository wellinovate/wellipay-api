-- CreateEnum
CREATE TYPE "PaystackChargeStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "paystack_charges" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "PaystackChargeStatus" NOT NULL DEFAULT 'PENDING',
    "authorizationUrl" TEXT,
    "paymentId" TEXT,
    "failureReason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paystack_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "paystack_charges_reference_key" ON "paystack_charges"("reference");

-- CreateIndex
CREATE INDEX "paystack_charges_tenantId_invoiceId_idx" ON "paystack_charges"("tenantId", "invoiceId");
