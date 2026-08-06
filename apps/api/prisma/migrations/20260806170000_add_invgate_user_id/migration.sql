-- AlterTable
ALTER TABLE "User" ADD COLUMN     "invgateUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_invgateUserId_key" ON "User"("invgateUserId");
