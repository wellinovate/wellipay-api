// Termii SMS. Server-side only; the API key never reaches a browser.

export class SmsError extends Error {}

// Nigerian numbers: 0803 123 4567, +234 803 123 4567 and 2348031234567 all
// become 2348031234567. Returns null when the number cannot be used.
export function normalizeNgPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  let n = digits;
  if (n.startsWith("234")) n = n.slice(3);
  else if (n.startsWith("0")) n = n.slice(1);
  if (!/^[789]\d{9}$/.test(n)) return null;
  return `234${n}`;
}

export interface SmsConfig {
  apiKey: string;
  senderId: string;
  channel: "generic" | "dnd" | "whatsapp";
}

export async function sendSms(config: SmsConfig, to: string, message: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.ng.termii.com/api/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, from: config.senderId, sms: message, type: "plain", channel: config.channel, api_key: config.apiKey }),
    });
  } catch {
    throw new SmsError("The SMS service could not be reached.");
  }
  if (!res.ok) {
    let detail = "";
    try { detail = ((await res.json()) as { message?: string }).message ?? ""; } catch { /* ignore */ }
    throw new SmsError(detail ? `The SMS service refused the message: ${detail}` : `The SMS service returned ${res.status}.`);
  }
}

// Minutes a reminder blocks another one for the same booking.
export const REMINDER_COOLDOWN_MINUTES = 15;

export function reminderCooldownProblem(lastSent: Date | null, now: Date = new Date()): string | null {
  if (!lastSent) return null;
  const minutes = (now.getTime() - lastSent.getTime()) / 60000;
  if (minutes < REMINDER_COOLDOWN_MINUTES) return `A reminder was sent ${Math.max(1, Math.floor(minutes))} minute${Math.floor(minutes) === 1 ? "" : "s"} ago. Wait before sending another.`;
  return null;
}
