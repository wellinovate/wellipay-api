-- CreateEnum
CREATE TYPE "RefundRecoveryStatus" AS ENUM ('OWED', 'RECOVERED', 'WAIVED');

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN "recoveryStatus" "RefundRecoveryStatus",
ADD COLUMN "recoveredAt" TIMESTAMP(3),
ADD COLUMN "recoveryNote" TEXT;
