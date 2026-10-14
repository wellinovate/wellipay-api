-- CreateEnum
CREATE TYPE "BookingType" AS ENUM ('CENTRE_VISIT', 'HOME_COLLECTION');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('BOOKED', 'SAMPLE_COLLECTED', 'PROCESSING', 'READY', 'CANCELLED');

-- AlterTable
ALTER TABLE "service_items" ADD COLUMN "componentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN "corporateAccountId" TEXT;

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "type" "BookingType" NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "address" TEXT,
    "notes" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'BOOKED',
    "invoiceId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "corporate_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bookings_tenantId_status_scheduledAt_idx" ON "bookings"("tenantId", "status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_accounts_tenantId_name_key" ON "corporate_accounts"("tenantId", "name");

-- CreateIndex
CREATE INDEX "invoices_tenantId_corporateAccountId_idx" ON "invoices"("tenantId", "corporateAccountId");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_accounts" ADD CONSTRAINT "corporate_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
