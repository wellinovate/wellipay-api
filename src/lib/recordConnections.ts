// Rules for linking a patient's WelliPay profile to a health-record identifier.
// Pure functions, so they run in tests without a database.
//
// An identifier such as a WR-ID is a reference. Knowing it proves nothing about
// who the person is, and a link never gives anyone access to records.

export const CONNECTION_KINDS = ["WELLIRECORD", "EXTERNAL_SYSTEM", "PROVIDER_PATIENT_NUMBER"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const CONNECTION_STATUSES = ["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "REVOKED", "EXPIRED"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const GRANTS_NOTICE = "A connection links a reference to your profile. It does not give anyone access to your records.";

export const CODE_TTL_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_OPEN_CONNECTIONS = 10;

export function isPartnerKind(kind: ConnectionKind): boolean {
  return kind === "WELLIRECORD" || kind === "EXTERNAL_SYSTEM";
}

type Normalised = { ok: true; value: string } | { ok: false; message: string };

// Cleans and checks the identifier the patient typed. The format check only
// rejects typing mistakes. It does not say the identifier exists.
export function normalizeReference(kind: ConnectionKind, raw: string): Normalised {
  const trimmed = raw.trim();
  if (kind === "WELLIRECORD") {
    const value = trimmed.toUpperCase();
    if (value.length < 4 || value.length > 40 || !/^WR-[A-Z0-9]+(-[A-Z0-9]+)*$/.test(value)) {
      return { ok: false, message: "A WelliRecord ID starts with WR- and uses letters, numbers and dashes, for example WR-2291-04." };
    }
    return { ok: true, value };
  }
  if (kind === "EXTERNAL_SYSTEM") {
    if (trimmed.length < 3 || trimmed.length > 60 || !/^[A-Za-z0-9][A-Za-z0-9._\-/:]*[A-Za-z0-9]$/.test(trimmed)) {
      return { ok: false, message: "Enter the patient ID exactly as the other system shows it, without spaces." };
    }
    return { ok: true, value: trimmed };
  }
  const value = trimmed.replace(/\s+/g, " ").toUpperCase();
  if (value.length < 1 || value.length > 40 || !/^[A-Z0-9]([A-Z0-9._\-/ ]*[A-Z0-9])?$/.test(value)) {
    return { ok: false, message: "Enter the patient number exactly as it appears on your card or receipt." };
  }
  return { ok: true, value };
}

// The namespace a reference lives in. The same number from two providers is two different references.
export function scopeKey(kind: ConnectionKind, integrationKey: string | null, tenantId: string): string {
  return isPartnerKind(kind) ? `integration:${integrationKey ?? ""}` : `tenant:${tenantId}`;
}

export function integrationKeyProblem(key: string): string | null {
  return /^[a-z][a-z0-9-]{1,30}$/.test(key) ? null : "The key uses lowercase letters, numbers and dashes, 2 to 31 characters, starting with a letter.";
}

// Name of the environment variable that holds a partner's API key.
export function integrationEnvName(key: string): string {
  return `RECORD_INTEGRATION_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

export function codeProblem(code: string): string | null {
  return /^\d{6}$/.test(code) ? null : "The code is 6 digits.";
}

export type ConfirmCheck = { ok: true } | { ok: false; code: "not_pending" | "expired" | "too_many_attempts"; message: string };

export function confirmCheck(input: { status: string; attempts: number; expiresAt: Date | null; now: Date }): ConfirmCheck {
  if (input.status !== "PENDING_VERIFICATION") return { ok: false, code: "not_pending", message: "This connection is not waiting for a code." };
  if (!input.expiresAt || input.expiresAt.getTime() <= input.now.getTime()) {
    return { ok: false, code: "expired", message: "The code has expired. Start the connection again." };
  }
  if (input.attempts >= MAX_CODE_ATTEMPTS) {
    return { ok: false, code: "too_many_attempts", message: "Too many wrong codes. Start the connection again." };
  }
  return { ok: true };
}

export function canRevoke(status: string): boolean {
  return status === "PENDING_VERIFICATION" || status === "VERIFIED";
}

// What the patient's app should show next.
export function nextStep(kind: ConnectionKind, status: string): "ENTER_CODE" | "AWAIT_PROVIDER_REVIEW" | "NONE" {
  if (status !== "PENDING_VERIFICATION") return "NONE";
  return isPartnerKind(kind) ? "ENTER_CODE" : "AWAIT_PROVIDER_REVIEW";
}
