-- Links between a patient's WelliPay profile and a health-record identifier.
-- A link is a reference with a verification. It never grants access to records.
CREATE TYPE "RecordConnectionKind" AS ENUM ('WELLIRECORD', 'EXTERNAL_SYSTEM', 'PROVIDER_PATIENT_NUMBER');
CREATE TYPE "RecordConnectionStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'REVOKED', 'EXPIRED');
CREATE TYPE "RecordIntegrationStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- Partner systems Wellinovate has approved. The partner's API key is not stored here.
CREATE TABLE "record_integrations" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "RecordConnectionKind" NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "status" "RecordIntegrationStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "record_integrations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "record_integrations_key_key" ON "record_integrations"("key");

CREATE TABLE "record_connections" (
  "id" TEXT NOT NULL,
  "patientAccountId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "kind" "RecordConnectionKind" NOT NULL,
  "integrationKey" TEXT,
  -- Which namespace the reference belongs to: "integration:<key>" or "tenant:<tenantId>".
  "scopeKey" TEXT NOT NULL,
  "externalRef" TEXT NOT NULL,
  "status" "RecordConnectionStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  "requestId" TEXT NOT NULL,
  "codeAttempts" INTEGER NOT NULL DEFAULT 0,
  "codeExpiresAt" TIMESTAMP(3),
  "decidedBy" TEXT,
  "decisionNote" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "record_connections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "record_connections_requestId_key" ON "record_connections"("requestId");
CREATE INDEX "record_connections_patientAccountId_idx" ON "record_connections"("patientAccountId");
CREATE INDEX "record_connections_tenantId_kind_status_idx" ON "record_connections"("tenantId", "kind", "status");

-- A verified reference can belong to one WelliPay account only. Another account
-- can claim it again only after the first link is revoked.
CREATE UNIQUE INDEX "record_connections_one_verified_owner"
  ON "record_connections"("scopeKey", "externalRef") WHERE "status" = 'VERIFIED';

-- History of every change. Entries are never changed or removed.
CREATE TABLE "record_connection_events" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "record_connection_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "record_connection_events_connectionId_createdAt_idx" ON "record_connection_events"("connectionId", "createdAt");

CREATE FUNCTION record_connection_events_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The record connection history cannot be changed or deleted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER record_connection_events_no_update
  BEFORE UPDATE OR DELETE ON "record_connection_events"
  FOR EACH ROW EXECUTE FUNCTION record_connection_events_are_append_only();
