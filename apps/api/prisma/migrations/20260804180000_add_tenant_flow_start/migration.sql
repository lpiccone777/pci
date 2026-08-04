-- Flujo de inicio POR TENANT: un mismo flujo puede servir a varios tenants y ser
-- "de inicio" solo para algunos. La invariante "un tenant, un flujo de inicio como
-- máximo" se aplica en la app (FlowService), no acá.

ALTER TABLE "TenantFlow" ADD COLUMN "isStart" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "TenantFlow_isStart_idx" ON "TenantFlow"("isStart");
