-- CreateTable
CREATE TABLE "patient_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "facilityRef" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patient_records_tenantId_patientRef_key" ON "patient_records"("tenantId", "patientRef");

-- CreateIndex
CREATE INDEX "patient_records_tenantId_createdAt_idx" ON "patient_records"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "patient_records" ADD CONSTRAINT "patient_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
