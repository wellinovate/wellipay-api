import { z } from "zod";

const price = z.number().int().min(1).max(10_000_000_000);

export const listCatalogueQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(10).optional(),
});

export const offerTestsSchema = z.object({
  tests: z
    .array(
      z.object({
        code: z.string().trim().min(1).max(30),
        unitPriceMinor: price,
        turnaround: z.string().trim().min(1).max(60).optional(),
        preparation: z.string().trim().min(1).max(500).optional(),
        homeCollection: z.boolean().optional(),
        digitalResults: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(60),
});

const tier = z.enum(["CLASSIC", "EXECUTIVE", "DIAMOND", "PLATINUM"]);
const audience = z.enum(["ALL", "MALE", "FEMALE"]);
const name = z.string().trim().min(2).max(120);
const includedIds = z.array(z.string().min(1)).min(2).max(80);
const exclusions = z.string().trim().min(1).max(1000);

export const createCheckupPackageSchema = z.object({
  name,
  tier,
  audience: audience.optional(),
  priceMinor: price,
  includedIds,
  exclusions: exclusions.optional(),
  available: z.boolean().optional(),
});

export const updateCheckupPackageSchema = z
  .object({
    name: name.optional(),
    tier: tier.optional(),
    audience: audience.optional(),
    priceMinor: price.optional(),
    includedIds: includedIds.optional(),
    exclusions: exclusions.nullable().optional(),
    available: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Send at least one field to change.");
