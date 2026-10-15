// What the audit trail records, and how a request is described in words.
// Pure functions, so they run in tests without a database.

// Plain-language label for every write route a provider's staff or integration can call.
// A test fails when a new write route in the permissions table has no label here.
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  "POST /provider/claims": "Submitted a claim",
  "PATCH /provider/claims/:claimId/status": "Changed a claim status",
  "POST /provider/eligibility-checks": "Ran an eligibility check",
  "POST /provider/family-funding-requests": "Created a family funding request",
  "POST /provider/financial-consents": "Recorded a financial consent",
  "POST /provider/financing-records": "Recorded a financing record",
  "POST /provider/hmo-policies": "Added an HMO policy",
  "PATCH /provider/hmo-policies/:id": "Updated an HMO policy",
  "POST /provider/invoices": "Created an invoice",
  "POST /provider/invoices/:id/pay-link": "Created a payment link",
  "POST /provider/partners": "Added a partner",
  "POST /provider/patient-records": "Added a patient",
  "POST /provider/bookings": "Created a booking",
  "PATCH /provider/bookings/:id": "Updated a booking",
  "POST /provider/bookings/:id/reminder": "Sent a booking reminder",
  "POST /provider/bookings/:id/results": "Uploaded test results",
  "PATCH /provider/booking-results/:resultId": "Updated test results",
  "POST /provider/corporate-accounts": "Added a corporate account",
  "PATCH /provider/corporate-accounts/:id": "Updated a corporate account",
  "POST /provider/service-items": "Added a service or price",
  "PATCH /provider/service-items/:id": "Updated a service or price",
  "POST /provider/catalogue/diagnostic-tests/offers": "Offered diagnostic tests",
  "POST /provider/checkup-packages": "Created a check-up package",
  "PATCH /provider/checkup-packages/:id": "Updated a check-up package",
  "POST /provider/payment-plans": "Created a payment plan",
  "POST /provider/payment-plans/:id/installments/:seq/pay": "Recorded an instalment payment",
  "POST /provider/paystack/charges": "Started a card or transfer payment",
  "POST /provider/payments": "Recorded a payment",
  "POST /provider/pharmacy/products": "Added a pharmacy product",
  "PATCH /provider/pharmacy/products/:id": "Updated a pharmacy product",
  "POST /provider/pharmacy/services/offers": "Offered pharmacy services",
  "POST /provider/pharmacy/suppliers": "Added a supplier",
  "PATCH /provider/pharmacy/suppliers/:id": "Updated a supplier",
  "POST /provider/pharmacy/stock/receipts": "Received stock",
  "POST /provider/pharmacy/stock/adjustments": "Adjusted stock",
  "POST /provider/pharmacy/stock/write-offs": "Wrote off stock",
  "POST /provider/pharmacy/batches/:id/quarantine": "Quarantined a stock batch",
  "POST /provider/prescriptions": "Recorded a prescription",
  "PATCH /provider/prescriptions/:id/verify": "Verified a prescription",
  "POST /provider/prescriptions/:id/images": "Attached a prescription photo",
  "PATCH /provider/staff/:id/pharmacist": "Changed a pharmacist registration",
  "POST /provider/pharmacy/orders": "Created a pharmacy order",
  "POST /provider/pharmacy/orders/:id/dispense": "Dispensed an order",
  "POST /provider/pharmacy/orders/:id/cancel": "Cancelled an order",
  "PATCH /provider/pharmacy/orders/:id/delivery": "Updated order delivery",
  "POST /provider/pharmacy/orders/:id/ready": "Marked an order ready",
  "POST /provider/pharmacy/couriers": "Added a courier",
  "PATCH /provider/pharmacy/couriers/:id": "Updated a courier",
  "POST /provider/pharmacy/couriers/:id/rotate-secret": "Rotated a courier secret",
  "PATCH /provider/pre-authorizations/:id": "Updated a pre-authorization",
  "PATCH /provider/record-connections/:id/decision": "Decided a record link",
  "POST /provider/record-connections/:id/revoke": "Removed a record link",
  "POST /provider/referrals": "Created a referral",
  "PATCH /provider/referrals/:id/status": "Changed a referral status",
  "POST /provider/refunds": "Requested a refund",
  "PATCH /provider/refunds/:refundId/decision": "Decided a refund",
  "POST /provider/refunds/:refundId/gateway-status": "Checked a refund with Paystack",
  "POST /provider/payments/settlement/sync": "Synced settlements from Paystack",
  "POST /provider/settlements": "Recorded a settlement",
  "PATCH /provider/settlements/:id/confirm": "Confirmed a settlement",
  "POST /provider/unmatched-transactions": "Recorded an unmatched transaction",
  "POST /provider/unmatched-transactions/:id/match": "Matched a transaction",
  "POST /provider/unmatched-transactions/:id/exception": "Marked a transaction as an exception",
  "PATCH /provider/account/refund-limit": "Changed the refund approval limit",
  "POST /provider/staff": "Added a staff member",
  "PATCH /provider/staff/:id/status": "Changed a staff member's status",
  "PATCH /provider/staff/:id/password": "Reset a staff password",
  "PATCH /provider/staff/:id/access-level": "Changed a staff access level",
  "POST /provider/webhook-endpoints": "Added a webhook endpoint",
  "DELETE /provider/webhook-endpoints/:id": "Removed a webhook endpoint",
};

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// Only successful writes under /provider are recorded.
export function shouldAudit(method: string, pattern: string, statusCode: number): boolean {
  return WRITE_METHODS.has(method) && pattern.startsWith("/provider/") && statusCode >= 200 && statusCode < 300;
}

// A label for a route, or a plain fallback so a new route is still recorded before it gets a label.
export function describeAction(method: string, pattern: string): string {
  const known = ACTION_LABELS[`${method} ${pattern}`];
  if (known) return known;
  const noun = pattern
    .split("/")
    .filter((s) => s && s !== "provider" && !s.startsWith(":"))
    .join(" ")
    .replace(/-/g, " ");
  const verb = method === "POST" ? "Created" : method === "DELETE" ? "Removed" : "Updated";
  return `${verb} ${noun}`.slice(0, 120);
}

// The id of the record acted on: the first route parameter, when there is one.
export function resourceIdFrom(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const first = Object.values(params as Record<string, unknown>)[0];
  return typeof first === "string" && first ? first.slice(0, 120) : null;
}

export function clampLimit(raw: unknown, fallback = 50, max = 200): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

// Cursor is "<ISO time>_<id>": rows strictly older than it, newest first.
export function parseCursor(raw: unknown): { at: Date; id: string } | null {
  if (typeof raw !== "string") return null;
  const i = raw.indexOf("_");
  if (i < 1) return null;
  const at = new Date(raw.slice(0, i));
  const id = raw.slice(i + 1);
  return Number.isNaN(at.getTime()) || !id ? null : { at, id };
}

export function makeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}_${row.id}`;
}
