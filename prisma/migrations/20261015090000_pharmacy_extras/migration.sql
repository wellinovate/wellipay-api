-- Order readiness, courier and tracking
ALTER TABLE "pharmacy_orders"
  ADD COLUMN "readyAt" TIMESTAMP(3),
  ADD COLUMN "readyBy" TEXT,
  ADD COLUMN "courierId" TEXT,
  ADD COLUMN "trackingRef" TEXT,
  ADD COLUMN "trackingUrl" TEXT;

CREATE TYPE "CourierKind" AS ENUM ('OWN_RIDER', 'PARTNER');
CREATE TYPE "NoticeStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');
CREATE TYPE "RegisterKind" AS ENUM ('RECEIPT', 'DISPENSE', 'ADJUSTMENT', 'WRITE_OFF');

CREATE TABLE "prescription_images" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "prescriptionId" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "data" BYTEA NOT NULL,
  "uploadedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prescription_images_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "prescription_images_prescriptionId_idx" ON "prescription_images"("prescriptionId");
ALTER TABLE "prescription_images" ADD CONSTRAINT "prescription_images_prescriptionId_fkey"
  FOREIGN KEY ("prescriptionId") REFERENCES "prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "couriers" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "CourierKind" NOT NULL DEFAULT 'OWN_RIDER',
  "phone" TEXT,
  "trackingUrlTemplate" TEXT,
  "webhookSecret" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "couriers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "couriers_tenantId_active_idx" ON "couriers"("tenantId", "active");

CREATE TABLE "pharmacy_notices" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "phone" TEXT,
  "status" "NoticeStatus" NOT NULL,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_notices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pharmacy_notices_orderId_idx" ON "pharmacy_notices"("orderId");

CREATE TABLE "controlled_register_entries" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "batchNo" TEXT NOT NULL,
  "kind" "RegisterKind" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "patientRef" TEXT,
  "patientName" TEXT,
  "prescriptionId" TEXT,
  "prescriberName" TEXT,
  "prescriberLicenceNo" TEXT,
  "recipientName" TEXT,
  "recipientId" TEXT,
  "supplierName" TEXT,
  "orderId" TEXT,
  "reason" TEXT,
  "note" TEXT,
  "actor" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "controlled_register_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "controlled_register_entries_tenantId_productId_createdAt_idx" ON "controlled_register_entries"("tenantId", "productId", "createdAt");
CREATE INDEX "controlled_register_entries_tenantId_createdAt_idx" ON "controlled_register_entries"("tenantId", "createdAt");

-- The register is a legal record. Entries are never changed or removed.
CREATE FUNCTION controlled_register_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The controlled-drug register cannot be changed or deleted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER controlled_register_no_update
  BEFORE UPDATE OR DELETE ON "controlled_register_entries"
  FOR EACH ROW EXECUTE FUNCTION controlled_register_is_append_only();
