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
 * Restringe el acceso a los usuarios que pertenecen al tenant de sistema
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
 * **El corte mira el vínculo resuelto (`request.userTenant`), no la empresa activa
 * (`request.tenantId`).** El superusuario puede pararse en cualquier empresa desde el
 * selector del sidebar; ahí `TenantGuard.resolveAsSystemUser` deja como vínculo el del
 * tenant de sistema (aunque la empresa activa sea otra). Al cortar por el vínculo y no
 * por la empresa activa, el superusuario administra la configuración global desde
 * cualquier empresa, sin que se le oculte ni rompa la opción de menú. El admin de un
 * tenant común nunca pasa: su vínculo jamás es el de sistema. Es un cambio puramente
 * aditivo respecto de "la empresa activa es la de sistema" — no habilita a nadie nuevo.
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
    // otra empresa sigue siendo el de sistema.
    const membershipTenant = await this.prisma.tenant.findUnique({
      where: { id: userTenant.tenantId },
      select: { slug: true },
    });

    if (membershipTenant?.slug !== systemSlug) {
      throw new ForbiddenException(
        'Esta operación solo puede realizarla un usuario del tenant de sistema',
      );
    }

    return true;
  }
}
