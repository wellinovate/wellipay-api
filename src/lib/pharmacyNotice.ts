import { env } from "../env.js";
import { prisma } from "./prisma.js";
import { normalizeNgPhone, sendSms } from "./sms.js";

import { noticeMessage, type NoticeEvent } from "./pharmacyNoticeText.js";

interface OrderLike {
  id: string;
  tenantId: string;
  patientRef: string;
  fulfilment: string;
  deliveryPhone: string | null;
  courierName?: string | null;
  trackingUrl?: string | null;
}

// Tries to send and writes down the result. A failure never stops the order step
// that caused it: the dispensing record matters more than the text message.
export async function sendOrderNotice(order: OrderLike, event: NoticeEvent, log?: { warn: (o: unknown, m: string) => void }): Promise<void> {
  const record = (status: "SENT" | "FAILED" | "SKIPPED", phone: string | null, error?: string) =>
    prisma.pharmacyNotice.create({ data: { tenantId: order.tenantId, orderId: order.id, event, status, ...(phone ? { phone } : {}), ...(error ? { error } : {}) } }).catch(() => undefined);
  try {
    const [tenant, patient] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: order.tenantId }, select: { name: true } }),
      prisma.patientRecord.findUnique({ where: { tenantId_patientRef: { tenantId: order.tenantId, patientRef: order.patientRef } } }),
    ]);
    const message = noticeMessage({ pharmacy: tenant?.name ?? "Your pharmacy", event, fulfilment: order.fulfilment, courierName: order.courierName, trackingUrl: order.trackingUrl });
    if (!message) return;
    const phone = normalizeNgPhone(order.deliveryPhone) ?? normalizeNgPhone(patient?.phone);
    if (!env.TERMII_API_KEY) return void (await record("SKIPPED", phone, "SMS is not set up."));
    if (!phone) return void (await record("SKIPPED", null, "No usable phone number."));
    await sendSms({ apiKey: env.TERMII_API_KEY, senderId: env.TERMII_SENDER_ID, channel: env.TERMII_CHANNEL }, phone, message);
    await record("SENT", phone);
  } catch (err) {
    log?.warn({ err, orderId: order.id }, "pharmacy order SMS failed");
    await record("FAILED", null, err instanceof Error ? err.message.slice(0, 200) : "Unknown error");
  }
}
