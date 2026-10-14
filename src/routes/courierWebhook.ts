import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma.js";
import { verifySignature } from "../lib/webhooks.js";
import { courierEventSchema } from "../schemas/pharmacyOrders.js";
import { courierEventProblem } from "../lib/courier.js";
import { deliveryActionProblem, nextDeliveryStatus, proofProblem } from "../lib/delivery.js";
import { sendOrderNotice } from "../lib/pharmacyNotice.js";

// A delivery partner reports progress here. Public, so the only authentication is
// an HMAC over "<timestamp>.<raw body>" with the partner's secret, the same scheme
// WelliPay uses to sign its own webhooks. The route answers 401 for anything it
// cannot verify and a plain 2xx or 4xx otherwise, never leaking order details.
const courierWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/webhooks/courier/:courierId", async (request, reply) => {
    const raw = typeof request.body === "string" ? request.body : "";
    const { courierId } = request.params as { courierId: string };
    const ts = Number(request.headers["x-wellipay-timestamp"]);
    const sig = request.headers["x-wellipay-signature"];
    const courier = await prisma.courier.findFirst({ where: { id: courierId, active: true, kind: "PARTNER" } });
    if (!courier?.webhookSecret || !Number.isFinite(ts) || typeof sig !== "string" || !verifySignature(courier.webhookSecret, ts, raw, sig)) {
      return reply.code(401).send();
    }
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return reply.code(400).send(); }
    const parsed = courierEventSchema.safeParse(json);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_event" });
    const e = parsed.data;
    const problem = courierEventProblem(e);
    if (problem) return reply.code(422).send({ error: "invalid_event", message: problem });

    const order = await prisma.pharmacyOrder.findFirst({ where: { tenantId: courier.tenantId, courierId: courier.id, trackingRef: e.trackingRef } });
    // An unknown tracking reference is acknowledged, so the partner does not retry forever.
    if (!order) return reply.code(200).send({ ok: true, applied: false });
    const action = e.status === "OUT_FOR_DELIVERY" ? "dispatch" : e.status === "DELIVERED" ? "deliver" : "fail";
    if (deliveryActionProblem({ orderStatus: order.status, fulfilment: order.fulfilment, deliveryStatus: order.deliveryStatus }, action)) {
      return reply.code(200).send({ ok: true, applied: false });
    }
    let data: {
      deliveryStatus: "OUT_FOR_DELIVERY" | "DELIVERED" | "FAILED";
      dispatchedAt?: Date;
      failureReason?: string | null;
      deliveredAt?: Date;
      deliveredToName?: string | null;
      deliveryNote?: string | null;
    };
    if (action === "deliver") {
      if (proofProblem(order.proofCode, e.proofCode, e.recipientName, undefined)) return reply.code(422).send({ error: "proof_mismatch" });
      data = { deliveryStatus: nextDeliveryStatus("deliver"), deliveredAt: new Date(), deliveredToName: e.recipientName ?? null, deliveryNote: `Reported by ${courier.name}. Confirmed with the patient's code.` };
    } else if (action === "fail") {
      data = { deliveryStatus: nextDeliveryStatus("fail"), failureReason: `${courier.name}: ${e.reason ?? ""}` };
    } else {
      data = { deliveryStatus: nextDeliveryStatus("dispatch"), dispatchedAt: new Date(), failureReason: null };
    }
    const changed = await prisma.pharmacyOrder.updateMany({ where: { id: order.id, deliveryStatus: order.deliveryStatus }, data });
    if (changed.count > 0 && action === "deliver") void sendOrderNotice(order, "DELIVERED", request.log);
    return reply.code(200).send({ ok: true, applied: changed.count > 0 });
  });
};

export default courierWebhookRoutes;
