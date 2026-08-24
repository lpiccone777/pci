import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { systemTenantSlug } from '../../common/system-tenant';
import { isProtectedRole } from '../rbac/protected-role';
import {
  BulkImportUserRowDto,
  BulkImportUsersDto,
  CreateUserDto,
  CreateUserMultiTenantDto,
  UpdateUserDto,
  UpdateUserFullDto,
} from './dto/user.dto';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  internalPhone: true,
  invgateUserId: true,
  createdAt: true,
} as const;

/**
 * El sufijo que se le agrega a los campos de una persona dada de baja: `_20260811-143205`.
 *
 * Cumple dos funciones a la vez: marca la fila como dada de baja a simple vista y —sobre todo—
 * LIBERA los campos únicos (email, teléfono, interno, invgateUserId), para que el valor original
 * quede disponible si más adelante se da de alta a alguien con esos mismos datos.
 *
 * Sin espacios ni dos puntos a propósito: el mismo sufijo termina pegado a un email y a un
 * teléfono, y ahí esos caracteres molestan.
 *
 * La hora se arma en UTC (no en la hora local del servidor) para que coincida con `deletedAt`,
 * que se persiste en UTC como todas las fechas del sistema. Si se usara la hora local, el sufijo
 * y el `deletedAt` de la misma baja mostrarían horas distintas —desfasadas por el huso horario—
 * y no se podrían correlacionar mirando la tabla.
 */
