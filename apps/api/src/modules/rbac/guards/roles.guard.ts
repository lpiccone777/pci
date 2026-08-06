import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { systemTenantSlug } from '../../../common/system-tenant';
import { isProtectedRole } from '../protected-role';
import { PERMISSION_KEY, PermissionMetadata } from '../decorators/require-permission.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionMetadata>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required) return true; // Si no hay @RequirePermission, permitir

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) throw new ForbiddenException('No autenticado');

    // El tenant y el vínculo los resolvió TenantGuard, que corre antes en la cadena.
    const userTenant = request.userTenant;
    if (!request.tenantId || !userTenant) {
      throw new ForbiddenException('Tenant no resuelto: falta TenantGuard en el controlador');
    }

    // Los permisos salen del rol de ese vínculo y no de una búsqueda por tenant activo.
    // Cuando el superusuario del sistema opera sobre otra empresa no tiene vínculo con
    // ella, así que buscar por tenant activo no encontraría ningún rol y todo daría 403.
    // De paso ahorra repetir la consulta de membresías que TenantGuard ya hizo.
    const role = await this.prisma.role.findUnique({
      where: { id: userTenant.roleId },
      select: {
        name: true,
        tenant: { select: { slug: true } },
        permissions: { select: { resource: true, action: true } },
      },
    });

    // El superusuario del sistema pasa sin mirar la lista: tiene acceso irrestricto por
    // definición. Es a propósito más fuerte que "tiene todos los permisos del catálogo" —
    // si alguien protege un endpoint con un recurso que se olvidó de agregar al catálogo,
    // el superusuario tampoco se queda afuera de ese.
    if (
      role &&
      isProtectedRole(role.name, role.tenant.slug, systemTenantSlug(this.config))
    ) {
      return true;
    }

    const hasPermission =
      role?.permissions.some(
        (p) => p.resource === required.resource && p.action === required.action,
      ) ?? false;

    if (!hasPermission) {
      throw new ForbiddenException(
        `Permiso denegado: ${required.resource}:${required.action}`,
      );
    }

    return true;
  }
}
