-- CreateEnum
CREATE TYPE "PrescriptionStatus" AS ENUM ('SUBMITTED', 'VERIFIED', 'REJECTED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "PrescriptionSource" AS ENUM ('PATIENT', 'STAFF');

-- CreateEnum
CREATE TYPE "PharmacyOrderStatus" AS ENUM ('AWAITING_DISPENSING', 'DISPENSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Fulfilment" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "prescriptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "source" "PrescriptionSource" NOT NULL,
    "prescriberName" TEXT,
    "prescriberLicenceNo" TEXT,
    "issuedOn" TIMESTAMP(3),
    "notes" TEXT,
    "status" "PrescriptionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "validUntil" TIMESTAMP(3),
    "refillsAllowed" INTEGER NOT NULL DEFAULT 0,
    "refillOfId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_items" (
    "id" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "directions" TEXT,
    "productId" TEXT,

    CONSTRAINT "prescription_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_orders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "prescriptionId" TEXT,
    "status" "PharmacyOrderStatus" NOT NULL DEFAULT 'AWAITING_DISPENSING',
    "fulfilment" "Fulfilment" NOT NULL DEFAULT 'PICKUP',
    "deliveryAddress" TEXT,
    "deliveryPhone" TEXT,
    "deliveryFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "courierName" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "deliveredToName" TEXT,
    "proofCode" TEXT,
    "deliveryNote" TEXT,
    "failureReason" TEXT,
    "dispensedBy" TEXT,
    "dispensedAt" TIMESTAMP(3),
    "handedToName" TEXT,
    "paymentOverrideReason" TEXT,
    "cancelReason" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pharmacy_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_order_lines" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "dispensed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pharmacy_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispense_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "dispensedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispense_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prescriptions_tenantId_status_createdAt_idx" ON "prescriptions"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "prescriptions_tenantId_patientRef_createdAt_idx" ON "prescriptions"("tenantId", "patientRef", "createdAt");

-- CreateIndex
CREATE INDEX "prescription_items_prescriptionId_idx" ON "prescription_items"("prescriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_orders_invoiceId_key" ON "pharmacy_orders"("invoiceId");

-- CreateIndex
CREATE INDEX "pharmacy_orders_tenantId_status_createdAt_idx" ON "pharmacy_orders"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "pharmacy_orders_tenantId_patientRef_createdAt_idx" ON "pharmacy_orders"("tenantId", "patientRef", "createdAt");

-- CreateIndex
CREATE INDEX "pharmacy_order_lines_orderId_idx" ON "pharmacy_order_lines"("orderId");

-- CreateIndex
CREATE INDEX "dispense_records_tenantId_batchId_idx" ON "dispense_records"("tenantId", "batchId");

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_order_lines" ADD CONSTRAINT "pharmacy_order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "pharmacy_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_records" ADD CONSTRAINT "dispense_records_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "pharmacy_order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
