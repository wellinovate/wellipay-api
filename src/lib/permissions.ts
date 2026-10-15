// Per-role permissions for staff tokens (tokens issued by POST /staff/login).
//
// Server-to-server tokens (OAuth client credentials, no staff identity) are
// not affected: they keep the scope-only behaviour.
//
// Staff are default-deny: a /provider route with no rule below is ADMIN-only.
// tests/permissions.test.ts fails if a route exists without a rule, so a new
// route has to be given a decision here.

export const STAFF_ACCESS_LEVELS = ["ADMIN", "FINANCE", "BILLING", "CASHIER", "VIEWER"] as const;
export type StaffAccessLevel = (typeof STAFF_ACCESS_LEVELS)[number];

export const ACCESS_LEVEL_LABELS: Record<StaffAccessLevel, string> = {
  ADMIN: "Admin",
  FINANCE: "Finance",
  BILLING: "Billing",
  CASHIER: "Cashier",
  VIEWER: "Viewer",
};

export function isStaffAccessLevel(value: unknown): value is StaffAccessLevel {
  return typeof value === "string" && (STAFF_ACCESS_LEVELS as readonly string[]).includes(value);
}

type Levels = readonly StaffAccessLevel[];

const EVERYONE: Levels = ["ADMIN", "FINANCE", "BILLING", "CASHIER", "VIEWER"];
const FINANCE_VIEW: Levels = ["ADMIN", "FINANCE", "BILLING", "VIEWER"]; // not cashiers
const FRONT_DESK: Levels = ["ADMIN", "FINANCE", "BILLING", "CASHIER"]; // can record day-to-day activity
const BILLING_WORK: Levels = ["ADMIN", "FINANCE", "BILLING"];
const FINANCE_ONLY: Levels = ["ADMIN", "FINANCE"];
const ADMIN_ONLY: Levels = ["ADMIN"];

