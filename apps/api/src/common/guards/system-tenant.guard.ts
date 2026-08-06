import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { systemTenantSlug } from '../system-tenant';

/**
 * Restringe el acceso a los usuarios cuyo tenant activo es el tenant de sistema
 * (slug `system`, creado por el seed).
 *
 * Usado por cualquier operación genuinamente CROSS-TENANT — configuración global
 * (`/settings`, único en toda la BD) o visibilidad de todos los tenants del
 * sistema (`GET /tenants/all`). En esos casos no alcanza con un permiso RBAC:
 * cualquier admin de tenant con `roles:create` + `permissions:create` podría
 * auto-asignarse el permiso que falte. Este guard es el corte real de
 * "solo superusuario".
 *
 * No hardcodea nombres de rol (constraint de AGENTS.md): el corte es por tenant
 * de sistema, y dentro de ese tenant sigue mandando el RBAC dinámico.
 *
 * Requiere que `TenantGuard` haya corrido antes en la cadena de guards (resuelve
 * `request.tenantId`).
 */
@Injectable()
export class SystemTenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) throw new ForbiddenException('No autenticado');
    if (!request.tenantId) throw new ForbiddenException('No se especificó un tenant');

    const systemSlug = systemTenantSlug(this.config);

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: request.tenantId },
      select: { slug: true },
    });

    if (tenant?.slug !== systemSlug) {
      throw new ForbiddenException(
        'Esta operación solo puede realizarse desde el tenant de sistema',
      );
    }

    return true;
  }
}
