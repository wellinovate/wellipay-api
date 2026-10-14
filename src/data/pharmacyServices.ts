// Services a pharmacy may offer. A pharmacy adds only the ones it actually
// provides, at its own price. Nothing here is switched on by default.
export interface PharmacyServiceTemplate {
  code: string;
  name: string;
  description: string;
  turnaround: string;
  category: string;
}

export const PHARMACY_SERVICES: PharmacyServiceTemplate[] = [
  { code: "PHS-001", name: "Medication counselling", description: "A pharmacist explains how to take a medicine, side effects and interactions.", turnaround: "15 minutes", category: "Pharmacy services" },
  { code: "PHS-002", name: "Medication review", description: "A pharmacist reviews all the medicines a patient takes.", turnaround: "30 minutes", category: "Pharmacy services" },
  { code: "PHS-003", name: "Blood pressure check", description: "Blood pressure measured and recorded.", turnaround: "10 minutes", category: "Pharmacy services" },
  { code: "PHS-004", name: "Blood glucose check", description: "Finger-prick blood sugar reading.", turnaround: "10 minutes", category: "Pharmacy services" },
  { code: "PHS-005", name: "BMI and weight check", description: "Height, weight and body mass index.", turnaround: "10 minutes", category: "Pharmacy services" },
  { code: "PHS-006", name: "Malaria rapid test", description: "Rapid diagnostic test for malaria.", turnaround: "20 minutes", category: "Pharmacy services" },
  { code: "PHS-007", name: "Pregnancy test", description: "Urine pregnancy test.", turnaround: "10 minutes", category: "Pharmacy services" },
  { code: "PHS-008", name: "Cholesterol screening", description: "Finger-prick cholesterol reading.", turnaround: "15 minutes", category: "Pharmacy services" },
  { code: "PHS-009", name: "Wound dressing", description: "Minor wound cleaning and dressing.", turnaround: "20 minutes", category: "Pharmacy services" },
  { code: "PHS-010", name: "Injection administration", description: "A prescribed injection given by a qualified person.", turnaround: "15 minutes", category: "Pharmacy services" },
  { code: "PHS-011", name: "Home delivery", description: "Delivery of medicines to the patient's address.", turnaround: "Same day", category: "Delivery" },
];

export function findPharmacyService(code: string): PharmacyServiceTemplate | undefined {
  return PHARMACY_SERVICES.find((s) => s.code === code);
}
