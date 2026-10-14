export const MAX_ACTIVE_REMINDERS = 20;
export const MAX_REMINDER_DAYS = 180;

// Why a reminder time cannot be used, or null.
export function reminderTimeProblem(remindAt: Date, now: Date = new Date()): string | null {
  if (Number.isNaN(remindAt.getTime())) return "Choose a valid date.";
  if (remindAt.getTime() <= now.getTime() + 60_000) return "Choose a time at least a minute from now.";
  if (remindAt.getTime() > now.getTime() + MAX_REMINDER_DAYS * 86_400_000) return `Choose a date within ${MAX_REMINDER_DAYS} days.`;
  return null;
}

function naira(minor: number): string {
  return `₦${(minor / 100).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// The SMS text. Plain, no links the patient has to trust.
export function reminderMessage(providerName: string, outstandingMinor: number, description: string): string {
  const what = description.length > 40 ? `${description.slice(0, 37)}...` : description;
  return `WelliPay: you asked to be reminded. ${naira(outstandingMinor)} is still due at ${providerName} for ${what}. Open the WelliPay app to pay.`;
}

export type DueState = "OVERDUE" | "DUE_SOON" | "OPEN";

// How urgent a bill is. Due within 3 days counts as soon.
export function dueState(dueAt: Date | null, now: Date = new Date()): DueState {
  if (!dueAt) return "OPEN";
  const ms = dueAt.getTime() - now.getTime();
  if (ms < 0) return "OVERDUE";
  if (ms <= 3 * 86_400_000) return "DUE_SOON";
  return "OPEN";
}
