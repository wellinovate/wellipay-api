import { toMinorNumber } from "./money.js";
import { refundSummary, type RefundLike } from "./payLinks.js";

export interface ChargeRow {
  id: string;
  invoiceId: string;
  reference: string;
  amountMinor: bigint;
  status: string;
  source: string;
  payerPatientRef: string | null;
  failureReason: string | null;
  paymentId: string | null;
  createdAt: Date;
}

export interface InvoiceInfo {
  providerInvoiceRef: string;
  description: string;
  patientRef: string;
  providerName: string;
  lines?: { description: string; quantity: number; unitPriceMinor: number }[] | undefined;
}

// One row of the patient's transaction history: a payment attempt, whatever
// its outcome, with the receipt details a patient needs.
export function transactionView(charge: ChargeRow, invoice: InvoiceInfo, paidAt: Date | null, refunds: RefundLike[], patientRef: string) {
  const { refundStatus, refundedMinor } = refundSummary(refunds);
  return {
    transactionId: charge.id,
    reference: charge.reference,
    processor: "paystack",
    invoiceId: charge.invoiceId,
    providerName: invoice.providerName,
    invoiceRef: invoice.providerInvoiceRef,
    description: invoice.description,
    amountMinor: toMinorNumber(charge.amountMinor),
    currency: "NGN",
    status: charge.status,
    source: charge.source,
    paidByMe: charge.payerPatientRef === patientRef,
    paidAt: paidAt?.toISOString(),
    createdAt: charge.createdAt.toISOString(),
    failureReason: charge.failureReason ?? undefined,
    refundStatus,
    refundedMinor: toMinorNumber(refundedMinor),
    lines: invoice.lines && invoice.lines.length > 0 ? invoice.lines : undefined,
  };
}
