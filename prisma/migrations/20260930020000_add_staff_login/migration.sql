-- AlterTable
ALTER TABLE "staff" ADD COLUMN "passwordHash" TEXT;

-- CreateIndex
-- If this fails with a duplicate-key error, two existing staff rows share
-- an email — that has to be resolved (rename or remove one) before this
-- migration can apply, since login now looks staff up by email alone.
CREATE UNIQUE INDEX "staff_email_key" ON "staff"("email");
