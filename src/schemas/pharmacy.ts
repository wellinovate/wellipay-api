import { z } from "zod";
import { ADJUSTMENT_REASONS, WRITE_OFF_REASONS } from "../lib/pharmacyStock.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const price = z.number().int().min(1).max(10_000_000_000);

export const productCategory = z.enum(["MEDICINE", "CONSUMABLE", "DEVICE"]);
export const dispensingClass = z.enum(["OTC", "PRESCRIPTION_ONLY", "CONTROLLED"]);

export const createProductSchema = z.object({
  category: productCategory,
  genericName: text(120).refine((v) => v.length >= 2, "Name is too short."),
  brandName: text(120).optional(),
  strength: text(40).optional(),
  dosageForm: text(40).optional(),
  packSize: text(60).optional(),
  unit: text(20).default("pack"),
  sku: text(40).optional(),
  barcode: text(40).optional(),
  nafdacNumber: text(30).optional(),
  manufacturer: text(120).optional(),
  priceMinor: price,
  dispensingClass: dispensingClass.default("OTC"),
  reorderLevel: z.number().int().min(0).max(1_000_000).default(0),
});

export const updateProductSchema = z
  .object({
    genericName: text(120).optional(),
    brandName: text(120).nullable().optional(),
    strength: text(40).nullable().optional(),
    dosageForm: text(40).nullable().optional(),
    packSize: text(60).nullable().optional(),
    unit: text(20).optional(),
    barcode: text(40).nullable().optional(),
    nafdacNumber: text(30).nullable().optional(),
    manufacturer: text(120).nullable().optional(),
    priceMinor: price.optional(),
    dispensingClass: dispensingClass.optional(),
    reorderLevel: z.number().int().min(0).max(1_000_000).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Send at least one field to change.");

export const listProductsQuery = z.object({
  q: z.string().trim().max(120).optional(),
  category: productCategory.optional(),
  dispensingClass: dispensingClass.optional(),
  stock: z.enum(["low", "out"]).optional(),
  includeInactive: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

export const createSupplierSchema = z.object({
  name: text(120),
  contactName: text(120).optional(),
  phone: text(30).optional(),
  email: z.string().trim().email().max(160).optional(),
  address: text(240).optional(),
});

export const updateSupplierSchema = z
  .object({
    name: text(120).optional(),
    contactName: text(120).nullable().optional(),
    phone: text(30).nullable().optional(),
    email: z.string().trim().email().max(160).nullable().optional(),
    address: text(240).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Send at least one field to change.");

export const receiptSchema = z.object({
  productId: z.string().min(1),
  supplierId: z.string().min(1).optional(),
  batchNo: text(60),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").optional(),
  quantity: z.number().int().min(1).max(10_000_000),
  costMinor: z.number().int().min(0).max(10_000_000_000).optional(),
  note: text(240).optional(),
});

export const adjustmentSchema = z.object({
  batchId: z.string().min(1),
  delta: z.number().int().min(-10_000_000).max(10_000_000),
  reason: z.enum(ADJUSTMENT_REASONS),
  note: text(240).optional(),
});

export const writeOffSchema = z.object({
  batchId: z.string().min(1),
  reason: z.enum(WRITE_OFF_REASONS),
  note: text(240).optional(),
});

export const quarantineSchema = z.object({
  quarantined: z.boolean(),
  reason: text(240).optional(),
});

export const movementsQuery = z.object({
  productId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const serviceOffersSchema = z.object({
  services: z
    .array(z.object({ code: z.string().min(1), unitPriceMinor: price }))
    .min(1)
    .max(30),
});
