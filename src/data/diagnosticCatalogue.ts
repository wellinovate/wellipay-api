// Master catalogue of diagnostic tests. A provider picks the ones it offers
// and sets its own price, turnaround time and preparation. Nothing here carries
// a price. `checkups` lists the general check-up lists a test belongs to.

export type CheckupList = "MALE" | "FEMALE";

export interface CatalogueCategory {
  code: string;
  name: string;
}

export interface CatalogueTest {
  code: string;
  name: string;
  categoryCode: string;
  sampleType: string;
  checkups: CheckupList[];
}

export const CATALOGUE_CATEGORIES: CatalogueCategory[] = [
  { code: "PHYS", name: "Physical examination and screening" },
  { code: "HAEM", name: "Haematology and inflammation" },
  { code: "INFE", name: "Infectious disease and serology" },
  { code: "VITM", name: "Vitamins and minerals" },
  { code: "ENDO", name: "Endocrinology and metabolic tests" },
  { code: "RENL", name: "Kidney and liver investigations" },
  { code: "GIUR", name: "Gastrointestinal and urine tests" },
  { code: "CARD", name: "Cardiac investigations" },
  { code: "IMAG", name: "Imaging" },
  { code: "GYNA", name: "Gynaecological investigations" },
  { code: "ONCO", name: "Tumour markers and cancer screening" },
];

const B = "Blood";
const NONE = "None (procedure)";
const BOTH: CheckupList[] = ["MALE", "FEMALE"];
const M: CheckupList[] = ["MALE"];
const F: CheckupList[] = ["FEMALE"];

type Row = [categoryCode: string, name: string, sampleType: string, checkups: CheckupList[]];

const ROWS: Row[] = [
  // Physical examination and screening
  ["PHYS", "Physical Examination (BP/BMI)", NONE, BOTH],
  ["PHYS", "Visual Acuity", NONE, BOTH],
  ["PHYS", "Mental Health Assessment", NONE, F],
  // Haematology and inflammation
  ["HAEM", "Full Blood Count (FBC) + ESR", B, BOTH],
  ["HAEM", "C-Reactive Protein (CRP)", B, BOTH],
  // Infectious disease and serology
  ["INFE", "Genotype + Blood Group", B, BOTH],
  ["INFE", "Malaria + Widal", B, BOTH],
  ["INFE", "Hepatitis A, B and C + HIV Screening", B, BOTH],
  ["INFE", "Chlamydia Screening", "Swab or urine", BOTH],
  ["INFE", "VDRL (Syphilis Screening)", B, BOTH],
  ["INFE", "Gonorrhoea Screening", "Swab or urine", BOTH],
  ["INFE", "HSV 1 & 2 (Herpes Screening)", "Blood or swab", BOTH],
  ["INFE", "H. pylori (Ulcer Screening)", "Stool or blood", BOTH],
  ["INFE", "HPV Detection", "Swab", BOTH],
  // Vitamins and minerals
  ["VITM", "Vitamin B12 + Ferritin + Iron", B, BOTH],
  ["VITM", "Vitamin D", B, BOTH],
  ["VITM", "Calcium + Phosphate + Magnesium", B, BOTH],
  // Endocrinology and metabolic tests
  ["ENDO", "Thyroid Function (T3, T4, TSH)", B, BOTH],
  ["ENDO", "Thyroid Scan", NONE, BOTH],
  ["ENDO", "Blood Sugar (Glucose)", B, BOTH],
  ["ENDO", "HbA1c", B, BOTH],
  ["ENDO", "Lipid Profile", B, BOTH],
  ["ENDO", "Uric Acid", B, BOTH],
  ["ENDO", "Hormones (Testosterone, DHEAS, Cortisol)", B, M],
  ["ENDO", "Hormones (Cortisol)", B, F],
  // Kidney and liver investigations
  ["RENL", "Kidney Function (E/U/Cr + eGFR)", B, BOTH],
  ["RENL", "Liver Function Test", B, BOTH],
  ["RENL", "Microalbumin", "Urine", BOTH],
  // Gastrointestinal and urine tests
  ["GIUR", "Occult Blood", "Stool", BOTH],
  ["GIUR", "Stool & Urine M/C/S + Urinalysis", "Stool and urine", BOTH],
  ["GIUR", "Lipase + Amylase", B, BOTH],
  // Cardiac investigations
  ["CARD", "ECG Resting", NONE, BOTH],
  ["CARD", "Echocardiogram", NONE, BOTH],
  ["CARD", "D-Dimer", B, BOTH],
  ["CARD", "Cardiac Markers (CK-MB, Troponin I & T)", B, BOTH],
  ["CARD", "Homocysteine", B, BOTH],
  // Imaging
  ["IMAG", "Chest X-ray", NONE, BOTH],
  ["IMAG", "Abdomino-Prostate Scan", NONE, M],
  ["IMAG", "Abdomino-Pelvic Scan", NONE, F],
  ["IMAG", "Mammogram/Breast Scan", NONE, F],
  // Gynaecological investigations
  ["GYNA", "High Vaginal Swab M/C/S", "Swab", F],
  ["GYNA", "Liquid-Based Cytology/Pap Smear", "Cervical sample", F],
  // Tumour markers and cancer screening
  ["ONCO", "PSA (Total)", B, M],
  ["ONCO", "Tumour Marker: CEA", B, M],
  ["ONCO", "Tumour Markers: CA-19.9, CA-72.4", B, M],
  ["ONCO", "Alpha Fetoprotein (AFP)", B, M],
  ["ONCO", "Tumour Markers: CEA, AFP", B, F],
  ["ONCO", "Tumour Markers: CA-19.9, CA-72.4, CA-125, CA-15.3", B, F],
];

// Codes run in order inside each category: LAB-HAEM-001, LAB-HAEM-002, ...
const counters = new Map<string, number>();
export const DIAGNOSTIC_CATALOGUE: CatalogueTest[] = ROWS.map(([categoryCode, name, sampleType, checkups]) => {
  const next = (counters.get(categoryCode) ?? 0) + 1;
  counters.set(categoryCode, next);
  return { code: `LAB-${categoryCode}-${String(next).padStart(3, "0")}`, name, categoryCode, sampleType, checkups };
});

const BY_CODE = new Map(DIAGNOSTIC_CATALOGUE.map((t) => [t.code, t]));
export function findCatalogueTest(code: string): CatalogueTest | undefined {
  return BY_CODE.get(code);
}

export function categoryName(code: string): string {
  return CATALOGUE_CATEGORIES.find((c) => c.code === code)?.name ?? code;
}
