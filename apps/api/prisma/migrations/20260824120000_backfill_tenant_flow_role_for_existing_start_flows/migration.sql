-- Backfill para TenantFlow.isStart=true creados antes de que existiera
-- TenantFlowRole (migracion 20260810135857_add_tenant_flow_role). Antes de esa
-- migracion, un flujo de inicio aplicaba a CUALQUIER rol del tenant; ahora
-- FlowService.findActiveFlowForTenant exige un TenantFlowRole que matchee el
-- rol del usuario, asi que sin este backfill los flujos de inicio ya
-- configurados dejan de servirse a cualquier usuario conocido apenas se
-- despliega esta feature.
--
-- Solo toca TenantFlow rows con CERO roles cargados (el estado en el que
-- quedaron todos al crearse la tabla TenantFlowRole vacia) para no pisar
-- configuraciones ya hechas a mano con la semantica nueva.
INSERT INTO "TenantFlowRole" ("id", "tenantFlowId", "roleId")
SELECT gen_random_uuid()::text, tf."id", r."id"
FROM "TenantFlow" tf
JOIN "Role" r ON r."tenantId" = tf."tenantId"
WHERE tf."isStart" = true
  AND NOT EXISTS (
    SELECT 1 FROM "TenantFlowRole" tfr WHERE tfr."tenantFlowId" = tf."id"
  )
ON CONFLICT ("tenantFlowId", "roleId") DO NOTHING;