function deletionSuffix(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `_${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`
  );
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Usuarios del tenant activo, con el rol y el área que tienen *en ese* tenant.
   *
   * El filtro por `deletedAt` es redundante en la práctica —a quien se da de baja se le quitan
   * todas sus membresías, así que ya no tiene fila que listar— pero se deja explícito: es la
   * garantía de que una persona dada de baja nunca reaparece en un listado, aunque quedara una
   * membresía suelta por un dato inconsistente.
   */
  async findAll(tenantId: string) {
    const memberships = await this.prisma.userTenant.findMany({
      where: { tenantId, user: { deletedAt: null } },
      include: {
        user: { select: USER_SELECT },
        role: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((m) => ({
      ...m.user,
      role: m.role,
      area: m.area,
      joinedAt: m.createdAt,
    }));
  }

  /**
   * Usuarios de TODAS las empresas (una fila por membresía), con la empresa de cada una.
   * Modo lectura del superadmin ("Todas las empresas"): mismo mapeo que `findAll` pero sin
   * scope de tenant y sumando `tenant`. Una misma persona en varias empresas aparece varias
   * veces, una por membresía, con el rol/área que tiene en cada una. El corte de acceso lo
   * pone `SystemTenantGuard` en el controlador.
   */
  async findAllCrossTenant() {
    const memberships = await this.prisma.userTenant.findMany({
      // Excluye tanto a las personas dadas de baja como a las membresías contra empresas dadas
      // de baja: la vista consolidada no debe mostrar datos de una empresa que ya no se lista.
      where: { user: { deletedAt: null }, tenant: { deletedAt: null } },
      include: {
        user: { select: USER_SELECT },
        role: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
        tenant: { select: { id: true, name: true, slug: true } },
      },
      orderBy: [{ tenant: { name: 'asc' } }, { createdAt: 'asc' }],
    });

    return memberships.map((m) => ({
      ...m.user,
      role: m.role,
      area: m.area,
      tenant: m.tenant,
      joinedAt: m.createdAt,
    }));
  }

  /**
   * Usuarios de TODAS las empresas del propio usuario (vista "Todas las empresas" del
   * usuario común, que no es superadmin). Una fila por membresía, con su empresa — mismo
   * shape que `findAllCrossTenant`, pero acotado a las empresas donde ESTE usuario puede
   * ver usuarios (su rol tiene `users:read`).
   *
   * Es la contraparte no-privilegiada de `findAllCrossTenant`: el superadmin ve todo el
   * sistema; el usuario común, solo sus empresas. El scope lo pone el propio userId, no el
   * header, así que no necesita `SystemTenantGuard` ni un tenant activo — cada empresa se
   * filtra por el permiso que el usuario tiene en ella.
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
          (p) => p.resource === 'users' && p.action === 'read',
        ),
      )
      .map((m) => m.tenantId);

    if (readableTenantIds.length === 0) return [];

    const memberships = await this.prisma.userTenant.findMany({
      where: { tenantId: { in: readableTenantIds }, user: { deletedAt: null } },
      include: {
        user: { select: USER_SELECT },
        role: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
        tenant: { select: { id: true, name: true, slug: true } },
      },
      orderBy: [{ tenant: { name: 'asc' } }, { createdAt: 'asc' }],
    });

    return memberships.map((m) => ({
      ...m.user,
      role: m.role,
      area: m.area,
      tenant: m.tenant,
      joinedAt: m.createdAt,
    }));
  }

  /**
   * Una membresía concreta. `findFirst` y no `findUnique` porque hay que filtrar también por
   * `user.deletedAt`, y la clave compuesta no admite condiciones extra. Como es el chequeo de
   * pertenencia que usan `update` y `remove`, esto es lo que hace que una persona dada de baja
   * no se pueda editar ni volver a dar de baja.
   */
  async findOne(tenantId: string, userId: string) {
    const membership = await this.prisma.userTenant.findFirst({
      where: { userId, tenantId, user: { deletedAt: null } },
      include: {
        user: { select: USER_SELECT },
        role: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
      },
    });

    if (!membership) {
      throw new NotFoundException('El usuario no existe en este tenant');
    }

    return {
      ...membership.user,
      role: membership.role,
      area: membership.area,
      joinedAt: membership.createdAt,
    };
  }

  /**
   * Los datos de una persona y sus membresías EN LAS EMPRESAS QUE EL EDITOR PUEDE VER
   * (`users:read`), para poblar el editor multiempresa. El superusuario ve todas.
   *
   * Solo devuelve las membresías visibles: si la persona está en una empresa que quien edita
   * no administra, esa membresía no aparece —y por lo tanto el editor no puede tocarla—. El
   * scope lo pone `requesterId`, no el header.
   */
  async findMembershipsForEditor(requesterId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: USER_SELECT,
    });
    if (!user) throw new NotFoundException('El usuario no existe');

    const isSuper = await this.isSystemSuperUser(requesterId);

    const memberships = await this.prisma.userTenant.findMany({
      where: { userId, tenant: { deletedAt: null } },
      include: {
        role: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
        tenant: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { tenant: { name: 'asc' } },
    });

    const visible: Array<{
      tenantId: string;
      tenant: { id: string; name: string; slug: string };
      role: { id: string; name: string } | null;
      area: { id: string; name: string } | null;
    }> = [];
    for (const m of memberships) {
      if (
        isSuper ||
        (await this.hasUsersPermissionInTenant(requesterId, m.tenantId, 'read', isSuper))
      ) {
        visible.push({
          tenantId: m.tenantId,
          tenant: m.tenant,
          role: m.role,
          area: m.area,
        });
      }
    }

    // Sin ninguna empresa visible en común, quien consulta no administra a esta persona en
    // ningún lado: cortamos para no filtrar sus datos (nombre, email, teléfono, id de Invgate)
    // a alguien que no tiene por qué verlos. Sin este corte, el endpoint no lleva
    // `@RequirePermission` y devolvía los datos de cualquier persona con solo su id. El
    // superusuario del sistema pasa siempre (ve todas las empresas).
    if (!isSuper && visible.length === 0) {
      throw new ForbiddenException('No tenés permiso para ver a este usuario');
    }

    return { ...user, memberships: visible };
  }

  async create(tenantId: string, requesterId: string, dto: CreateUserDto) {
    await this.assertRoleBelongsToTenant(tenantId, dto.roleId);

    const areaId = dto.areaId || null;
    if (areaId) await this.assertAreaBelongsToTenant(tenantId, areaId);

    // Los cuatro campos globales (email, teléfono, interno, identificador de Invgate) son únicos
    // en todo el sistema: si alguno ya está en uso por una persona activa, el alta se bloquea. Antes el
    // email reutilizaba el registro existente (lo sumaba a esta empresa); esa "alta encubierta"
    // se quitó a pedido — para sumar a alguien que ya existe se usa la edición.
    await this.assertEmailAvailable(dto.email, requesterId);
    if (dto.phone) await this.assertPhoneAvailable(dto.phone, requesterId);
    if (dto.internalPhone) await this.assertInternalPhoneAvailable(dto.internalPhone, requesterId);
    if (dto.invgateUserId) await this.assertInvgateUserIdAvailable(dto.invgateUserId, requesterId);

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone || null,
        internalPhone: dto.internalPhone || null,
        invgateUserId: dto.invgateUserId || null,
        passwordHash,
        tenants: {
          create: { tenantId, roleId: dto.roleId, areaId },
        },
      },
    });

    this.logger.log(`Usuario creado: ${user.email} en tenant ${tenantId}`);
    return this.findOne(tenantId, user.id);
  }

  /**
   * Alta de una persona en varias empresas a la vez. Un rol y, opcional, un área por empresa.
   *
   * Ya no es exclusiva del superadmin: la puede usar cualquiera, pero solo sobre las empresas
   * que puede administrar. `requesterId` es quien da el alta, y por cada empresa destino se
   * valida que pueda crear usuarios ahí (`assertCanManageUsersInTenant`) — el superusuario en
   * cualquiera, el resto solo donde es miembro con `users:create`. Como las empresas destino
   * vienen en el body (no en el header), esta validación no la puede hacer `RolesGuard`; por
   * eso vive acá.
   *
   * Es la generalización de `create`: valida permiso, rol y área de CADA empresa antes de
   * tocar nada, y crea el usuario y las N membresías de forma atómica. Si alguno de los cuatro
   * campos globales (email, teléfono, interno, identificador de Invgate) ya está en uso por una
   * persona activa, corta con un 409 — mismo criterio que `create`. Para sumar a alguien que ya existe
   * a una empresa nueva se usa la edición, no el alta.
   */
  async createMultiTenant(requesterId: string, dto: CreateUserMultiTenantDto) {
    const tenantIds = dto.memberships.map((m) => m.tenantId);
    if (new Set(tenantIds).size !== tenantIds.length) {
      throw new BadRequestException('Hay empresas repetidas en la selección');
    }

    // Quien da el alta tiene que poder crear usuarios en CADA empresa destino. Sin este
    // corte, con el header de una empresa propia se podría dar de alta en cualquier otra.
    for (const tenantId of tenantIds) {
      await this.assertCanManageUsersInTenant(requesterId, tenantId, 'create');
    }

    // Rol y área tienen que pertenecer a SU empresa: sin esto se colaría RBAC entre empresas.
    for (const m of dto.memberships) {
      await this.assertRoleBelongsToTenant(m.tenantId, m.roleId);
      if (m.areaId) await this.assertAreaBelongsToTenant(m.tenantId, m.areaId);
    }

    // Unicidad global de los cuatro campos: si alguno ya está en uso por una persona activa, el
    // alta se bloquea entera (mismo criterio que `create`). El email ya no reutiliza el
    // registro existente: para sumar a alguien que ya existe se usa la edición.
    await this.assertEmailAvailable(dto.email, requesterId);
    if (dto.phone) await this.assertPhoneAvailable(dto.phone, requesterId);
    if (dto.internalPhone) await this.assertInternalPhoneAvailable(dto.internalPhone, requesterId);
    if (dto.invgateUserId) await this.assertInvgateUserIdAvailable(dto.invgateUserId, requesterId);

    const membershipData = dto.memberships.map((m) => ({
      tenantId: m.tenantId,
      roleId: m.roleId,
      areaId: m.areaId || null,
    }));

    const passwordHash = await bcrypt.hash(dto.password, 10);

    // La persona nueva + todas sus membresías en una sola operación: atómica por sí misma.
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone || null,
        internalPhone: dto.internalPhone || null,
        invgateUserId: dto.invgateUserId || null,
        passwordHash,
        tenants: { create: membershipData },
      },
    });

    this.logger.log(`Usuario creado: ${user.email} en ${membershipData.length} empresas`);
    return {
      userId: user.id,
      email: user.email,
      created: true,
      memberships: membershipData.length,
    };
  }

  /**
   * Carga masiva desde Excel. El frontend ya parseó el archivo y mapeó columna→campo; acá
   * llega una lista de filas de persona ya limpias, más un rol (y opcional área) ÚNICOS para
   * todo el lote — un Excel de personal casi nunca trae una columna de rol usable tal cual.
   *
   * No es todo-o-nada: cada fila se valida por separado (duplicada dentro del mismo archivo,
   * o algún campo único ya en uso en la base) y las que fallan se reportan sin bloquear a las
   * demás. Las que pasan se crean todas juntas en una transacción, con una contraseña
   * temporal autogenerada por persona (no viene en el Excel, y no hay flujo de invitación por
   * email en el sistema) que se devuelve para que quien importa se la pase al usuario.
   */
  async bulkImport(tenantId: string, requesterId: string, dto: BulkImportUsersDto) {
    await this.assertRoleBelongsToTenant(tenantId, dto.defaultRoleId);
    const areaId = dto.defaultAreaId || null;
    if (areaId) await this.assertAreaBelongsToTenant(tenantId, areaId);

    const failed: { row: number; email: string | null; reason: string }[] = [];
    const seenEmail = new Set<string>();
    const seenPhone = new Set<string>();
    const seenInternalPhone = new Set<string>();
    const seenInvgateUserId = new Set<string>();
    const candidates: { row: number; data: BulkImportUserRowDto }[] = [];

    // La fila 1 del Excel original es la de headers, así que la primera fila de datos es la 2.
    dto.rows.forEach((data, i) => {
      const row = i + 2;
      const email = data.email?.trim().toLowerCase();
      if (!email) {
        failed.push({ row, email: null, reason: 'Falta el email' });
        return;
      }
      if (seenEmail.has(email)) {
        failed.push({ row, email, reason: 'Email duplicado en el archivo' });
        return;
      }
      if (data.phone && seenPhone.has(data.phone)) {
        failed.push({ row, email, reason: 'Teléfono duplicado en el archivo' });
        return;
      }
      if (data.internalPhone && seenInternalPhone.has(data.internalPhone)) {
        failed.push({ row, email, reason: 'Interno duplicado en el archivo' });
        return;
      }
      if (data.invgateUserId && seenInvgateUserId.has(data.invgateUserId)) {
        failed.push({ row, email, reason: 'ID de Invgate duplicado en el archivo' });
        return;
      }
      if (!data.firstName?.trim() || !data.lastName?.trim()) {
        failed.push({ row, email, reason: 'Falta nombre o apellido' });
        return;
      }

      seenEmail.add(email);
      if (data.phone) seenPhone.add(data.phone);
      if (data.internalPhone) seenInternalPhone.add(data.internalPhone);
      if (data.invgateUserId) seenInvgateUserId.add(data.invgateUserId);
      candidates.push({ row, data: { ...data, email } });
    });

    // Disponibilidad contra la base, en lote: una query por campo único para todo el archivo,
    // no una por fila — importante para no volar el tiempo de respuesta con 500 filas.
    const phones = candidates.map((c) => c.data.phone).filter((v): v is string => !!v);
    const internalPhones = candidates
      .map((c) => c.data.internalPhone)
      .filter((v): v is string => !!v);
    const invgateUserIds = candidates
      .map((c) => c.data.invgateUserId)
      .filter((v): v is string => !!v);

    const [takenEmails, takenPhones, takenInternalPhones, takenInvgateUserIds] =
      await Promise.all([
        this.prisma.user.findMany({
          where: { email: { in: candidates.map((c) => c.data.email) }, deletedAt: null },
          select: { email: true },
        }),
        phones.length
          ? this.prisma.user.findMany({
              where: { phone: { in: phones }, deletedAt: null },
              select: { phone: true },
            })
          : [],
        internalPhones.length
          ? this.prisma.user.findMany({
              where: { internalPhone: { in: internalPhones }, deletedAt: null },
              select: { internalPhone: true },
            })
          : [],
        invgateUserIds.length
          ? this.prisma.user.findMany({
              where: { invgateUserId: { in: invgateUserIds }, deletedAt: null },
              select: { invgateUserId: true },
            })
          : [],
      ]);

    const takenEmailSet = new Set(takenEmails.map((u) => u.email));
    const takenPhoneSet = new Set(takenPhones.map((u) => u.phone));
    const takenInternalPhoneSet = new Set(takenInternalPhones.map((u) => u.internalPhone));
    const takenInvgateUserIdSet = new Set(takenInvgateUserIds.map((u) => u.invgateUserId));

    const accepted: { row: number; data: BulkImportUserRowDto; tempPassword: string }[] = [];
    for (const c of candidates) {
      if (takenEmailSet.has(c.data.email)) {
        failed.push({ row: c.row, email: c.data.email, reason: 'Ya existe un usuario con ese email' });
      } else if (c.data.phone && takenPhoneSet.has(c.data.phone)) {
        failed.push({ row: c.row, email: c.data.email, reason: 'Ya existe un usuario con ese teléfono' });
      } else if (c.data.internalPhone && takenInternalPhoneSet.has(c.data.internalPhone)) {
        failed.push({ row: c.row, email: c.data.email, reason: 'Ya existe un usuario con ese interno' });
      } else if (c.data.invgateUserId && takenInvgateUserIdSet.has(c.data.invgateUserId)) {
        failed.push({
          row: c.row,
          email: c.data.email,
          reason: 'Ya existe un usuario con ese identificador de Invgate',
        });
      } else {
        accepted.push({ row: c.row, data: c.data, tempPassword: this.generateTempPassword() });
      }
    }

    const created: {
      email: string;
      firstName: string;
      lastName: string;
      tempPassword: string;
    }[] = [];

    if (accepted.length > 0) {
      const withHashes = await Promise.all(
        accepted.map(async (c) => ({
          ...c,
          passwordHash: await bcrypt.hash(c.tempPassword, 10),
        })),
      );

      // `createMany` + un segundo `createMany` para las membresías, no un `create` anidado
      // por fila: con archivos de miles de usuarios, N idas y vueltas secuenciales a la base
      // dentro de una misma transacción se comen el timeout de Prisma (5s por default) mucho
      // antes de terminar. Acá son 3 queries en total, no 2×N.
      await this.prisma.$transaction(
        async (tx) => {
          await tx.user.createMany({
            data: withHashes.map((c) => ({
              email: c.data.email,
              firstName: c.data.firstName,
              lastName: c.data.lastName,
              phone: c.data.phone || null,
              internalPhone: c.data.internalPhone || null,
              invgateUserId: c.data.invgateUserId || null,
              passwordHash: c.passwordHash,
            })),
          });

          const createdUsers = await tx.user.findMany({
            where: { email: { in: withHashes.map((c) => c.data.email) } },
            select: { id: true, email: true },
          });
          const idByEmail = new Map(createdUsers.map((u) => [u.email, u.id]));

          await tx.userTenant.createMany({
            data: withHashes.map((c) => ({
              userId: idByEmail.get(c.data.email)!,
              tenantId,
              roleId: dto.defaultRoleId,
              areaId,
            })),
          });
        },
        { timeout: 30000 },
      );

      created.push(
        ...withHashes.map((c) => ({
          email: c.data.email,
          firstName: c.data.firstName,
          lastName: c.data.lastName,
          tempPassword: c.tempPassword,
        })),
      );
    }

    this.logger.log(
      `Importación masiva en tenant ${tenantId}: ${created.length} creados, ${failed.length} con error (de ${dto.rows.length} filas)`,
    );

    return {
      summary: { total: dto.rows.length, created: created.length, failed: failed.length },
      created,
      failed,
    };
  }

  /** Contraseña temporal legible (no se puede usar acento ni cero/O, que se confunden a mano). */
  private generateTempPassword(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(12);
    let out = '';
    for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  async update(tenantId: string, userId: string, requesterId: string, dto: UpdateUserDto) {
    await this.findOne(tenantId, userId); // valida pertenencia al tenant

    // Rol y área viven los dos en la membresía, así que se actualizan de una sola vez.
    const membership: { roleId?: string; areaId?: string | null } = {};

    if (dto.roleId) {
      await this.assertRoleBelongsToTenant(tenantId, dto.roleId);
      membership.roleId = dto.roleId;
    }

    // Vacío o `null` dejan al usuario sin área; que la clave no venga es "no la toques".
    if (dto.areaId !== undefined) {
      const areaId = dto.areaId || null;
      if (areaId) await this.assertAreaBelongsToTenant(tenantId, areaId);
      membership.areaId = areaId;
    }

    if (Object.keys(membership).length > 0) {
      await this.prisma.userTenant.update({
        where: { userId_tenantId: { userId, tenantId } },
        data: membership,
      });
    }

    if (dto.phone) await this.assertPhoneAvailable(dto.phone, requesterId, userId);
    if (dto.internalPhone) {
      await this.assertInternalPhoneAvailable(dto.internalPhone, requesterId, userId);
    }
    if (dto.invgateUserId) {
      await this.assertInvgateUserIdAvailable(dto.invgateUserId, requesterId, userId);
    }

    const data: Record<string, unknown> = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName;
    if (dto.lastName !== undefined) data.lastName = dto.lastName;
    if (dto.phone !== undefined) data.phone = dto.phone || null;
    if (dto.internalPhone !== undefined) data.internalPhone = dto.internalPhone || null;
    if (dto.invgateUserId !== undefined) {
      data.invgateUserId = dto.invgateUserId || null;
    }
    if (dto.password) data.passwordHash = await bcrypt.hash(dto.password, 10);

    if (Object.keys(data).length > 0) {
      await this.prisma.user.update({ where: { id: userId }, data });
    }

    return this.findOne(tenantId, userId);
  }

  /**
   * Edición multiempresa: sincroniza en una sola operación los datos de la persona y sus
   * membresías en las empresas que `requesterId` administra. `dto.memberships` es el estado
   * FINAL deseado; el servicio calcula el diff contra lo actual y crea, actualiza o da de baja
   * según haga falta.
   *
   * Reglas que respeta:
   *  - Cada operación pide su permiso en ESA empresa: agregar → `users:create`, cambiar
   *    rol/área → `users:update`, dar de baja → `users:delete`. El superusuario puede en todas.
   *  - Solo toca empresas que el editor administra. Una empresa donde la persona es miembro
   *    pero el editor no administra (no está en `memberships` porque ni la ve) NO se da de
   *    baja: se calcula qué quitar solo entre las empresas que el editor podría quitar.
   *  - No te podés dar de baja a vos mismo.
   *  - Si tras las bajas la persona queda sin ninguna empresa, se aplica la misma regla que
   *    `remove`: baja lógica, sin reactivación posible.
   */
  async updateFull(requesterId: string, userId: string, dto: UpdateUserFullDto) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
    });
    if (!user) throw new NotFoundException('El usuario no existe');

    const desired = dto.memberships ?? [];
    const desiredIds = desired.map((m) => m.tenantId);
    if (new Set(desiredIds).size !== desiredIds.length) {
      throw new BadRequestException('Hay empresas repetidas en la selección');
    }

    const isSuper = await this.isSystemSuperUser(requesterId);

    const current = await this.prisma.userTenant.findMany({
      where: { userId },
      select: { tenantId: true, roleId: true, areaId: true },
    });
    const currentByTenant = new Map(current.map((m) => [m.tenantId, m]));

    // Para tocar los datos de la persona (nombre, teléfono, contraseña…) hay que administrarla
    // (`users:update`) en al menos una de sus empresas actuales. Sin esto, cualquiera podría
    // cambiarle los datos mandando sus membresías tal cual —el diff quedaría vacío y no se
    // validaría ningún permiso—. El superusuario puede siempre.
    let canManageThisUser = isSuper;
    for (const c of current) {
      if (canManageThisUser) break;
      canManageThisUser = await this.hasUsersPermissionInTenant(
        requesterId,
        c.tenantId,
        'update',
        isSuper,
      );
    }
    if (!canManageThisUser) {
      throw new ForbiddenException('No tenés permiso para editar a este usuario');
    }

    // Clasificación del diff.
    const toCreate = desired.filter((m) => !currentByTenant.has(m.tenantId));
    const toUpdate = desired.filter((m) => {
      const c = currentByTenant.get(m.tenantId);
      return (
        c && (c.roleId !== m.roleId || (c.areaId ?? null) !== (m.areaId || null))
      );
    });

    // Bajas: solo entre las empresas actuales que el editor puede quitar (`users:delete`) y
    // que ya no están en el estado deseado. Las que no administra no se tocan aunque falten.
    const desiredSet = new Set(desiredIds);
    const toRemove: string[] = [];
    for (const c of current) {
      if (desiredSet.has(c.tenantId)) continue;
      if (await this.hasUsersPermissionInTenant(requesterId, c.tenantId, 'delete', isSuper)) {
        toRemove.push(c.tenantId);
      }
    }

    if (toRemove.length > 0 && userId === requesterId) {
      throw new BadRequestException('No podés darte de baja a vos mismo');
    }

    // Validaciones de permiso, rol y área antes de tocar nada.
    for (const m of toCreate) {
      await this.assertCanManageUsersInTenant(requesterId, m.tenantId, 'create');
      await this.assertRoleBelongsToTenant(m.tenantId, m.roleId);
      if (m.areaId) await this.assertAreaBelongsToTenant(m.tenantId, m.areaId);
    }
    for (const m of toUpdate) {
      await this.assertCanManageUsersInTenant(requesterId, m.tenantId, 'update');
      await this.assertRoleBelongsToTenant(m.tenantId, m.roleId);
      if (m.areaId) await this.assertAreaBelongsToTenant(m.tenantId, m.areaId);
    }

    if (dto.phone) await this.assertPhoneAvailable(dto.phone, requesterId, userId);
    if (dto.internalPhone) {
      await this.assertInternalPhoneAvailable(dto.internalPhone, requesterId, userId);
    }
    if (dto.invgateUserId) {
      await this.assertInvgateUserIdAvailable(dto.invgateUserId, requesterId, userId);
    }

    // El hash se calcula fuera de la transacción para no alargarla.
    const passwordHash = dto.password ? await bcrypt.hash(dto.password, 10) : null;

    await this.prisma.$transaction(async (tx) => {
      for (const m of toCreate) {
        await tx.userTenant.create({
          data: {
            userId,
            tenantId: m.tenantId,
            roleId: m.roleId,
            areaId: m.areaId || null,
          },
        });
      }
      for (const m of toUpdate) {
        await tx.userTenant.update({
          where: { userId_tenantId: { userId, tenantId: m.tenantId } },
          data: { roleId: m.roleId, areaId: m.areaId || null },
        });
      }
      for (const tenantId of toRemove) {
        await tx.userTenant.delete({
          where: { userId_tenantId: { userId, tenantId } },
        });
      }

      const data: Record<string, unknown> = {};
      if (dto.firstName !== undefined) data.firstName = dto.firstName;
      if (dto.lastName !== undefined) data.lastName = dto.lastName;
      if (dto.phone !== undefined) data.phone = dto.phone || null;
      if (dto.internalPhone !== undefined) data.internalPhone = dto.internalPhone || null;
      if (dto.invgateUserId !== undefined) {
        data.invgateUserId = dto.invgateUserId || null;
      }
      if (passwordHash) data.passwordHash = passwordHash;
      if (Object.keys(data).length > 0) {
        await tx.user.update({ where: { id: userId }, data });
      }
    });

    this.logger.log(
      `Usuario ${userId} editado: +${toCreate.length} / ~${toUpdate.length} / -${toRemove.length} empresas`,
    );

    // Si las bajas lo dejaron sin ninguna empresa, se aplica la misma regla que `remove`.
    if (toRemove.length > 0) {
      const pruned = await this.softDeleteIfOrphan(userId);
      if (pruned.outcome === 'soft-deleted') {
        return {
          deleted: true,
          message:
            'Usuario dado de baja de todas sus empresas. No se puede reactivar: para que ' +
            'vuelva hay que darlo de alta de nuevo.',
        };
      }
    }

    return { deleted: false, message: 'Usuario guardado.' };
  }

  /**
   * Da de baja al usuario del tenant activo. Nunca borra la fila: si al quitarle esta membresía
   * queda sin ninguna empresa, se le da de baja lógica (`deletedAt` + sufijo). Su historial
   * —conversaciones, tickets y métricas— sigue apuntando a la misma fila, así que la auditoría
   * queda intacta, pero la persona deja de existir para el sistema y no se puede reactivar.
   */
  async remove(tenantId: string, userId: string, requesterId: string) {
    if (userId === requesterId) {
      throw new BadRequestException('No podés darte de baja a vos mismo');
    }

    await this.findOne(tenantId, userId);

    await this.prisma.userTenant.delete({
      where: { userId_tenantId: { userId, tenantId } },
    });

    const result = await this.softDeleteIfOrphan(userId);
    if (result.outcome === 'still-member') {
      return {
        deleted: false,
        message: 'Usuario dado de baja de este tenant. Sigue activo en otros tenants.',
      };
    }

    const history = result.conversations + result.tickets + result.metrics;
    return {
      deleted: true,
      message:
        'Usuario dado de baja. No pertenece a ninguna empresa y no se puede reactivar: ' +
        'para que vuelva hay que darlo de alta de nuevo.' +
        (history > 0
          ? ` Se conserva su historial (${result.conversations} conversaciones, ${result.tickets} tickets, ${result.metrics} métricas).`
          : ''),
    };
  }

  /**
   * Tras quitarle a un usuario una o más membresías, decide el destino de su registro: si
   * todavía pertenece a alguna empresa se conserva tal cual (`still-member`); si quedó sin
   * ninguna, se le da de baja lógica (`soft-deleted`). Compartido por `remove` (baja de una
   * empresa) y `updateFull` (edición multiempresa), que arman su propio mensaje según el caso.
   *
   * Ya no existe el borrado físico: antes se borraba la fila cuando la persona no había dejado
   * historial, y se conservaba si lo había. Ahora la fila se conserva siempre —el historial la
   * referencia igual— y el conteo se sigue devolviendo solo para informarlo al operador.
   */
  private async softDeleteIfOrphan(userId: string): Promise<
    | { outcome: 'still-member' }
    | {
        outcome: 'soft-deleted';
        conversations: number;
        tickets: number;
        metrics: number;
      }
  > {
    const remaining = await this.prisma.userTenant.count({ where: { userId } });
    if (remaining > 0) return { outcome: 'still-member' };

    const [conversations, tickets, metrics] = await Promise.all([
      this.prisma.conversation.count({ where: { userId } }),
      this.prisma.ticket.count({ where: { userId } }),
      this.prisma.metric.count({ where: { userId } }),
    ]);

    await this.softDeleteUser(userId);
    return { outcome: 'soft-deleted', conversations, tickets, metrics };
  }

  /**
   * Baja lógica de la persona: marca `deletedAt` y le agrega el sufijo de fecha y hora al
   * nombre, al apellido y a los cuatro campos únicos (email, teléfono, interno, identificador
   * de Invgate).
   *
   * Sufijar los únicos es lo que hace posible el requisito del producto: que esos mismos datos
   * se puedan volver a usar en un alta nueva. No hay reactivación — quien vuelve, vuelve como
   * una persona nueva, sin el historial de la anterior.
   *
   * Los campos opcionales solo se tocan si tenían valor: no tiene sentido inventarle un
   * teléfono "_20260811-143205" a alguien que nunca tuvo teléfono.
   */
  private async softDeleteUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        internalPhone: true,
        invgateUserId: true,
        firstName: true,
        lastName: true,
        deletedAt: true,
      },
    });
    if (!user || user.deletedAt) return;

    const now = new Date();
    const suffix = await this.availableSuffix(user, deletionSuffix(now));

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: now,
        email: `${user.email}${suffix}`,
        phone: user.phone ? `${user.phone}${suffix}` : null,
        internalPhone: user.internalPhone ? `${user.internalPhone}${suffix}` : null,
        invgateUserId: user.invgateUserId
          ? `${user.invgateUserId}${suffix}`
          : null,
        firstName: user.firstName ? `${user.firstName}${suffix}` : user.firstName,
        lastName: user.lastName ? `${user.lastName}${suffix}` : user.lastName,
      },
    });

    this.logger.log(`Usuario ${userId} dado de baja (baja lógica, sufijo ${suffix})`);
  }

  /**
   * El sufijo a usar, garantizando que ninguno de los cuatro campos únicos choque.
   *
   * El sufijo tiene resolución de un segundo, así que dos bajas del mismo email en el mismo
   * segundo producirían el mismo valor y la segunda fallaría contra la constraint. Es un caso
   * rarísimo —requiere dar de alta y de baja la misma persona dos veces dentro del mismo
   * segundo—, pero como el precio de cubrirlo es una consulta, se cubre: si hay choque, se le
   * agrega el id del usuario, que es único por definición.
   */
  private async availableSuffix(
    user: {
      id: string;
      email: string;
      phone: string | null;
      internalPhone: string | null;
      invgateUserId: string | null;
    },
    suffix: string,
  ): Promise<string> {
    const taken = await this.prisma.user.findFirst({
      where: {
        id: { not: user.id },
        OR: [
          { email: `${user.email}${suffix}` },
          ...(user.phone ? [{ phone: `${user.phone}${suffix}` }] : []),
          ...(user.internalPhone
            ? [{ internalPhone: `${user.internalPhone}${suffix}` }]
            : []),
          ...(user.invgateUserId
            ? [{ invgateUserId: `${user.invgateUserId}${suffix}` }]
            : []),
        ],
      },
      select: { id: true },
    });

    return taken ? `${suffix}-${user.id}` : suffix;
  }

  // --- Usado por el orquestador de conversaciones (canal WhatsApp) ---

  /**
   * Busca si el teléfono pertenece a un usuario REGISTRADO en este tenant (con un
   * rol asignado vía `UserTenant`) — no simplemente si existe una fila en `User`.
   *
   * La diferencia importa: cualquier número que escribe por WhatsApp termina con
   * una fila en `User` (ver `findOrCreateByPhone`, más abajo), así que "¿existe un
   * User con este teléfono?" siempre da que sí apenas alguien escribe una vez, y
   * nunca sirve para distinguir un número conocido de uno nuevo. "Conocido" tiene
   * que significar "está registrado acá, con un rol", no "ya nos escribió antes".
   */
  async findMembershipByPhone(phone: string, tenantId: string) {
    return this.prisma.userTenant.findFirst({
      where: { tenantId, user: { phone, deletedAt: null } },
      include: {
        user: { select: USER_SELECT },
        role: { select: { id: true, name: true } },
      },
    });
  }

  async findByPhone(phone: string) {
    return this.prisma.user.findFirst({ where: { phone, deletedAt: null } });
  }

  /**
   * Si el número perteneció a alguien dado de baja, su teléfono quedó sufijado y este `findFirst`
   * no lo encuentra: se crea un contacto nuevo. Es lo esperado — la persona que vuelve arranca
   * sin el historial de la anterior.
   */
  async findOrCreateByPhone(phone: string, firstName?: string) {
    let user = await this.prisma.user.findFirst({
      where: { phone, deletedAt: null },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email: `whatsapp-${phone}@local.pci`,
          phone,
          firstName: firstName || 'Usuario',
          lastName: 'WhatsApp',
          passwordHash: await bcrypt.hash(Math.random().toString(36), 10),
        },
      });
    }

    return user;
  }

  // --- helpers ---

  /**
   * `true` si el usuario es el superusuario del sistema (miembro del tenant de sistema con el
   * rol protegido). Mismo criterio que `RolesGuard`, pero resuelto por userId porque acá no
   * hay un vínculo ya resuelto por `TenantGuard`.
   */
  private async isSystemSuperUser(userId: string): Promise<boolean> {
    const systemSlug = systemTenantSlug(this.config);
    const membership = await this.prisma.userTenant.findFirst({
      where: { userId, tenant: { slug: systemSlug } },
      include: {
        role: { select: { name: true, tenant: { select: { slug: true } } } },
      },
    });
    if (!membership) return false;
    return isProtectedRole(membership.role.name, membership.role.tenant.slug, systemSlug);
  }

  /**
   * `true` si el usuario puede hacer la acción de usuarios pedida en esa empresa. Versión
   * booleana de `assertCanManageUsersInTenant`, para cuando hay que decidir por empresa sin
   * cortar (poblar el editor, calcular el diff de bajas). `isSuper` se puede pasar ya resuelto
   * para no repetir la consulta del rol de sistema una vez por empresa.
   */
  private async hasUsersPermissionInTenant(
    userId: string,
    tenantId: string,
    action: 'read' | 'create' | 'update' | 'delete',
    isSuper?: boolean,
  ): Promise<boolean> {
    if (isSuper ?? (await this.isSystemSuperUser(userId))) return true;

    // `tenant: { deletedAt: null }` — mismo criterio que TenantGuard: una empresa dada de
    // baja no cuenta como membresía operable, aunque el UserTenant siga en la base.
    const membership = await this.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId, tenantId }, tenant: { deletedAt: null } },
      include: {
        role: { select: { permissions: { select: { resource: true, action: true } } } },
      },
    });
    return (
      !!membership &&
      membership.role.permissions.some(
        (p) => p.resource === 'users' && p.action === action,
      )
    );
  }

  /**
   * Corta si el usuario no puede administrar usuarios en esta empresa. El superusuario del
   * sistema puede en cualquiera; el resto, solo en las empresas donde es miembro y su rol
   * tiene el permiso pedido.
   *
   * Es el equivalente por-empresa de la cadena `TenantGuard` + `RolesGuard`, necesario acá
   * porque el alta multiempresa recibe las empresas destino en el body (no en el header), así
   * que los guards no pueden validarlas.
   */
  private async assertCanManageUsersInTenant(
    userId: string,
    tenantId: string,
    action: 'create' | 'update' | 'delete',
  ) {
    if (await this.isSystemSuperUser(userId)) return;

    // `tenant: { deletedAt: null }` — mismo criterio que TenantGuard: una empresa dada de
    // baja no cuenta como membresía operable, aunque el UserTenant siga en la base.
    const membership = await this.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId, tenantId }, tenant: { deletedAt: null } },
      include: {
        role: { select: { permissions: { select: { resource: true, action: true } } } },
      },
    });
    if (!membership) {
      throw new ForbiddenException('No pertenecés a alguna de las empresas seleccionadas');
    }
    const allowed = membership.role.permissions.some(
      (p) => p.resource === 'users' && p.action === action,
    );
    if (!allowed) {
      throw new ForbiddenException(
        'No tenés permiso para administrar usuarios en alguna de las empresas seleccionadas',
      );
    }
  }

  /** El rol tiene que existir y pertenecer al tenant: si no, se filtra RBAC entre tenants. */
  private async assertRoleBelongsToTenant(tenantId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, tenantId } });
    if (!role) {
      throw new BadRequestException('El rol no existe o no pertenece a este tenant');
    }
  }

  /** Mismo criterio que el rol: un área de otra empresa no se puede asignar acá. */
  private async assertAreaBelongsToTenant(tenantId: string, areaId: string) {
    const area = await this.prisma.area.findFirst({ where: { id: areaId, tenantId } });
    if (!area) {
      throw new BadRequestException('El área no existe o no pertenece a este tenant');
    }
  }

  /**
   * El email lo tiene que tener libre alguien ACTIVO. Igual que el teléfono y el identificador
   * de Invgate, es un campo único de todo el sistema; un usuario dado de baja tiene el email
   * sufijado, así que no bloquea un alta nueva.
   */
  private async assertEmailAvailable(
    email: string,
    requesterId: string,
    exceptUserId?: string,
  ) {
    const owner = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });
    if (owner && owner.id !== exceptUserId) {
      throw new ConflictException(
        await this.conflictBody('Ya existe un usuario con ese email', 'email', owner.id, requesterId),
      );
    }
  }

  /**
   * El teléfono lo tiene que tener libre alguien ACTIVO: los dados de baja lo tienen sufijado,
   * así que ni siquiera coinciden, y el filtro deja explícito que no bloquean un alta nueva.
   */
  private async assertPhoneAvailable(
    phone: string,
    requesterId: string,
    exceptUserId?: string,
  ) {
    const owner = await this.prisma.user.findFirst({
      where: { phone, deletedAt: null },
      select: { id: true },
    });
    if (owner && owner.id !== exceptUserId) {
      throw new ConflictException(
        await this.conflictBody('Ya existe un usuario con ese teléfono', 'phone', owner.id, requesterId),
      );
    }
  }

  /**
   * El interno lo tiene que tener libre alguien ACTIVO. Mismo criterio que el teléfono: un
   * usuario dado de baja lo tiene sufijado, así que ni coincide ni bloquea un alta nueva.
   */
  private async assertInternalPhoneAvailable(
    internalPhone: string,
    requesterId: string,
    exceptUserId?: string,
  ) {
    const owner = await this.prisma.user.findFirst({
      where: { internalPhone, deletedAt: null },
      select: { id: true },
    });
    if (owner && owner.id !== exceptUserId) {
      throw new ConflictException(
        await this.conflictBody('Ya existe un usuario con ese interno', 'internalPhone', owner.id, requesterId),
      );
    }
  }

  /**
   * El identificador de Invgate es único entre los usuarios activos. Se valida acá y no solo
   * con la constraint de la base para devolver un 409 con un mensaje entendible en vez del
   * error crudo de Prisma. Mismo criterio que el teléfono: un usuario dado de baja no lo
   * retiene.
   */
  private async assertInvgateUserIdAvailable(
    invgateUserId: string,
    requesterId: string,
    exceptUserId?: string,
  ) {
    const owner = await this.prisma.user.findFirst({
      where: { invgateUserId, deletedAt: null },
      select: { id: true },
    });
    if (owner && owner.id !== exceptUserId) {
      throw new ConflictException(
        await this.conflictBody(
          'Ya existe un usuario con ese identificador de Invgate',
          'invgateUserId',
          owner.id,
          requesterId,
        ),
      );
    }
  }

  // --- Conflictos de campos globales (quién ocupa un dato único) ---

  /**
   * Verifica si un campo global (email, teléfono, interno o identificador de Invgate) está
   * disponible. Lo usa el formulario del backoffice para avisar en vivo, antes de guardar. El guardado
   * revalida igual con los `assert*` de arriba: este chequeo es solo experiencia de usuario.
   *
   * Es un dato sensible (permite saber si un valor ya existe en el sistema), así que solo
   * responde a quien puede gestionar usuarios en alguna empresa (o al superusuario). La
   * identidad del ocupante se revela según la misma visibilidad que el resto: solo si quien
   * pregunta comparte con él una empresa que administra.
   */
  async checkAvailability(
    requesterId: string,
    field: 'email' | 'phone' | 'invgateUserId' | 'internalPhone',
    value: string,
    excludeUserId?: string,
  ) {
    const isSuper = await this.isSystemSuperUser(requesterId);
    if (!isSuper && !(await this.canManageUsersAnywhere(requesterId))) {
      throw new ForbiddenException('No tenés permiso para verificar datos de usuarios');
    }

    const trimmed = (value ?? '').trim();
    if (!trimmed) return { available: true, field, conflict: null };

    const owner = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        ...(field === 'email'
          ? { email: trimmed }
          : field === 'phone'
            ? { phone: trimmed }
            : field === 'internalPhone'
              ? { internalPhone: trimmed }
              : { invgateUserId: trimmed }),
      },
      select: { id: true },
    });

    if (!owner || owner.id === excludeUserId) {
      return { available: true, field, conflict: null };
    }

    return {
      available: false,
      field,
      conflict: await this.describeConflict(owner.id, requesterId, isSuper),
    };
  }

  /**
   * Cuerpo del 409 de "campo global en uso": además del mensaje legible lleva el `field` que
   * chocó —para que el frontend lo muestre debajo del campo correcto— y la descripción del
   * usuario que lo ocupa (nombre e id solo si quien pregunta puede verlo).
   */
  private async conflictBody(
    message: string,
    field: 'email' | 'phone' | 'invgateUserId' | 'internalPhone',
    ownerId: string,
    requesterId: string,
    isSuper?: boolean,
  ) {
    return {
      message,
      field,
      conflict: await this.describeConflict(ownerId, requesterId, isSuper),
    };
  }

  /**
   * Quién ocupa un dato global. La unicidad es de todo el sistema, pero ver a una persona es
   * por empresa: si quien pregunta no comparte ninguna empresa visible con el dueño (ni es
   * superusuario), no se le revela su identidad —solo que el dato está en uso—.
   */
  private async describeConflict(ownerId: string, requesterId: string, isSuper?: boolean) {
    const canView = await this.canViewUser(requesterId, ownerId, isSuper);
    if (!canView) return { canView: false, userId: null, name: null };

    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { firstName: true, lastName: true, email: true },
    });
    const name = owner
      ? [owner.firstName, owner.lastName].filter(Boolean).join(' ') || owner.email
      : null;
    return { canView: true, userId: ownerId, name };
  }

  /**
   * `true` si `requesterId` puede ver a `ownerId`: el superusuario ve a todos; el resto, solo
   * si comparte con esa persona alguna empresa donde tenga `users:read`. Mismo criterio de
   * visibilidad que `findMembershipsForEditor`.
   */
  private async canViewUser(
    requesterId: string,
    ownerId: string,
    isSuper?: boolean,
  ): Promise<boolean> {
    if (isSuper ?? (await this.isSystemSuperUser(requesterId))) return true;

    const ownerTenants = await this.prisma.userTenant.findMany({
      where: { userId: ownerId },
      select: { tenantId: true },
    });
    for (const t of ownerTenants) {
      if (await this.hasUsersPermissionInTenant(requesterId, t.tenantId, 'read')) {
        return true;
      }
    }
    return false;
  }

  /** `true` si el usuario puede crear o actualizar usuarios en alguna de sus empresas. */
  private async canManageUsersAnywhere(userId: string): Promise<boolean> {
    const memberships = await this.prisma.userTenant.findMany({
      where: { userId },
      include: {
        role: { select: { permissions: { select: { resource: true, action: true } } } },
      },
    });
    return memberships.some((m) =>
      m.role.permissions.some(
        (p) => p.resource === 'users' && (p.action === 'create' || p.action === 'update'),
      ),
    );
  }
}
