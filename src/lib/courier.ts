import { randomBytes } from "node:crypto";

export function newCourierSecret(): string {
  return `cs_${randomBytes(24).toString("hex")}`;
}

// {ref} in the template becomes the tracking reference. Only http(s) links are produced.
export function trackingUrlFor(template: string | null | undefined, ref: string | null | undefined): string | null {
  if (!template || !ref) return null;
  const url = template.replace("{ref}", encodeURIComponent(ref));
  return /^https?:\/\//i.test(url) ? url : null;
}

export function templateProblem(template: string | undefined): string | null {
  if (!template) return null;
  if (!/^https:\/\//i.test(template)) return "The tracking link must start with https://.";
  if (!template.includes("{ref}")) return "The tracking link must contain {ref} where the tracking number goes.";
  return null;
}

export interface CourierEvent {
  trackingRef: string;
  status: "OUT_FOR_DELIVERY" | "DELIVERED" | "FAILED";
  reason?: string | undefined;
  recipientName?: string | undefined;
  proofCode?: string | undefined;
}

// A partner reports "delivered" only with the code the patient read out, so a
// partner cannot close an order that was not handed to the patient.
export function courierEventProblem(e: CourierEvent): string | null {
  if (e.status === "DELIVERED") {
    if (!e.proofCode) return "A delivered report needs the patient's proof code.";
    if (!(e.recipientName && e.recipientName.trim().length >= 2)) return "A delivered report needs the recipient's name.";
  }
  if (e.status === "FAILED" && !(e.reason && e.reason.trim().length >= 3)) return "A failed report needs a reason.";
  return null;
}
