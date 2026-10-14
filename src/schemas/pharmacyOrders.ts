import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);

const rxItem = z.object({
  description: text(160),
  quantity: z.number().int().min(1).max(10_000),
  directions: text(240).optional(),
});

export const patientPrescriptionSchema = z.object({
  prescriberName: text(120),
  prescriberLicenceNo: text(40).optional(),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").optional(),
  notes: text(500).optional(),
  items: z.array(rxItem).min(1).max(20),
});

export const staffPrescriptionSchema = patientPrescriptionSchema.extend({
  patientRef: text(100),
  items: z.array(rxItem.extend({ productId: z.string().min(1).optional() })).min(1).max(20),
});

export const listPrescriptionsQuery = z.object({
  status: z.enum(["SUBMITTED", "VERIFIED", "REJECTED", "CANCELLED", "COMPLETED"]).optional(),
  patientRef: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const verifySchema = z.object({
  decision: z.enum(["VERIFY", "REJECT"]),
  reason: text(240).optional(),
  validDays: z.number().int().min(1).max(180).default(30),
  refillsAllowed: z.number().int().min(0).max(5).default(0),
  items: z.array(z.object({ itemId: z.string().min(1), productId: z.string().min(1).nullable() })).max(20).default([]),
});

export const createOrderSchema = z
  .object({
    invoiceId: z.string().min(1),
    prescriptionId: z.string().min(1).optional(),
    fulfilment: z.enum(["PICKUP", "DELIVERY"]).default("PICKUP"),
    deliveryAddress: text(300).optional(),
    deliveryPhone: text(30).optional(),
    notes: text(300).optional(),
  })
  .refine((v) => v.fulfilment !== "DELIVERY" || (v.deliveryAddress && v.deliveryPhone), {
    message: "A delivery needs an address and a phone number.",
    path: ["deliveryAddress"],
  });

export const dispenseSchema = z.object({
  handedToName: text(120).optional(),
  overridePaymentReason: text(240).optional(),
});

export const cancelOrderSchema = z.object({ reason: text(240).refine((v) => v.length >= 3, "Say why.") });

export const deliverySchema = z.object({
  action: z.enum(["dispatch", "deliver", "fail"]),
  courierName: text(120).optional(),
  recipientName: text(120).optional(),
  proofCode: z.string().trim().regex(/^\d{6}$/, "The code is 6 digits.").optional(),
  note: text(300).optional(),
  reason: text(240).optional(),
});

export const listOrdersQuery = z.object({
  status: z.enum(["AWAITING_DISPENSING", "DISPENSED", "CANCELLED"]).optional(),
  deliveryStatus: z.enum(["PENDING", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const pharmacistSchema = z.object({ licenceNo: z.string().trim().min(3).max(40).nullable() });
