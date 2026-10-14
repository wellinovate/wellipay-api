import { z } from "zod";

export const addResultsSchema = z.object({
  tests: z
    .array(
      z.object({
        testName: z.string().trim().min(2).max(160),
        serviceItemId: z.string().min(1).optional(),
      }),
    )
    .min(1)
    .max(60),
});

export const updateResultSchema = z
  .object({
    resultText: z.string().trim().min(1).max(4000).nullable().optional(),
    abnormal: z.boolean().optional(),
    status: z.enum(["PENDING", "READY"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Send at least one field to change.");
