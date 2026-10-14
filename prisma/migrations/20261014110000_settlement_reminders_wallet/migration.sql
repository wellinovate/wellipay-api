-- CreateEnum
CREATE TYPE "WalletEntryKind" AS ENUM ('TOPUP', 'INVOICE_PAYMENT');

-- AlterTable
ALTER TABLE "paystack_charges" ADD COLUMN "feesMinor" BIGINT,
ADD COLUMN "settlementStatus" TEXT NOT NULL DEFAULT 'AWAITING',
ADD COLUMN "gatewaySettlementId" TEXT,
ADD COLUMN "settledAt" TIMESTAMP(3),
ADD COLUMN "saveCard" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "savedMethodId" TEXT;

-- CreateTable
CREATE TABLE "patient_reminders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "remindAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_payment_methods" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "authorizationCode" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "brand" TEXT,
    "last4" TEXT NOT NULL,
    "expMonth" TEXT,
    "expYear" TEXT,
    "bank" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "balanceMinor" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "kind" "WalletEntryKind" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "reference" TEXT NOT NULL,
    "invoiceId" TEXT,
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_top_ups" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "PaystackChargeStatus" NOT NULL DEFAULT 'PENDING',
    "authorizationUrl" TEXT,
    "failureReason" TEXT,
    "feesMinor" BIGINT,
    "settlementStatus" TEXT NOT NULL DEFAULT 'AWAITING',
    "gatewaySettlementId" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_top_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "paystack_charges_tenantId_status_settlementStatus_idx" ON "paystack_charges"("tenantId", "status", "settlementStatus");

-- CreateIndex
CREATE UNIQUE INDEX "patient_reminders_tenantId_patientRef_invoiceId_key" ON "patient_reminders"("tenantId", "patientRef", "invoiceId");

-- CreateIndex
CREATE INDEX "patient_reminders_remindAt_sentAt_idx" ON "patient_reminders"("remindAt", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "saved_payment_methods_tenantId_patientRef_signature_key" ON "saved_payment_methods"("tenantId", "patientRef", "signature");

-- CreateIndex
CREATE INDEX "saved_payment_methods_tenantId_patientRef_idx" ON "saved_payment_methods"("tenantId", "patientRef");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_accounts_tenantId_patientRef_key" ON "wallet_accounts"("tenantId", "patientRef");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_entries_kind_reference_key" ON "wallet_entries"("kind", "reference");

-- CreateIndex
CREATE INDEX "wallet_entries_tenantId_patientRef_createdAt_idx" ON "wallet_entries"("tenantId", "patientRef", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_top_ups_reference_key" ON "wallet_top_ups"("reference");

-- CreateIndex
CREATE INDEX "wallet_top_ups_tenantId_patientRef_createdAt_idx" ON "wallet_top_ups"("tenantId", "patientRef", "createdAt");
