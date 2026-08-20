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
 * Restringe el acceso a quienes pertenecen al tenant de sistema (slug `system`, creado por el
 * seed). Es el PRIMER candado de las operaciones cross-tenant; el SEGUNDO es el permiso RBAC
 * (`@RequirePermission` + `RolesGuard`). Adentro del tenant de sistema **manda el RBAC
 * dinámico**: quien tenga el permiso pasa, sin importar el nombre de su rol.
 *
 * Usado por cualquier operación genuinamente CROSS-TENANT — configuración global
 * (`/settings`, único en toda la BD) o visibilidad de todos los tenants del
 * sistema (`GET /tenants/all`, y los `/all` de users, roles, áreas y flujos). El motivo de
 * pedir membresía en el tenant de sistema —y no solo el permiso RBAC— es que un admin de un
 * tenant común con `roles:create` + `permissions:create` podría auto-asignarse el permiso que
 * falte, pero NO puede meterse solo en el tenant de sistema: esa membresía la otorga el
 * superusuario. Por eso el corte es por membresía y no por nombre de rol (constraint de
 * AGENTS.md: no hardcodear roles).
 *
 * **El corte mira el vínculo resuelto (`request.userTenant`), no la empresa activa
 * (`request.tenantId`).** El superusuario puede pararse en cualquier empresa desde el
 * selector del sidebar; ahí `TenantGuard.resolveAsSystemUser` deja como vínculo el del
 * tenant de sistema (aunque la empresa activa sea otra). Al cortar por el vínculo y no
 * por la empresa activa, administra la configuración global desde cualquier empresa, sin que
 * se le oculte ni rompa la opción de menú.
 *
 * Requiere que `TenantGuard` haya corrido antes en la cadena de guards (resuelve
 * `request.userTenant`).
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

    const userTenant = request.userTenant;
    if (!userTenant) {
      throw new ForbiddenException(
        'Tenant no resuelto: falta TenantGuard en el controlador',
      );
    }

    const systemSlug = systemTenantSlug(this.config);

    // El tenant del VÍNCULO (no el de la empresa activa): para el superusuario parado en
    // otra empresa sigue siendo el de sistema. El permiso RBAC lo valida `RolesGuard` aparte.
    const membershipTenant = await this.prisma.tenant.findUnique({
      where: { id: userTenant.tenantId },
      select: { slug: true },
    });

    if (membershipTenant?.slug !== systemSlug) {
      throw new ForbiddenException(
        'Esta operación solo puede realizarse desde el tenant de sistema',
      );
    }

    return true;
  }
}
