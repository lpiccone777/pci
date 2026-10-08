-- CreateTable
CREATE TABLE "TitanConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "itEmail" TEXT NOT NULL,
    "itPassword" TEXT,
    "lastImportAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TitanConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TitanUserLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "titanUserId" INTEGER NOT NULL,
    "titanEmail" TEXT NOT NULL,
    "titanPersonId" TEXT,
    "titanCompanyId" TEXT,
    "titanCompanyName" TEXT,
    "titanRoles" TEXT[],
    "titanLocked" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TitanUserLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TitanConnection_tenantId_key" ON "TitanConnection"("tenantId");

-- CreateIndex
CREATE INDEX "TitanUserLink_tenantId_idx" ON "TitanUserLink"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TitanUserLink_tenantId_titanUserId_key" ON "TitanUserLink"("tenantId", "titanUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TitanUserLink_userId_tenantId_key" ON "TitanUserLink"("userId", "tenantId");

-- AddForeignKey
ALTER TABLE "TitanConnection" ADD CONSTRAINT "TitanConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TitanUserLink" ADD CONSTRAINT "TitanUserLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TitanUserLink" ADD CONSTRAINT "TitanUserLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

