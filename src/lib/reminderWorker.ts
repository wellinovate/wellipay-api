import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import { prisma } from "./prisma.js";
import { normalizeNgPhone, sendSms, SmsError } from "./sms.js";
import { reminderMessage } from "./reminders.js";
import { toMinorNumber } from "./money.js";

const TICK_MS = 60_000;
const RETRY_WINDOW_MS = 24 * 3_600_000;

// Sends the SMS for reminders whose time has passed. Each reminder is claimed
// before sending, so two instances cannot send it twice.
export async function sendDueReminders(log: FastifyBaseLogger, now: Date = new Date()): Promise<number> {
  if (!env.TERMII_API_KEY) return 0;
  const config = { apiKey: env.TERMII_API_KEY, senderId: env.TERMII_SENDER_ID, channel: env.TERMII_CHANNEL };
  const due = await prisma.patientReminder.findMany({ where: { sentAt: null, remindAt: { lte: now } }, orderBy: { remindAt: "asc" }, take: 50 });
  let sent = 0;
  for (const r of due) {
    const claimed = await prisma.patientReminder.updateMany({ where: { id: r.id, sentAt: null }, data: { sentAt: now } });
    if (claimed.count === 0) continue;
    const [invoice, record, tenant] = await Promise.all([
      prisma.invoice.findFirst({ where: { id: r.invoiceId, tenantId: r.tenantId, patientRef: r.patientRef } }),
      prisma.patientRecord.findUnique({ where: { tenantId_patientRef: { tenantId: r.tenantId, patientRef: r.patientRef } } }),
      prisma.tenant.findUnique({ where: { id: r.tenantId }, select: { name: true } }),
    ]);
    if (!invoice || invoice.status === "PAID" || invoice.status === "CANCELLED") continue;
    const phone = normalizeNgPhone(record?.phone);
    if (!phone) continue;
    try {
      await sendSms(config, phone, reminderMessage(tenant?.name ?? "your provider", Number(invoice.amountMinor - invoice.paidAmountMinor), invoice.description));
      sent++;
    } catch (err) {
      log.warn({ err: err instanceof SmsError ? err.message : "send failed", reminderId: r.id }, "Reminder SMS failed");
      // Try again next tick, for up to a day after the chosen time.
      if (now.getTime() - r.remindAt.getTime() < RETRY_WINDOW_MS) {
        await prisma.patientReminder.updateMany({ where: { id: r.id }, data: { sentAt: null } });
      }
    }
  }
  return sent;
}

export function startReminderWorker(log: FastifyBaseLogger): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const sent = await sendDueReminders(log);
      if (sent > 0) log.info({ sent }, "Payment reminders sent");
    } catch (err) {
      log.error({ err }, "Reminder tick failed");
    } finally {
      if (!stopped) setTimeout(tick, TICK_MS);
    }
  };
  setTimeout(tick, TICK_MS);
  return () => {
    stopped = true;
  };
}
