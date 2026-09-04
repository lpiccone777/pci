-- CreateTable
CREATE TABLE "DeviceValidation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceValidation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceValidation_fingerprint_key" ON "DeviceValidation"("fingerprint");

-- CreateIndex
CREATE INDEX "DeviceValidation_userId_idx" ON "DeviceValidation"("userId");

-- AddForeignKey
ALTER TABLE "DeviceValidation" ADD CONSTRAINT "DeviceValidation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
