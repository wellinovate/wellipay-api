-- CreateEnum
CREATE TYPE "CheckupTier" AS ENUM ('CLASSIC', 'EXECUTIVE', 'DIAMOND', 'PLATINUM');

-- CreateEnum
CREATE TYPE "CheckupAudience" AS ENUM ('ALL', 'MALE', 'FEMALE');

-- AlterTable
ALTER TABLE "service_items" ADD COLUMN "serviceCode" TEXT,
ADD COLUMN "masterCode" TEXT,
ADD COLUMN "sampleType" TEXT,
ADD COLUMN "turnaround" TEXT,
ADD COLUMN "preparation" TEXT,
ADD COLUMN "homeCollection" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "digitalResults" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "service_items_tenantId_masterCode_key" ON "service_items"("tenantId", "masterCode");

-- CreateTable
CREATE TABLE "checkup_packages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" "CheckupTier" NOT NULL,
    "audience" "CheckupAudience" NOT NULL DEFAULT 'ALL',
    "priceMinor" INTEGER NOT NULL,
    "includedIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exclusions" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkup_packages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checkup_packages_tenantId_name_key" ON "checkup_packages"("tenantId", "name");

-- CreateIndex
CREATE INDEX "checkup_packages_tenantId_available_idx" ON "checkup_packages"("tenantId", "available");

-- AddForeignKey
ALTER TABLE "checkup_packages" ADD CONSTRAINT "checkup_packages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
