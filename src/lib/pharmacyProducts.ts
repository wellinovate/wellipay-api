export interface ProductFields {
  category: string;
  genericName: string;
  brandName?: string | undefined | null;
  strength?: string | undefined | null;
  dosageForm?: string | undefined | null;
  packSize?: string | undefined | null;
  dispensingClass: string;
}

// Why a product listing is not acceptable, or null.
export function productProblem(p: ProductFields): string | null {
  if (p.category === "MEDICINE") {
    if (!p.strength?.trim()) return "A medicine needs a strength, for example 500 mg.";
    if (!p.dosageForm?.trim()) return "A medicine needs a dosage form, for example tablet.";
    if (!p.packSize?.trim()) return "A medicine needs a pack size, for example 10 tablets.";
  } else if (p.dispensingClass !== "OTC") {
    return "Only a medicine can be prescription-only or controlled.";
  }
  return null;
}

// The name shown on the price list and on invoice lines.
export function productDisplayName(p: ProductFields): string {
  const parts = [p.genericName.trim()];
  if (p.strength?.trim()) parts.push(p.strength.trim());
  if (p.dosageForm?.trim()) parts.push(p.dosageForm.trim());
  let name = parts.join(" ");
  if (p.brandName?.trim()) name += ` (${p.brandName.trim()})`;
  if (p.packSize?.trim()) name += ` · ${p.packSize.trim()}`;
  return name.slice(0, 120);
}

export const CATEGORY_LABEL: Record<string, string> = {
  MEDICINE: "Medicines",
  CONSUMABLE: "Medical consumables",
  DEVICE: "Medical devices",
};

const SKU_PREFIX: Record<string, string> = { MEDICINE: "MED", CONSUMABLE: "CON", DEVICE: "DEV" };
const SKU_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newSku(category: string, random: () => number = Math.random): string {
  let tail = "";
  for (let i = 0; i < 6; i++) tail += SKU_ALPHABET[Math.floor(random() * SKU_ALPHABET.length)];
  return `${SKU_PREFIX[category] ?? "PRD"}-${tail}`;
}

// Prescription-only and controlled medicines need a verified prescription and a pharmacist.
export function needsPharmacist(dispensingClass: string): boolean {
  return dispensingClass === "PRESCRIPTION_ONLY" || dispensingClass === "CONTROLLED";
}
