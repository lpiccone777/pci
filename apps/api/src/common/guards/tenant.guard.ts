import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { systemTenantSlug } from '../system-tenant';
import { isProtectedRole } from '../../modules/rbac/protected-role';

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
 *
 * ## Excepción del tenant de sistema
 *
 * El superusuario del sistema (rol `SuperAdmin` en el tenant de sistema) puede pedir
 * **cualquier** empresa en el header, sin ser miembro de ella. A partir de ahí todo el
 * backend cree que está trabajando en esa empresa, así que la administra igual que a la propia.
 *
 * Está acá y no repartida por módulo a propósito: es el único punto por el que pasan
 * todos los controladores con datos por tenant, así que un módulo nuevo la hereda por
 * el solo hecho de usar la cadena de guards estándar. La alternativa —escribirla en
 * cada servicio— se rompe el día que alguien se olvida, que es exactamente como nació
 * el agujero de permisos cross-tenant que hubo que cerrar.
 *
 * El corte es por rol SuperAdmin en el tenant de sistema, no por mera pertenencia a ese
 * tenant: mismo criterio que `SystemTenantGuard` (ver `isSystemSuperAdmin`). Un usuario
 * común que además pertenece al tenant de sistema NO puede pararse en otra empresa.
 * Adentro de la empresa elegida sigue mandando el RBAC, con los permisos del rol que el
 * superusuario tiene en el tenant de sistema.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get systemSlug(): string {
    return systemTenantSlug(this.config);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) throw new ForbiddenException('No autenticado');

    // Baja real: las membresías contra una empresa dada de baja no cuentan. El usuario no la
    // ve en el selector (`/auth/me` la filtra igual) ni puede operar en ella; si era su única
    // empresa, queda sin tenant activo hasta que se lo reasigne.
    const memberships = await this.prisma.userTenant.findMany({
      where: { userId: user.userId, tenant: { deletedAt: null } },
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
        const asSystem = await this.resolveAsSystemUser(memberships, requested);
        if (!asSystem) {
          throw new ForbiddenException('No tenés acceso a este tenant');
        }
        // El tenant activo es el pedido, pero el vínculo —y con él, el rol y los
        // permisos con los que va a operar— sigue siendo el del tenant de sistema.
        request.tenantId = requested;
        request.userTenant = asSystem;
        return true;
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

  /**
   * El vínculo del usuario con el tenant de sistema, si lo tiene. `null` si no, y en ese
   * caso quien llama corta con el 403 de siempre.
   *
   * Las consultas corren solo cuando el usuario pidió una empresa de la que no es miembro —
   * en el uso normal, nunca.
   */
  private async resolveAsSystemUser<T extends { tenantId: string; roleId: string }>(
    memberships: T[],
    requestedTenantId: string,
  ): Promise<T | null> {
    const systemTenant = await this.prisma.tenant.findUnique({
      where: { slug: this.systemSlug },
      select: { id: true },
    });
    if (!systemTenant) return null;

    const systemMembership = memberships.find(
      (m) => m.tenantId === systemTenant.id,
    );
    if (!systemMembership) return null;

    // Pertenecer al tenant de sistema no alcanza: solo el rol SuperAdmin hereda el poder de
    // pararse en una empresa de la que no se es miembro. Un usuario común que además está en
    // el tenant de sistema no pasa (devuelve null → el 403 de siempre).
    //
    // El tenant de `systemMembership` ya lo resolvimos por slug (`this.systemSlug`) arriba, así
    // que su slug es ese mismo: no hace falta volver a consultarlo. Solo falta el nombre del
    // rol. (Por eso no se usa `isSystemSuperAdmin`, que re-consultaría el tenant que ya tenemos.)
    const role = await this.prisma.role.findUnique({
      where: { id: systemMembership.roleId },
      select: { name: true },
    });
    const superAdmin = isProtectedRole(
      role?.name ?? '',
      this.systemSlug,
      this.systemSlug,
    );
    if (!superAdmin) return null;

    // Sin este chequeo, un id inventado dejaría el tenant activo apuntando a la nada:
    // cada consulta devolvería vacío y parecería una empresa existente pero sin datos.
    const exists = await this.prisma.tenant.findUnique({
      where: { id: requestedTenantId },
      select: { id: true, deletedAt: true },
    });
    // Una empresa dada de baja se trata como inexistente: ni el superusuario opera en ella.
    if (!exists || exists.deletedAt) {
      throw new NotFoundException('La empresa indicada no existe');
    }

    return systemMembership;
  }
}
