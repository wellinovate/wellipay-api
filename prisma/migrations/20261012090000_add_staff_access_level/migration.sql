-- CreateEnum
CREATE TYPE "StaffAccessLevel" AS ENUM ('ADMIN', 'FINANCE', 'BILLING', 'CASHIER', 'VIEWER');

-- AlterTable: existing staff keep full access
ALTER TABLE "staff" ADD COLUMN "accessLevel" "StaffAccessLevel" NOT NULL DEFAULT 'ADMIN';
