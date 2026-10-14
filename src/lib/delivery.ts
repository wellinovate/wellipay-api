import { randomInt } from "node:crypto";

export function newProofCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export type DeliveryAction = "dispatch" | "deliver" | "fail";

export interface DeliveryState {
  orderStatus: string;
  fulfilment: string;
  deliveryStatus: string;
}

// Why a delivery step cannot happen now, or null. Goods must be dispensed first.
export function deliveryActionProblem(s: DeliveryState, action: DeliveryAction): string | null {
  if (s.fulfilment !== "DELIVERY") return "This order is for pickup.";
  if (s.orderStatus !== "DISPENSED") return "Dispense the order first.";
  if (action === "dispatch") {
    if (s.deliveryStatus === "PENDING" || s.deliveryStatus === "FAILED") return null;
    return s.deliveryStatus === "OUT_FOR_DELIVERY" ? "It is already out for delivery." : "It has already been delivered.";
  }
  if (s.deliveryStatus !== "OUT_FOR_DELIVERY") return "Mark it out for delivery first.";
  return null;
}

export function nextDeliveryStatus(action: DeliveryAction): "OUT_FOR_DELIVERY" | "DELIVERED" | "FAILED" {
  return action === "dispatch" ? "OUT_FOR_DELIVERY" : action === "deliver" ? "DELIVERED" : "FAILED";
}

// Proof of handover. With the patient's code, the name is enough. Without it
// the staff member must record why, for example that ID was checked.
export function proofProblem(expected: string | null, supplied: string | undefined, recipientName: string | undefined, note: string | undefined): string | null {
  if (!(recipientName && recipientName.trim().length >= 2)) return "Enter the name of the person who received it.";
  if (supplied !== undefined && supplied !== "") {
    return expected && supplied.trim() === expected ? null : "That code does not match.";
  }
  if (!(note && note.trim().length >= 5)) return "Enter the patient's code, or say how the recipient was confirmed.";
  return null;
}

export function deliveryFeeFromLines(lines: { quantity: number; unitPriceMinor: number; category: string | null }[]): number {
  return lines.filter((l) => l.category === "Delivery").reduce((sum, l) => sum + l.quantity * l.unitPriceMinor, 0);
}
