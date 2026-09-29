-- CreateEnum
CREATE TYPE "PaymentPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "PaymentPlanInstallmentStatus" AS ENUM ('PENDING', 'PAID');

-- CreateTable
CREATE TABLE "payment_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "installmentCount" INTEGER NOT NULL,
    "status" "PaymentPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_plan_installments" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "PaymentPlanInstallmentStatus" NOT NULL DEFAULT 'PENDING',
    "paidPaymentId" TEXT,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "payment_plan_installments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_plans_tenantId_status_idx" ON "payment_plans"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_plan_installments_planId_seq_key" ON "payment_plan_installments"("planId", "seq");

-- AddForeignKey
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plan_installments" ADD CONSTRAINT "payment_plan_installments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "payment_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plan_installments" ADD CONSTRAINT "payment_plan_installments_paidPaymentId_fkey" FOREIGN KEY ("paidPaymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
