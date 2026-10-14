-- CreateEnum
CREATE TYPE "BookingKind" AS ENUM ('LAB', 'IMAGING');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN "kind" "BookingKind" NOT NULL DEFAULT 'LAB';
