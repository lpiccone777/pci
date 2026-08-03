-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "currentFlowId" TEXT,
ADD COLUMN     "currentNodeId" TEXT,
ADD COLUMN     "flowState" JSONB;

-- CreateTable
CREATE TABLE "Flow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "nodes" JSONB NOT NULL,
    "edges" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "Flow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantFlow" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "TenantFlow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Flow_isActive_idx" ON "Flow"("isActive");

-- CreateIndex
CREATE INDEX "Flow_isDefault_idx" ON "Flow"("isDefault");

-- CreateIndex
CREATE INDEX "TenantFlow_tenantId_idx" ON "TenantFlow"("tenantId");

-- CreateIndex
CREATE INDEX "TenantFlow_flowId_idx" ON "TenantFlow"("flowId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantFlow_flowId_tenantId_key" ON "TenantFlow"("flowId", "tenantId");

-- AddForeignKey
ALTER TABLE "TenantFlow" ADD CONSTRAINT "TenantFlow_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantFlow" ADD CONSTRAINT "TenantFlow_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
