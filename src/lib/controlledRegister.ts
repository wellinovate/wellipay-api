
// Only the CONTROLLED class goes in the register. Prescription-only medicines do not.
export function isControlledClass(dispensingClass: string): boolean {
  return dispensingClass === "CONTROLLED";
}

// A controlled medicine handed over at the counter needs the collector's ID recorded.
// Deliveries are covered by the proof of delivery.
export function collectorIdProblem(fulfilment: string, hasControlled: boolean, collectorId: string | undefined): string | null {
  if (!hasControlled || fulfilment !== "PICKUP") return null;
  return collectorId && collectorId.trim().length >= 3 ? null : "Record the collector's ID (type and number) for a controlled medicine.";
}

export interface RegisterInput {
  tenantId: string;
  productId: string;
  productName: string;
  batchNo: string;
  kind: "RECEIPT" | "DISPENSE" | "ADJUSTMENT" | "WRITE_OFF";
  // Positive adds stock. Negative removes it.
  quantity: number;
  actor: string;
  patientRef?: string | null;
  patientName?: string | null;
  prescriptionId?: string | null;
  prescriberName?: string | null;
  prescriberLicenceNo?: string | null;
  recipientName?: string | null;
  recipientId?: string | null;
  supplierName?: string | null;
  orderId?: string | null;
  reason?: string | null;
  note?: string | null;
}

interface Tx {
  stockBatch: { aggregate: (a: unknown) => Promise<{ _sum: { quantityOnHand: number | null } }> };
  controlledRegisterEntry: { create: (a: { data: Record<string, unknown> }) => Promise<unknown> };
}

// Adds one entry. Call it inside the same transaction as the stock change, after
// the change, so the balance includes it and the two cannot disagree.
export async function appendRegisterEntry(tx: unknown, input: RegisterInput) {
  const t = tx as Tx;
  const agg = await t.stockBatch.aggregate({ where: { tenantId: input.tenantId, productId: input.productId }, _sum: { quantityOnHand: true } });
  const balanceAfter = agg._sum.quantityOnHand ?? 0;
  const data: Record<string, unknown> = { ...input, balanceAfter };
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  return t.controlledRegisterEntry.create({ data });
}


const CSV_COLUMNS = ["Date", "Medicine", "Batch", "Type", "Quantity", "Balance", "Patient", "Prescriber", "Prescriber licence", "Received by", "Collector ID", "Supplier", "Reason", "Recorded by"] as const;

function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Stop spreadsheet programs from running a cell that starts like a formula.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface RegisterRow {
  createdAt: Date;
  productName: string;
  batchNo: string;
  kind: string;
  quantity: number;
  balanceAfter: number;
  patientName: string | null;
  patientRef: string | null;
  prescriberName: string | null;
  prescriberLicenceNo: string | null;
  recipientName: string | null;
  recipientId: string | null;
  supplierName: string | null;
  reason: string | null;
  actor: string;
}

export function registerCsv(rows: RegisterRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push([
      r.createdAt.toISOString(), r.productName, r.batchNo, r.kind, r.quantity, r.balanceAfter,
      r.patientName ?? r.patientRef, r.prescriberName, r.prescriberLicenceNo, r.recipientName, r.recipientId, r.supplierName, r.reason, r.actor,
    ].map(cell).join(","));
  }
  return lines.join("\n") + "\n";
}
