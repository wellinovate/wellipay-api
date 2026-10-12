-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('HOSPITAL', 'DIAGNOSTIC_LAB', 'PHARMACY', 'INDEPENDENT_PRACTITIONER');

-- CreateEnum
CREATE TYPE "ProviderApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "providerType" "ProviderType",
ADD COLUMN "paystackSubaccountCode" TEXT,
ADD COLUMN "settlementBankCode" TEXT,
ADD COLUMN "settlementAccountNumber" TEXT,
ADD COLUMN "settlementAccountName" TEXT;

-- CreateTable
CREATE TABLE "provider_applications" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "providerType" "ProviderType" NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "address" TEXT,
    "licenseNumber" TEXT,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "status" "ProviderApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "provider_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_applications_status_createdAt_idx" ON "provider_applications"("status", "createdAt");
