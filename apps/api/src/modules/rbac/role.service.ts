import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { isCatalogedPermission } from './permissions.catalog';
import { effectivePermissions, isProtectedRole } from './protected-role';
import { systemTenantSlug } from '../../common/system-tenant';

/**
 * Trae permisos, cuántos usuarios tienen el rol y el slug de su empresa, en una sola consulta.
 *
 * El slug está acá y no en una consulta aparte porque es lo único que hace falta para saber
 * si el rol es el superusuario del sistema (ver `protected-role.ts`): pidiéndolo junto con el
 * rol, identificar el rol protegido no cuesta ningún viaje extra a la base.
 */
const ROLE_INCLUDE = {
  permissions: true,
  tenant: { select: { slug: true } },
  _count: { select: { userTenants: true } },
} as const;

type RoleWithCount = Prisma.RoleGetPayload<{ include: typeof ROLE_INCLUDE }>;

@Injectable()
export class RoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get systemSlug(): string {
    return systemTenantSlug(this.config);
  }

  /** `true` si el rol es el superusuario del sistema. */
  isProtected(role: RoleWithCount): boolean {
    return isProtectedRole(role.name, role.tenant.slug, this.systemSlug);
  }

  /**
   * Corta cualquier escritura sobre el rol protegido.
   *
   * Las tres operaciones que bloquea son las tres formas de sacarle permisos: cambiárselos,
   * borrar el rol entero, o renombrarlo —que lo dejaría fuera de la identificación y, con
   * eso, desprotegido—. Va en los servicios y no en el controlador porque es acá donde
   * ocurre la escritura, y donde ya está `findEntity` que valida el tenant.
   */
  assertNotProtected(role: RoleWithCount): void {
    if (!this.isProtected(role)) return;
    throw new ConflictException(
      `${role.name} es el rol de superusuario del sistema: tiene todos los permisos ` +
        'de forma permanente y no se puede modificar, renombrar ni eliminar.',
    );
  }

  /**
   * Forma en que la pantalla consume un rol.
   *
   * `userCount` sale del `_count` en vez de traer las membresías enteras: la tabla solo
   * necesita el número, y un rol con cientos de usuarios no tiene por qué viajar completo.
   *
   * `permissionCount` cuenta **solo los permisos del catálogo**, que son los que la matriz
   * dibuja. Si sumara los cargados a mano fuera de catálogo, la tabla podría decir 51 y la
   * matriz mostrar 48 tildes, sin explicación posible en pantalla. Los permisos fuera de
   * catálogo siguen en `permissions` para quien los quiera inspeccionar.
   *
   * `isProtected` viaja a la pantalla para que muestre el rol de sistema en modo consulta.
   * Sin ese dato el bloqueo funciona igual, pero se manifiesta como un error inesperado
   * recién al guardar. El `tenant` se saca de la respuesta: entró en la consulta solo para
   * calcular el flag, y la pantalla ya sabe en qué empresa está.
   */
  /**
   * Los permisos que hay que informar para este rol.
   *
   * Público porque `PermissionService` lee los permisos por su cuenta y tiene que dar la
   * misma respuesta: el criterio vive en `effectivePermissions` y se entra siempre por acá.
   */
  permissionsOf(role: RoleWithCount) {
    return effectivePermissions(
      role.name,
      role.tenant.slug,
      this.systemSlug,
      role.permissions,
    );
  }

  private toResponse(role: RoleWithCount) {
    const { _count, tenant, ...rest } = role;
    const permissions = this.permissionsOf(role);
    return {
      ...rest,
      permissions,
      userCount: _count.userTenants,
      permissionCount: permissions.filter((p) =>
        isCatalogedPermission(p.resource, p.action),
      ).length,
      isProtected: isProtectedRole(role.name, tenant.slug, this.systemSlug),
    };
  }

  async create(tenantId: string, dto: CreateRoleDto) {
    try {
      const role = await this.prisma.role.create({
        data: { name: dto.name.trim(), tenantId },
        include: ROLE_INCLUDE,
      });
      return this.toResponse(role);
    } catch (err) {
      throw this.translateWriteError(err, dto.name.trim());
    }
  }

  async findAll(tenantId: string) {
    const roles = await this.prisma.role.findMany({
      where: { tenantId },
      include: ROLE_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return roles.map((r) => this.toResponse(r));
  }

  /**
   * Roles de TODAS las empresas, con la empresa de cada uno. Modo lectura del superadmin
   * ("Todas las empresas"). Mismo mapeo que `findAll`, pero sin scope de tenant y sumando
   * `tenant` a la respuesta (que `toResponse` normalmente descarta) para la columna Empresa.
   * El corte de acceso lo pone `SystemTenantGuard` en el controlador.
   */
  async findAllCrossTenant() {
    const roles = await this.prisma.role.findMany({
      include: {
        permissions: true,
        tenant: { select: { id: true, name: true, slug: true } },
        _count: { select: { userTenants: true } },
      },
      orderBy: [{ tenant: { name: 'asc' } }, { createdAt: 'asc' }],
    });
    return roles.map((r) => ({
      ...this.toResponse(r),
      tenant: { id: r.tenant.id, name: r.tenant.name, slug: r.tenant.slug },
    }));
  }

  /**
   * Roles de TODAS las empresas del propio usuario (vista "Todas las empresas" del usuario
   * común, que no es superadmin). Mismo shape que `findAllCrossTenant` (con `tenant`), pero
   * acotado a las empresas donde ESTE usuario puede ver roles (su rol tiene `roles:read`).
   *
   * Contraparte no-privilegiada de `findAllCrossTenant`: el superadmin ve todo el sistema; el
   * usuario común, solo sus empresas. El scope lo pone el propio userId, no el header. Espejo
   * de `UsersService.findMine` y `AreasService.findMine`.
   */
  async findMine(userId: string) {
    const myMemberships = await this.prisma.userTenant.findMany({
      where: { userId, tenant: { deletedAt: null } },
      include: {
        role: { select: { permissions: { select: { resource: true, action: true } } } },
      },
    });

    const readableTenantIds = myMemberships
      .filter((m) =>
        m.role.permissions.some(
          (p) => p.resource === 'roles' && p.action === 'read',
        ),
      )
      .map((m) => m.tenantId);

    if (readableTenantIds.length === 0) return [];

    const roles = await this.prisma.role.findMany({
      where: { tenantId: { in: readableTenantIds } },
      include: {
        permissions: true,
        tenant: { select: { id: true, name: true, slug: true } },
        _count: { select: { userTenants: true } },
      },
      orderBy: [{ tenant: { name: 'asc' } }, { createdAt: 'asc' }],
    });
    return roles.map((r) => ({
      ...this.toResponse(r),
      tenant: { id: r.tenant.id, name: r.tenant.name, slug: r.tenant.slug },
    }));
  }

  async findOne(tenantId: string, id: string) {
    const role = await this.findEntity(tenantId, id);
    return this.toResponse(role);
  }

  /**
   * El rol crudo del tenant activo, con permisos y contador.
   *
   * Es el "verificar antes de operar" que usa todo lo demás: cualquier operación sobre un
   * rol —o sobre sus permisos— pasa primero por acá, así el id de un rol de otro tenant
   * nunca llega a la escritura. `PermissionService` lo reusa por eso mismo.
   *
   * El superusuario del sistema administra roles de otras empresas eligiendo la empresa
   * en el header, no salteando este filtro: `TenantGuard` le deja pedir cualquiera aunque
   * no sea miembro, y para cuando la consulta llega acá el tenant activo ya es el de esa
   * empresa. Por eso acá no hay ninguna excepción que escribir.
   */
  async findEntity(tenantId: string, id: string): Promise<RoleWithCount> {
    const role = await this.prisma.role.findFirst({
      where: { id, tenantId },
      include: ROLE_INCLUDE,
    });
    if (!role) throw new NotFoundException('Rol no encontrado');
    return role;
  }

  async update(tenantId: string, id: string, dto: UpdateRoleDto) {
    const current = await this.findEntity(tenantId, id);
    // Renombrar el superusuario lo dejaría fuera de la identificación por nombre y, con eso,
    // sin protección: por eso el nombre también está congelado.
    this.assertNotProtected(current);
    try {
      const role = await this.prisma.role.update({
        where: { id },
        data: { name: dto.name.trim() },
        include: ROLE_INCLUDE,
      });
      return this.toResponse(role);
    } catch (err) {
      throw this.translateWriteError(err, dto.name.trim());
    }
  }

  async remove(tenantId: string, id: string) {
    const role = await this.findEntity(tenantId, id);
    this.assertNotProtected(role);

    // La FK de UserTenant.role no cascadea, así que la base ya rechazaría el delete. Lo
    // contamos antes para poder decir cuántos son y qué hacer: el error de Prisma sin
    // traducir no le sirve a nadie.
    const users = role._count.userTenants;
    if (users > 0) {
      throw new ConflictException(
        `No se puede eliminar ${role.name}: ${users} ` +
          (users === 1
            ? 'usuario lo tiene asignado.'
            : 'usuarios lo tienen asignado.') +
          ' Reasignalos a otro rol desde Usuarios y volvé a intentar.',
      );
    }

    await this.prisma.role.delete({ where: { id } });
    return { message: `Rol ${role.name} eliminado.` };
  }

  /** Quiénes tienen este rol, para la ventana de usuarios de la pantalla. */
  async findUsers(tenantId: string, id: string) {
    await this.findEntity(tenantId, id);

    const memberships = await this.prisma.userTenant.findMany({
      where: { roleId: id, tenantId },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((m) => m.user);
  }

  /**
   * `@@unique([name, tenantId])` devuelve un P2002 que no le dice nada a quien está
   * creando un rol. Lo traducimos acá, una sola vez, para create y update.
   */
  private translateWriteError(err: unknown, name: string): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException(
        `Ya existe un rol llamado ${name} en esta empresa.`,
      );
    }
    return err;
  }
}
