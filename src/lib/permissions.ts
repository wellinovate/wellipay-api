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
  ["GET", "/provider/bookings/:id/results", EVERYONE],
  ["POST", "/provider/bookings/:id/results", FRONT_DESK],
  ["PATCH", "/provider/booking-results/:resultId", FRONT_DESK],

  ["GET", "/provider/corporate-accounts", EVERYONE],
  ["POST", "/provider/corporate-accounts", BILLING_WORK],
  ["PATCH", "/provider/corporate-accounts/:id", BILLING_WORK],
  ["GET", "/provider/corporate-accounts/:id/statement", EVERYONE],

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

  ["GET", "/provider/payments", EVERYONE],
  ["POST", "/provider/payments", FRONT_DESK],

  ["GET", "/provider/pre-authorizations", EVERYONE],
  ["PATCH", "/provider/pre-authorizations/:id", BILLING_WORK],

  ["GET", "/provider/referrals", EVERYONE],
  ["POST", "/provider/referrals", FRONT_DESK],
  ["PATCH", "/provider/referrals/:id/status", FRONT_DESK],

  // Anyone at the desk can ask for a refund; only Finance and Admin decide.
  ["GET", "/provider/refunds", EVERYONE],
  ["POST", "/provider/refunds", FRONT_DESK],
  ["PATCH", "/provider/refunds/:refundId/decision", FINANCE_ONLY],
  ["POST", "/provider/refunds/:refundId/gateway-status", FRONT_DESK],

  ["GET", "/provider/settlements", FINANCE_VIEW],
  ["POST", "/provider/settlements", FINANCE_ONLY],
  ["PATCH", "/provider/settlements/:id/confirm", FINANCE_ONLY],

  ["GET", "/provider/unmatched-transactions", FINANCE_VIEW],
  ["POST", "/provider/unmatched-transactions", FINANCE_ONLY],
  ["POST", "/provider/unmatched-transactions/:id/match", FINANCE_ONLY],
  ["POST", "/provider/unmatched-transactions/:id/exception", FINANCE_ONLY],

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
