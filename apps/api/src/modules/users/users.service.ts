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
  CreateUserDto,
  CreateUserMultiTenantDto,
  UpdateUserDto,
  UpdateUserFullDto,
} from './dto/user.dto';
import * as bcrypt from 'bcrypt';

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  invgateUserId: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Usuarios del tenant activo, con el rol y el área que tienen *en ese* tenant. */
  async findAll(tenantId: string) {
    const memberships = await this.prisma.userTenant.findMany({
      where: { tenantId },
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
      where: { tenantId: { in: readableTenantIds } },
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

  async findOne(tenantId: string, userId: string) {
    const membership = await this.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
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
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
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

    return { ...user, memberships: visible };
  }

  async create(tenantId: string, dto: CreateUserDto) {
    await this.assertRoleBelongsToTenant(tenantId, dto.roleId);

    const areaId = dto.areaId || null;
    if (areaId) await this.assertAreaBelongsToTenant(tenantId, areaId);

    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });

    if (existing) {
      // El email ya existe en el sistema. Puede ser alguien de otro tenant que
      // ahora también trabaja acá: en ese caso solo agregamos la membresía.
      const alreadyHere = await this.prisma.userTenant.findUnique({
        where: { userId_tenantId: { userId: existing.id, tenantId } },
      });
      if (alreadyHere) {
        throw new ConflictException('Ya existe un usuario con ese email en este tenant');
      }

      await this.prisma.userTenant.create({
        data: { userId: existing.id, tenantId, roleId: dto.roleId, areaId },
      });

      // El identificador de Invgate es de la persona, no de la membresía, y quien la
      // suma acá puede ser el primero en conocerlo. Si el usuario todavía no lo tiene,
      // lo guardamos; si ya lo tiene, no lo pisamos: dar de alta a alguien en un tenant
      // no es motivo para cambiarle un dato que otro cargó. Sin esto, el campo se
      // completaba en el formulario y se perdía en silencio.
      if (dto.invgateUserId && !existing.invgateUserId) {
        await this.assertInvgateUserIdAvailable(dto.invgateUserId, existing.id);
        await this.prisma.user.update({
          where: { id: existing.id },
          data: { invgateUserId: dto.invgateUserId },
        });
      }

      this.logger.log(`Usuario existente ${existing.email} agregado al tenant ${tenantId}`);
      return this.findOne(tenantId, existing.id);
    }

    if (dto.phone) await this.assertPhoneAvailable(dto.phone);
    if (dto.invgateUserId) await this.assertInvgateUserIdAvailable(dto.invgateUserId);

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone || null,
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
   * tocar nada, y crea el usuario y las N membresías de forma atómica. Si el email ya existe,
   * suma las membresías que falten en vez de crear la persona de nuevo — mismo criterio que
   * `create` con un solo tenant.
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

    if (dto.phone) await this.assertPhoneAvailable(dto.phone);
    if (dto.invgateUserId) await this.assertInvgateUserIdAvailable(dto.invgateUserId);

    const membershipData = dto.memberships.map((m) => ({
      tenantId: m.tenantId,
      roleId: m.roleId,
      areaId: m.areaId || null,
    }));

    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });

    if (existing) {
      // El email ya existe: sumamos solo las membresías nuevas. Si ya es miembro de alguna
      // de las empresas elegidas, cortamos entero (no dar de alta a medias).
      const already = await this.prisma.userTenant.findMany({
        where: { userId: existing.id, tenantId: { in: tenantIds } },
        select: { tenantId: true },
      });
      if (already.length > 0) {
        throw new ConflictException(
          'La persona ya es miembro de alguna de las empresas seleccionadas',
        );
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.userTenant.createMany({
          data: membershipData.map((m) => ({ ...m, userId: existing.id })),
        });
        // El ID de Invgate es de la persona: si todavía no lo tenía, lo completamos sin pisar.
        if (dto.invgateUserId && !existing.invgateUserId) {
          await tx.user.update({
            where: { id: existing.id },
            data: { invgateUserId: dto.invgateUserId },
          });
        }
      });

      this.logger.log(
        `Usuario existente ${existing.email} agregado a ${membershipData.length} empresas`,
      );
      return {
        userId: existing.id,
        email: existing.email,
        created: false,
        memberships: membershipData.length,
      };
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    // La persona nueva + todas sus membresías en una sola operación: atómica por sí misma.
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone || null,
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

  async update(tenantId: string, userId: string, dto: UpdateUserDto) {
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

    if (dto.phone) await this.assertPhoneAvailable(dto.phone, userId);
    if (dto.invgateUserId) {
      await this.assertInvgateUserIdAvailable(dto.invgateUserId, userId);
    }

    const data: Record<string, unknown> = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName;
    if (dto.lastName !== undefined) data.lastName = dto.lastName;
    if (dto.phone !== undefined) data.phone = dto.phone || null;
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
   *    `remove`: se borra el registro solo si no dejó historial.
   */
  async updateFull(requesterId: string, userId: string, dto: UpdateUserFullDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
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

    if (dto.phone) await this.assertPhoneAvailable(dto.phone, userId);
    if (dto.invgateUserId) {
      await this.assertInvgateUserIdAvailable(dto.invgateUserId, userId);
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
      const pruned = await this.pruneUserIfOrphan(userId);
      if (pruned.outcome === 'deleted') {
        return { deleted: true, message: 'Usuario dado de baja de todas sus empresas.' };
      }
    }

    return { deleted: false, message: 'Usuario guardado.' };
  }

  /**
   * Da de baja al usuario del tenant activo. No es un borrado físico salvo que el
   * usuario quede sin ningún tenant y sin historial: sus conversaciones, tickets y
   * métricas lo referencian y perderlas rompería la auditoría.
   */
  async remove(tenantId: string, userId: string, requesterId: string) {
    if (userId === requesterId) {
      throw new BadRequestException('No podés darte de baja a vos mismo');
    }

    await this.findOne(tenantId, userId);

    await this.prisma.userTenant.delete({
      where: { userId_tenantId: { userId, tenantId } },
    });

    const result = await this.pruneUserIfOrphan(userId);
    switch (result.outcome) {
      case 'still-member':
        return {
          deleted: false,
          message: 'Usuario dado de baja de este tenant. Sigue activo en otros tenants.',
        };
      case 'kept-history':
        return {
          deleted: false,
          message:
            'Usuario dado de baja. No se eliminó el registro porque tiene historial ' +
            `(${result.conversations} conversaciones, ${result.tickets} tickets, ${result.metrics} métricas).`,
        };
      case 'deleted':
        return { deleted: true, message: 'Usuario eliminado.' };
    }
  }

  /**
   * Tras quitarle a un usuario una o más membresías, decide el destino de su registro: si
   * todavía pertenece a alguna empresa (`still-member`), o dejó historial (`kept-history`:
   * conversaciones / tickets / métricas), se conserva; solo se borra (`deleted`) cuando quedó
   * sin empresas Y sin historial. Compartido por `remove` (baja de una empresa) y `updateFull`
   * (edición multiempresa), que arman su propio mensaje según el caso.
   */
  private async pruneUserIfOrphan(userId: string): Promise<
    | { outcome: 'still-member' }
    | { outcome: 'kept-history'; conversations: number; tickets: number; metrics: number }
    | { outcome: 'deleted' }
  > {
    const remaining = await this.prisma.userTenant.count({ where: { userId } });
    if (remaining > 0) return { outcome: 'still-member' };

    const [conversations, tickets, metrics] = await Promise.all([
      this.prisma.conversation.count({ where: { userId } }),
      this.prisma.ticket.count({ where: { userId } }),
      this.prisma.metric.count({ where: { userId } }),
    ]);

    if (conversations + tickets + metrics > 0) {
      return { outcome: 'kept-history', conversations, tickets, metrics };
    }

    await this.prisma.user.delete({ where: { id: userId } });
    this.logger.log(`Usuario ${userId} eliminado (sin tenants ni historial)`);
    return { outcome: 'deleted' };
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
      where: { tenantId, user: { phone } },
      include: {
        user: { select: USER_SELECT },
        role: { select: { id: true, name: true } },
      },
    });
  }

  async findByPhone(phone: string) {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  async findOrCreateByPhone(phone: string, firstName?: string) {
    let user = await this.prisma.user.findUnique({ where: { phone } });

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

    const membership = await this.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
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

    const membership = await this.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
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

  private async assertPhoneAvailable(phone: string, exceptUserId?: string) {
    const owner = await this.prisma.user.findUnique({ where: { phone } });
    if (owner && owner.id !== exceptUserId) {
      throw new ConflictException('Ya existe un usuario con ese teléfono');
    }
  }

  /**
   * El identificador de Invgate es único en el sistema. Se valida acá y no solo con la
   * constraint de la base para devolver un 409 con un mensaje entendible en vez del
   * error crudo de Prisma.
   */
  private async assertInvgateUserIdAvailable(invgateUserId: string, exceptUserId?: string) {
    const owner = await this.prisma.user.findUnique({ where: { invgateUserId } });
    if (owner && owner.id !== exceptUserId) {
      throw new ConflictException('Ya existe un usuario con ese identificador de Invgate');
    }
  }
}
