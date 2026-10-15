import { prisma } from "./prisma.js";

export interface AuditInput {
  tenantId: string;
  actorType: "STAFF" | "CLIENT" | "SYSTEM";
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  method: string;
  route: string;
  resourceId?: string | null;
  statusCode: number;
  ipAddress?: string | null;
}

// Writes one audit row. A failure is logged and swallowed: the audit trail must
// never stop a payment or a sign-in from going through.
export async function recordAudit(input: AuditInput, log?: { error: (...a: unknown[]) => void }): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: input.actorType,
        action: input.action.slice(0, 160),
        method: input.method,
        route: input.route.slice(0, 200),
        statusCode: input.statusCode,
        ...(input.actorId ? { actorId: input.actorId.slice(0, 120) } : {}),
        ...(input.actorName ? { actorName: input.actorName.slice(0, 120) } : {}),
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        ...(input.ipAddress ? { ipAddress: input.ipAddress.slice(0, 64) } : {}),
      },
    });
  } catch (err) {
    (log ?? console).error({ err }, "Could not write the audit trail");
  }
}
