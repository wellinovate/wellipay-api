import type { FastifyBaseLogger } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

interface EventData {
  amount?: number;
  currency?: string;
  gateway_response?: string;
  fees?: number;
}

// Handles a Paystack webhook for a wallet top-up. Returns false when the
// reference is not a top-up. A success credits the wallet once: the top-up row
// is claimed first, and the ledger entry is unique per reference.
export async function creditTopUp(eventName: string | undefined, reference: string, data: EventData, log: FastifyBaseLogger): Promise<boolean> {
  const topUp = await prisma.walletTopUp.findUnique({ where: { reference } });
  if (!topUp) return false;
  if (topUp.status !== "PENDING") return true;

  if (eventName === "charge.failed") {
    await prisma.walletTopUp.updateMany({
      where: { id: topUp.id, status: "PENDING" },
      data: { status: "FAILED", failureReason: (data.gateway_response ?? "Payment failed").slice(0, 200) },
    });
    return true;
  }

  const paid = data.amount;
  if (data.currency !== "NGN" || !Number.isInteger(paid) || BigInt(paid as number) !== topUp.amountMinor) {
    log.error({ reference, paid }, "Paystack amount mismatch on wallet top-up");
    await prisma.walletTopUp.updateMany({
      where: { id: topUp.id, status: "PENDING" },
      data: { status: "FAILED", failureReason: "Amount or currency did not match the top-up." },
    });
    return true;
  }

  const fees = Number.isInteger(data.fees) && (data.fees as number) >= 0 ? BigInt(data.fees as number) : null;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const claimed = await tx.walletTopUp.updateMany({
      where: { id: topUp.id, status: "PENDING" },
      data: { status: "SUCCESS", ...(fees !== null ? { feesMinor: fees } : {}) },
    });
    if (claimed.count === 0) return;
    await tx.walletAccount.upsert({
      where: { tenantId_patientRef: { tenantId: topUp.tenantId, patientRef: topUp.patientRef } },
      create: { tenantId: topUp.tenantId, patientRef: topUp.patientRef, balanceMinor: topUp.amountMinor },
      update: { balanceMinor: { increment: topUp.amountMinor } },
    });
    await tx.walletEntry.create({
      data: { tenantId: topUp.tenantId, patientRef: topUp.patientRef, kind: "TOPUP", amountMinor: topUp.amountMinor, reference },
    });
  });
  return true;
}
