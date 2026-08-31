import { PrismaService } from '../../prisma/prisma.service';

/**
 * Empresas del usuario en las que tiene permiso de lectura sobre un recurso dado.
 *
 * Es el filtro que comparten todos los `findMine` (`/flows/mine`, `/areas/mine`, `/users/mine`,
 * `/roles/mine`, `/skills/mine`, `/context-sources/mine`): la vista "todas mis empresas" del
 * usuario común, cuyo scope lo pone el propio `userId` y no el header `X-Tenant-Id`. Cada
 * empresa se incluye solo si el rol del usuario en ella tiene `<resource>:read`. Antes este
 * bloque estaba copiado casi igual en seis services; un fix acá vale para todos.
 */
export async function resolveReadableTenantIds(
  prisma: PrismaService,
  userId: string,
  resource: string,
): Promise<string[]> {
  const memberships = await prisma.userTenant.findMany({
    where: { userId, tenant: { deletedAt: null } },
    include: {
      role: { select: { permissions: { select: { resource: true, action: true } } } },
    },
  });

  return memberships
    .filter((m) =>
      m.role.permissions.some((p) => p.resource === resource && p.action === 'read'),
    )
    .map((m) => m.tenantId);
}
