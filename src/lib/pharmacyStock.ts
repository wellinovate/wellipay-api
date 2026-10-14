export const NEAR_EXPIRY_DAYS = 90;

export type ExpiryState = "NO_EXPIRY" | "EXPIRED" | "NEAR" | "OK";

function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// A batch is expired from the day after its expiry date. Stock labelled
// "expiry 31/10" is usable through 31 October.
export function expiryState(expiry: Date | null, today: Date = new Date()): ExpiryState {
  if (!expiry) return "NO_EXPIRY";
  const days = Math.floor((startOfUtcDay(expiry) - startOfUtcDay(today)) / 86_400_000);
  if (days < 0) return "EXPIRED";
  if (days <= NEAR_EXPIRY_DAYS) return "NEAR";
  return "OK";
}

export function daysToExpiry(expiry: Date | null, today: Date = new Date()): number | null {
  if (!expiry) return null;
  return Math.floor((startOfUtcDay(expiry) - startOfUtcDay(today)) / 86_400_000);
}

export interface BatchLike {
  id: string;
  expiryDate: Date | null;
  quantityOnHand: number;
  status: string;
  receivedAt: Date;
}

// Stock that can be sold: active, in date, with units left.
export function isUsable(batch: BatchLike, today: Date = new Date()): boolean {
  return batch.status === "ACTIVE" && batch.quantityOnHand > 0 && expiryState(batch.expiryDate, today) !== "EXPIRED";
}

export function onHand(batches: BatchLike[], today: Date = new Date()): number {
  return batches.filter((b) => isUsable(b, today)).reduce((sum, b) => sum + b.quantityOnHand, 0);
}

export interface Allocation {
  batchId: string;
  quantity: number;
}

// First expiry, first out. Takes from the batch that expires soonest. Batches
// with no expiry date come last. Ties go to the older receipt.
export function allocateFefo(batches: BatchLike[], needed: number, today: Date = new Date()): { allocations: Allocation[]; shortfall: number } {
  const usable = batches.filter((b) => isUsable(b, today)).sort((a, b) => {
    const ea = a.expiryDate ? a.expiryDate.getTime() : Number.POSITIVE_INFINITY;
    const eb = b.expiryDate ? b.expiryDate.getTime() : Number.POSITIVE_INFINITY;
    if (ea !== eb) return ea - eb;
    return a.receivedAt.getTime() - b.receivedAt.getTime();
  });
  const allocations: Allocation[] = [];
  let left = needed;
  for (const b of usable) {
    if (left <= 0) break;
    const take = Math.min(b.quantityOnHand, left);
    allocations.push({ batchId: b.id, quantity: take });
    left -= take;
  }
  return { allocations, shortfall: Math.max(0, left) };
}

export type StockLevel = "OUT" | "LOW" | "OK";

// LOW means at or below the reorder level. A reorder level of 0 never flags LOW.
export function stockLevel(available: number, reorderLevel: number): StockLevel {
  if (available <= 0) return "OUT";
  if (reorderLevel > 0 && available <= reorderLevel) return "LOW";
  return "OK";
}

export const ADJUSTMENT_REASONS = ["COUNT_CORRECTION", "DAMAGED", "LOST", "FOUND", "OTHER"] as const;
export const WRITE_OFF_REASONS = ["EXPIRED", "DAMAGED", "RECALLED"] as const;

// Why a stock adjustment cannot go ahead, or null. A negative result is never allowed.
export function adjustmentProblem(current: number, delta: number, reason: string, note: string | undefined): string | null {
  if (!Number.isInteger(delta) || delta === 0) return "Enter a whole number that is not zero.";
  if (current + delta < 0) return `The batch has ${current} on hand. It cannot go below zero.`;
  if (reason === "OTHER" && !(note && note.trim().length >= 3)) return "Say why, in a short note.";
  if (delta > 0 && reason !== "FOUND" && reason !== "COUNT_CORRECTION" && reason !== "OTHER") return `${reason.toLowerCase()} cannot add stock.`;
  if (delta < 0 && reason === "FOUND") return "Found stock adds to the count.";
  return null;
}

// Why a receipt cannot go ahead, or null. Medicines need an expiry date, and
// nothing that has expired is received.
export function receiptProblem(category: string, expiry: Date | null, quantity: number, today: Date = new Date()): string | null {
  if (!Number.isInteger(quantity) || quantity < 1) return "Quantity must be at least 1.";
  if (category === "MEDICINE" && !expiry) return "A medicine needs an expiry date.";
  if (expiry && expiryState(expiry, today) === "EXPIRED") return "That batch has already expired.";
  return null;
}
