import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { isProtectedRole } from '../modules/rbac/protected-role';
import { systemTenantSlug } from './system-tenant';

/**
 * `true` si el vínculo (`UserTenant`) es el del superusuario del sistema: el rol `SuperAdmin`
 * dentro del tenant de sistema (mismo criterio que `isProtectedRole`).
 *
 * Gobierna las capacidades cross-tenant que NINGÚN permiso RBAC cubre: pararse en una empresa
 * de la que no se es miembro (`TenantGuard.resolveAsSystemUser`) y —del lado del frontend, vía
 * el flag `isSuperAdmin` que expone `/auth/me`— ver y seleccionar todas las empresas en el
 * selector. No se usa para los endpoints con permiso (`/settings`, `/tenants/all`, etc.): esos
 * los gobiernan `SystemTenantGuard` (membresía en el tenant de sistema) + RBAC, donde manda el
 * permiso y no el nombre del rol.
 *
 * **Pertenecer al tenant de sistema NO alcanza** para estas capacidades. Un usuario común
 * multiempresa puede ser miembro del tenant de sistema con otro rol; no por eso puede operar
 * como cualquier empresa. Cortar por pertenencia (lo que se hacía antes) confundía a ese
 * usuario común con el superusuario.
 */
export async function isSystemSuperAdmin(
  prisma: PrismaService,
  config: ConfigService,
  userTenant: { tenantId: string; roleId: string } | null | undefined,
): Promise<boolean> {
  if (!userTenant) return false;

  const [tenant, role] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: userTenant.tenantId },
      select: { slug: true },
    }),
    prisma.role.findUnique({
      where: { id: userTenant.roleId },
      select: { name: true },
    }),
  ]);

  return isProtectedRole(
    role?.name ?? '',
    tenant?.slug ?? '',
    systemTenantSlug(config),
  );
}
