import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export const TENANT_HEADER = 'x-tenant-id';

/**
 * Resuelve el tenant activo de la request y valida la pertenencia del usuario.
 *
 * El tenant **no** viaja en el JWT: viaja por header `X-Tenant-Id` en cada request.
 * Un usuario puede pertenecer a varios tenants y cambiar de uno a otro sin reemitir
 * el token — con el tenant adentro del JWT, cambiar de tenant exigía volver a
 * loguearse, y el selector del frontend cambiaba la UI pero no lo que hacía el API.
 *
 * Es un **guard** y no un interceptor a propósito: en NestJS los guards corren antes
 * que los interceptors, y `RolesGuard` necesita el tenant ya resuelto. Por eso el
 * orden en los controladores es siempre `@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)`.
 *
 * Deja en la request:
 *  - `request.tenantId`  — el tenant activo, que lee `@CurrentTenant()`
 *  - `request.userTenant` — el vínculo `UserTenant`, con su `roleId`
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) throw new ForbiddenException('No autenticado');

    const memberships = await this.prisma.userTenant.findMany({
      where: { userId: user.userId },
      orderBy: { createdAt: 'asc' },
    });

    if (memberships.length === 0) {
      throw new ForbiddenException('El usuario no pertenece a ningún tenant');
    }

    const requested = request.headers?.[TENANT_HEADER];

    let membership;
    if (requested) {
      membership = memberships.find((m) => m.tenantId === requested);
      if (!membership) {
        throw new ForbiddenException('No tenés acceso a este tenant');
      }
    } else if (memberships.length === 1) {
      // Conveniencia: con un solo tenant no hace falta mandar el header.
      membership = memberships[0];
    } else {
      throw new BadRequestException(
        `El usuario pertenece a ${memberships.length} tenants: indicá cuál usar en el header X-Tenant-Id`,
      );
    }

    request.tenantId = membership.tenantId;
    request.userTenant = membership;

    return true;
  }
}
