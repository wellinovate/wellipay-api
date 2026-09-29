-- CreateEnum
CREATE TYPE "UnmatchedTransactionStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'EXCEPTION');

-- CreateTable
CREATE TABLE "unmatched_transactions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reference" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "UnmatchedTransactionStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchedPaymentId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unmatched_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "unmatched_transactions_tenantId_status_idx" ON "unmatched_transactions"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "unmatched_transactions" ADD CONSTRAINT "unmatched_transactions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unmatched_transactions" ADD CONSTRAINT "unmatched_transactions_matchedPaymentId_fkey" FOREIGN KEY ("matchedPaymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
