-- Saved audit trail: who did what, and when, on a provider's account.
-- One row per successful write by staff or an integration. Bodies are never stored.
CREATE TABLE "audit_events" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT,
  "actorName" TEXT,
  "action" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "resourceId" TEXT,
  "statusCode" INTEGER NOT NULL,
  "ipAddress" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_events_tenantId_createdAt_idx" ON "audit_events"("tenantId", "createdAt" DESC, "id" DESC);

-- Entries are never changed or removed.
CREATE FUNCTION audit_events_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The audit trail cannot be changed or deleted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_are_append_only();
