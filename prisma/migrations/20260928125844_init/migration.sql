-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MobileDeliveryStatus" AS ENUM ('QUEUED', 'DELIVERED', 'NOT_LINKED', 'FAILED');

-- CreateEnum
CREATE TYPE "FundingRequestStatus" AS ENUM ('OPEN', 'PARTIALLY_FUNDED', 'FUNDED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ContributionStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "EligibilityStatus" AS ENUM ('PENDING', 'COMPLETE');

-- CreateEnum
CREATE TYPE "EligibilityDecision" AS ENUM ('ELIGIBLE', 'PARTIALLY_ELIGIBLE', 'INELIGIBLE', 'PENDING');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('RECORDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PayerType" AS ENUM ('PATIENT', 'HMO', 'INSURANCE', 'FAMILY', 'FINANCING', 'CORPORATE');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'DELIVERED', 'DEAD_LETTERED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_credentials" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "api_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerInvoiceRef" TEXT NOT NULL,
    "facilityRef" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "paidAmountMinor" BIGINT NOT NULL DEFAULT 0,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "mobileDeliveryStatus" "MobileDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "dueAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_funding_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerRequestRef" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "facilityRef" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "FundingRequestStatus" NOT NULL DEFAULT 'OPEN',
    "fundedAmountMinor" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "family_funding_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_contributions" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "sponsorRef" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "ContributionStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eligibility_checks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerRequestRef" TEXT NOT NULL,
    "facilityRef" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "payerRef" TEXT NOT NULL,
    "serviceCodes" TEXT[],
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT,
    "currency" TEXT,
    "status" "EligibilityStatus" NOT NULL DEFAULT 'PENDING',
    "decision" "EligibilityDecision" NOT NULL DEFAULT 'PENDING',
    "reasonCode" TEXT,
    "coveredAmountMinor" BIGINT,
    "patientResponsibilityMinor" BIGINT,
    "validUntil" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eligibility_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_consents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerConsentRef" TEXT NOT NULL,
    "facilityRef" TEXT NOT NULL,
    "patientRef" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "estimateRevision" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "actorRef" TEXT,
    "status" "ConsentStatus" NOT NULL DEFAULT 'RECORDED',
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "financial_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_payer_splits" (
    "id" TEXT NOT NULL,
    "consentId" TEXT NOT NULL,
    "payerType" "PayerType" NOT NULL,
    "payerRef" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',

    CONSTRAINT "consent_payer_splits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "resourceRef" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_credentials_clientId_key" ON "api_credentials"("clientId");

-- CreateIndex
CREATE INDEX "invoices_tenantId_facilityRef_idx" ON "invoices"("tenantId", "facilityRef");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenantId_providerInvoiceRef_key" ON "invoices"("tenantId", "providerInvoiceRef");

-- CreateIndex
CREATE UNIQUE INDEX "family_funding_requests_tenantId_providerRequestRef_key" ON "family_funding_requests"("tenantId", "providerRequestRef");

-- CreateIndex
CREATE UNIQUE INDEX "eligibility_checks_tenantId_providerRequestRef_key" ON "eligibility_checks"("tenantId", "providerRequestRef");

-- CreateIndex
CREATE UNIQUE INDEX "financial_consents_tenantId_providerConsentRef_key" ON "financial_consents"("tenantId", "providerConsentRef");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_tenantId_route_key_key" ON "idempotency_records"("tenantId", "route", "key");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_eventId_key" ON "outbox_events"("eventId");

-- CreateIndex
CREATE INDEX "outbox_events_status_nextAttemptAt_idx" ON "outbox_events"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_funding_requests" ADD CONSTRAINT "family_funding_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_funding_requests" ADD CONSTRAINT "family_funding_requests_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_contributions" ADD CONSTRAINT "funding_contributions_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "family_funding_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_consents" ADD CONSTRAINT "financial_consents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_consents" ADD CONSTRAINT "financial_consents_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_payer_splits" ADD CONSTRAINT "consent_payer_splits_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "financial_consents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
