-- CreateTable
CREATE TABLE "TenantFlowRole" (
    "id" TEXT NOT NULL,
    "tenantFlowId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "TenantFlowRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantFlowRole_roleId_idx" ON "TenantFlowRole"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantFlowRole_tenantFlowId_roleId_key" ON "TenantFlowRole"("tenantFlowId", "roleId");

-- AddForeignKey
ALTER TABLE "TenantFlowRole" ADD CONSTRAINT "TenantFlowRole_tenantFlowId_fkey" FOREIGN KEY ("tenantFlowId") REFERENCES "TenantFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantFlowRole" ADD CONSTRAINT "TenantFlowRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