// [method, Fastify route pattern, levels allowed]
export const ROUTE_RULES: ReadonlyArray<readonly [string, string, Levels]> = [
  ["GET", "/provider/claims", EVERYONE],
  ["POST", "/provider/claims", BILLING_WORK],
  ["PATCH", "/provider/claims/:claimId/status", BILLING_WORK],
  ["GET", "/provider/claims/reconciliation", FINANCE_VIEW],

  ["GET", "/provider/eligibility-checks", EVERYONE],
  ["POST", "/provider/eligibility-checks", FRONT_DESK],

  ["GET", "/provider/episodes", EVERYONE],
  ["GET", "/provider/events", EVERYONE],

  ["GET", "/provider/family-funding-requests", EVERYONE],
  ["POST", "/provider/family-funding-requests", FRONT_DESK],

  ["GET", "/provider/financial-consents", EVERYONE],
  ["POST", "/provider/financial-consents", FRONT_DESK],

  ["GET", "/provider/financing-records", EVERYONE],
  ["POST", "/provider/financing-records", BILLING_WORK],

  ["GET", "/provider/hmo-policies", EVERYONE],
  ["POST", "/provider/hmo-policies", BILLING_WORK],
  ["PATCH", "/provider/hmo-policies/:id", BILLING_WORK],

  ["GET", "/provider/invoices", EVERYONE],
  ["POST", "/provider/invoices", FRONT_DESK],
  ["GET", "/provider/invoices/:invoiceId", EVERYONE],

  ["GET", "/provider/partners", EVERYONE],
  ["POST", "/provider/partners", FINANCE_ONLY],

  ["GET", "/provider/patients", EVERYONE],
  ["GET", "/provider/patient-records", EVERYONE],
  ["POST", "/provider/patient-records", FRONT_DESK],

  ["GET", "/provider/bookings", EVERYONE],
  ["POST", "/provider/bookings", FRONT_DESK],
  ["PATCH", "/provider/bookings/:id", FRONT_DESK],
  ["GET", "/provider/sms-status", EVERYONE],
  ["POST", "/provider/bookings/:id/reminder", FRONT_DESK],
  ["GET", "/provider/bookings/:id/results", EVERYONE],
  ["POST", "/provider/bookings/:id/results", FRONT_DESK],
  ["PATCH", "/provider/booking-results/:resultId", FRONT_DESK],

  ["GET", "/provider/corporate-accounts", EVERYONE],
  ["POST", "/provider/corporate-accounts", BILLING_WORK],
  ["PATCH", "/provider/corporate-accounts/:id", BILLING_WORK],
  ["GET", "/provider/corporate-accounts/:id/statement", EVERYONE],

  ["POST", "/provider/invoices/:id/pay-link", FRONT_DESK],

  ["GET", "/provider/service-items", EVERYONE],
  ["POST", "/provider/service-items", BILLING_WORK],
  ["PATCH", "/provider/service-items/:id", BILLING_WORK],

  ["GET", "/provider/catalogue/diagnostic-tests", EVERYONE],
  ["POST", "/provider/catalogue/diagnostic-tests/offers", BILLING_WORK],
  ["GET", "/provider/checkup-packages", EVERYONE],
  ["POST", "/provider/checkup-packages", BILLING_WORK],
  ["PATCH", "/provider/checkup-packages/:id", BILLING_WORK],

  ["GET", "/provider/payment-plans", EVERYONE],
  ["POST", "/provider/payment-plans", BILLING_WORK],
  ["POST", "/provider/payment-plans/:id/installments/:seq/pay", FRONT_DESK],

  ["GET", "/provider/paystack/charges/:reference", EVERYONE],
  ["POST", "/provider/paystack/charges", FRONT_DESK],
  ["GET", "/provider/paystack/settlements", FINANCE_VIEW],

  // Pharmacy. Anyone can look. Changing the catalogue or stock is billing work and above.
  ["GET", "/provider/pharmacy/products", EVERYONE],
  ["GET", "/provider/pharmacy/products/:id", EVERYONE],
  ["POST", "/provider/pharmacy/products", BILLING_WORK],
  ["PATCH", "/provider/pharmacy/products/:id", BILLING_WORK],
  ["GET", "/provider/pharmacy/services", EVERYONE],
  ["POST", "/provider/pharmacy/services/offers", BILLING_WORK],
  ["GET", "/provider/pharmacy/suppliers", EVERYONE],
  ["POST", "/provider/pharmacy/suppliers", BILLING_WORK],
  ["PATCH", "/provider/pharmacy/suppliers/:id", BILLING_WORK],
  ["POST", "/provider/pharmacy/stock/receipts", BILLING_WORK],
  ["POST", "/provider/pharmacy/stock/adjustments", BILLING_WORK],
  ["POST", "/provider/pharmacy/stock/write-offs", BILLING_WORK],
  ["POST", "/provider/pharmacy/batches/:id/quarantine", BILLING_WORK],
  ["GET", "/provider/pharmacy/stock/movements", EVERYONE],
  ["GET", "/provider/pharmacy/inventory/alerts", EVERYONE],
  ["GET", "/provider/prescriptions", EVERYONE],
  ["POST", "/provider/prescriptions", FRONT_DESK],
  ["PATCH", "/provider/prescriptions/:id/verify", FRONT_DESK], // the route itself requires a registered pharmacist
  ["PATCH", "/provider/staff/:id/pharmacist", ADMIN_ONLY],
  ["GET", "/provider/pharmacy/orders", EVERYONE],
  ["GET", "/provider/pharmacy/orders/:id", EVERYONE],
  ["POST", "/provider/pharmacy/orders", FRONT_DESK],
  ["POST", "/provider/pharmacy/orders/:id/dispense", FRONT_DESK], // pharmacist check and payment gate are in the route
  ["POST", "/provider/pharmacy/orders/:id/cancel", BILLING_WORK],
  ["PATCH", "/provider/pharmacy/orders/:id/delivery", FRONT_DESK],
  ["POST", "/provider/pharmacy/orders/:id/ready", FRONT_DESK],
  ["GET", "/provider/pharmacy/controlled-register", EVERYONE],
  ["GET", "/provider/pharmacy/controlled-register/balances", EVERYONE],
  ["GET", "/provider/pharmacy/couriers", EVERYONE],
  ["POST", "/provider/pharmacy/couriers", BILLING_WORK],
  ["PATCH", "/provider/pharmacy/couriers/:id", BILLING_WORK],
  ["POST", "/provider/pharmacy/couriers/:id/rotate-secret", BILLING_WORK],
  ["POST", "/provider/prescriptions/:id/images", FRONT_DESK],
  ["GET", "/provider/prescriptions/:id/images/:imageId", EVERYONE],

  ["GET", "/provider/payments", EVERYONE],
  ["POST", "/provider/payments", FRONT_DESK],

  ["GET", "/provider/pre-authorizations", EVERYONE],
  ["PATCH", "/provider/pre-authorizations/:id", BILLING_WORK],

  // Patient number reviews and link revocation. The review compares a name and
  // phone with the facility's own records, so it is Billing work and above.
  ["GET", "/provider/record-connections", FRONT_DESK],
  ["PATCH", "/provider/record-connections/:id/decision", BILLING_WORK],
  ["POST", "/provider/record-connections/:id/revoke", BILLING_WORK],

  ["GET", "/provider/referrals", EVERYONE],
  ["POST", "/provider/referrals", FRONT_DESK],
  ["PATCH", "/provider/referrals/:id/status", FRONT_DESK],

  // Anyone at the desk can ask for a refund; only Finance and Admin decide.
  ["GET", "/provider/refunds", EVERYONE],
  ["POST", "/provider/refunds", FRONT_DESK],
  ["PATCH", "/provider/refunds/:refundId/decision", FINANCE_ONLY],
  ["POST", "/provider/refunds/:refundId/gateway-status", FRONT_DESK],

  ["GET", "/provider/payments/settlement", FINANCE_VIEW],
  ["POST", "/provider/payments/settlement/sync", FINANCE_ONLY],
  ["GET", "/provider/wallet-summary", FINANCE_VIEW],

  ["GET", "/provider/settlements", FINANCE_VIEW],
  ["POST", "/provider/settlements", FINANCE_ONLY],
  ["PATCH", "/provider/settlements/:id/confirm", FINANCE_ONLY],

  ["GET", "/provider/unmatched-transactions", FINANCE_VIEW],
  ["POST", "/provider/unmatched-transactions", FINANCE_ONLY],
  ["POST", "/provider/unmatched-transactions/:id/match", FINANCE_ONLY],
  ["POST", "/provider/unmatched-transactions/:id/exception", FINANCE_ONLY],

  // Account: Finance can read the settlement account and refund limit. Only Admin changes the limit.
  ["GET", "/provider/account", FINANCE_ONLY],
  ["PATCH", "/provider/account/refund-limit", ADMIN_ONLY],
  ["GET", "/provider/integrations/status", ADMIN_ONLY],

  // Staff directory and webhooks: Admin only.
  ["GET", "/provider/staff", ADMIN_ONLY],
  ["POST", "/provider/staff", ADMIN_ONLY],
  ["PATCH", "/provider/staff/:id/status", ADMIN_ONLY],
  ["PATCH", "/provider/staff/:id/password", ADMIN_ONLY],
  ["PATCH", "/provider/staff/:id/access-level", ADMIN_ONLY],
  ["GET", "/provider/webhook-endpoints", ADMIN_ONLY],
  ["POST", "/provider/webhook-endpoints", ADMIN_ONLY],
  ["DELETE", "/provider/webhook-endpoints/:id", ADMIN_ONLY],
];

const ruleIndex = new Map<string, Levels>(ROUTE_RULES.map(([m, p, l]) => [`${m} ${p}`, l]));

export function allowedLevels(method: string, pattern: string): Levels {
  return ruleIndex.get(`${method.toUpperCase()} ${pattern}`) ?? ADMIN_ONLY;
}

export function levelCanCall(level: StaffAccessLevel, method: string, pattern: string): boolean {
  if (level === "ADMIN") return true;
  return allowedLevels(method, pattern).includes(level);
}
