-- AlterTable
ALTER TABLE "Flow" ADD COLUMN     "contextSourceId" TEXT;

-- CreateTable
CREATE TABLE "ContextSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContextSource_tenantId_idx" ON "ContextSource"("tenantId");

-- CreateIndex
CREATE INDEX "ContextSource_type_idx" ON "ContextSource"("type");

-- CreateIndex
CREATE UNIQUE INDEX "ContextSource_name_tenantId_key" ON "ContextSource"("name", "tenantId");

-- CreateIndex
CREATE INDEX "Flow_contextSourceId_idx" ON "Flow"("contextSourceId");

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_contextSourceId_fkey" FOREIGN KEY ("contextSourceId") REFERENCES "ContextSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextSource" ADD CONSTRAINT "ContextSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
