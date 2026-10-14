import { z } from "zod";

const name = z.string().trim().min(2).max(120);
const category = z.string().trim().min(1).max(60);
// Whole kobo, at least 1 kobo, below ₦100,000,000.
const price = z.number().int().min(1).max(10_000_000_000);
// Ids of the single items inside a package. Leave out, or send [], for a single item.
const componentIds = z.array(z.string().min(1)).max(40);

export const createServiceItemSchema = z.object({
  name,
  category: category.optional(),
  unitPriceMinor: price,
  componentIds: componentIds.optional(),
});

export const updateServiceItemSchema = z
  .object({
    name: name.optional(),
    category: category.nullable().optional(),
    unitPriceMinor: price.optional(),
    active: z.boolean().optional(),
    componentIds: componentIds.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Send at least one field to change.");

export const listServiceItemsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  includeInactive: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
