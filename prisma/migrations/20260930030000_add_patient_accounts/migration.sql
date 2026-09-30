-- CreateTable
CREATE TABLE "patient_accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patient_accounts_clerkUserId_key" ON "patient_accounts"("clerkUserId");

-- CreateIndex
CREATE INDEX "patient_accounts_tenantId_patientRef_idx" ON "patient_accounts"("tenantId", "patientRef");

-- AddForeignKey
ALTER TABLE "patient_accounts" ADD CONSTRAINT "patient_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
