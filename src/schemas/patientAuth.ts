import { z } from "zod";

// First-time linking: the patient types in a reference and amount printed
// on their bill to prove they hold that specific invoice, not just its
// number (which may be visible to anyone who sees the paper receipt).
// This is a deliberately lightweight check, not strong identity proofing —
// the real safeguard is that the caller must also be signed in to Clerk
// (their own phone, verified by OTP) before this route is even reachable.
// A stronger flow (staff-generated one-time code) was considered and is
// worth building later if invoice-number guessing turns out to be a
// real-world problem.
export const linkPatientAccountSchema = z.object({
  invoiceRef: z.string().min(1).max(80),
  amountMinor: z.number().int().min(0),
});
