-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('MEDICINE', 'CONSUMABLE', 'DEVICE');

-- CreateEnum
CREATE TYPE "DispensingClass" AS ENUM ('OTC', 'PRESCRIPTION_ONLY', 'CONTROLLED');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('ACTIVE', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "StockMovementKind" AS ENUM ('RECEIPT', 'DISPENSE', 'ADJUSTMENT', 'WRITE_OFF');

-- AlterTable
ALTER TABLE "service_items" ADD COLUMN "productId" TEXT;

-- AlterTable
ALTER TABLE "staff" ADD COLUMN "pharmacistLicenceNo" TEXT;

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_products" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "category" "ProductCategory" NOT NULL,
    "genericName" TEXT NOT NULL,
    "brandName" TEXT,
    "strength" TEXT,
    "dosageForm" TEXT,
    "packSize" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'pack',
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "nafdacNumber" TEXT,
    "manufacturer" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "dispensingClass" "DispensingClass" NOT NULL DEFAULT 'OTC',
    "reorderLevel" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pharmacy_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_batches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierId" TEXT,
    "batchNo" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "quantityReceived" INTEGER NOT NULL,
    "quantityOnHand" INTEGER NOT NULL,
    "costMinor" INTEGER,
    "status" "BatchStatus" NOT NULL DEFAULT 'ACTIVE',
    "quarantineReason" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedBy" TEXT,

    CONSTRAINT "stock_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "kind" "StockMovementKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT,
    "note" TEXT,
    "reference" TEXT,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_items_productId_key" ON "service_items"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenantId_name_key" ON "suppliers"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_products_tenantId_sku_key" ON "pharmacy_products"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "pharmacy_products_tenantId_category_active_idx" ON "pharmacy_products"("tenantId", "category", "active");

-- CreateIndex
CREATE UNIQUE INDEX "stock_batches_productId_batchNo_expiryDate_key" ON "stock_batches"("productId", "batchNo", "expiryDate");

-- CreateIndex
CREATE INDEX "stock_batches_tenantId_productId_expiryDate_idx" ON "stock_batches"("tenantId", "productId", "expiryDate");

-- CreateIndex
CREATE INDEX "stock_movements_tenantId_productId_createdAt_idx" ON "stock_movements"("tenantId", "productId", "createdAt");

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_productId_fkey" FOREIGN KEY ("productId") REFERENCES "pharmacy_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "pharmacy_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "stock_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
