import { needsPharmacist } from "./pharmacyProducts.js";

export interface DispenseLine {
  productId: string;
  quantity: number;
  name: string;
  dispensingClass: string;
}

export interface RxItem {
  productId: string | null;
  quantity: number;
}

export function anyNeedsPharmacist(lines: DispenseLine[]): boolean {
  return lines.some((l) => needsPharmacist(l.dispensingClass));
}

// Each prescription-only or controlled line must be covered by a matched
// prescription item with at least that quantity. OTC lines are not checked.
export function coverageProblem(lines: DispenseLine[], items: RxItem[]): string | null {
  const supplied = new Map<string, number>();
  for (const it of items) if (it.productId) supplied.set(it.productId, (supplied.get(it.productId) ?? 0) + it.quantity);
  const asked = new Map<string, { qty: number; name: string }>();
  for (const l of lines) {
    if (!needsPharmacist(l.dispensingClass)) continue;
    const cur = asked.get(l.productId);
    asked.set(l.productId, { qty: (cur?.qty ?? 0) + l.quantity, name: l.name });
  }
  for (const [productId, want] of asked) {
    const have = supplied.get(productId) ?? 0;
    if (have === 0) return `${want.name} is not on the prescription.`;
    if (want.qty > have) return `${want.name}: the prescription allows ${have}, the order has ${want.qty}.`;
  }
  return null;
}

export interface PaymentGate {
  ok: boolean;
  overridden: boolean;
  problem?: string;
}

const OVERRIDE_LEVELS = ["ADMIN", "FINANCE", "BILLING"];

// A bill should be paid before goods go out. Billing level and above can release
// goods on credit or an HMO claim, with a reason on the record.
export function paymentGate(invoiceStatus: string, overrideReason: string | undefined, staffLevel: string | undefined): PaymentGate {
  if (invoiceStatus === "PAID") return { ok: true, overridden: false };
  if (invoiceStatus === "CANCELLED") return { ok: false, overridden: false, problem: "The bill is cancelled." };
  if (overrideReason !== undefined) {
    if (!staffLevel || !OVERRIDE_LEVELS.includes(staffLevel)) return { ok: false, overridden: false, problem: "Only Billing, Finance or Admin can release goods before payment." };
    if (overrideReason.trim().length < 3) return { ok: false, overridden: false, problem: "Say why the goods are released before payment." };
    return { ok: true, overridden: true };
  }
  return { ok: false, overridden: false, problem: "The bill is not paid." };
}

// Who collected the goods. Needed for pickups so there is a name on the record.
export function handoverProblem(fulfilment: string, handedToName: string | undefined): string | null {
  if (fulfilment === "PICKUP" && !(handedToName && handedToName.trim().length >= 2)) return "Enter the name of the person collecting.";
  return null;
}
