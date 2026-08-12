-- AlterTable
ALTER TABLE "User" ADD COLUMN     "internalPhone" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_internalPhone_key" ON "User"("internalPhone");
