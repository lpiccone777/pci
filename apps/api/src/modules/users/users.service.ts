import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateUserDto,
  CreateUserMultiTenantDto,
  UpdateUserDto,
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

  constructor(private readonly prisma: PrismaService) {}

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
   * Alta de una persona en varias empresas a la vez (solo superadmin — lo gatea el
   * controlador con `SystemTenantGuard`). Un rol y, opcional, un área por empresa.
   *
   * Es la generalización de `create`: valida rol y área de CADA empresa antes de tocar
   * nada, y crea el usuario y las N membresías de forma atómica. Si el email ya existe,
   * suma las membresías que falten en vez de crear la persona de nuevo — mismo criterio
   * que `create` con un solo tenant.
   */
  async createMultiTenant(dto: CreateUserMultiTenantDto) {
    const tenantIds = dto.memberships.map((m) => m.tenantId);
    if (new Set(tenantIds).size !== tenantIds.length) {
      throw new BadRequestException('Hay empresas repetidas en la selección');
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

    const remaining = await this.prisma.userTenant.count({ where: { userId } });
    if (remaining > 0) {
      return {
        deleted: false,
        message: 'Usuario dado de baja de este tenant. Sigue activo en otros tenants.',
      };
    }

    // Sin tenants: lo borramos del todo solo si no dejó historial.
    const [conversations, tickets, metrics] = await Promise.all([
      this.prisma.conversation.count({ where: { userId } }),
      this.prisma.ticket.count({ where: { userId } }),
      this.prisma.metric.count({ where: { userId } }),
    ]);

    if (conversations + tickets + metrics > 0) {
      return {
        deleted: false,
        message:
          'Usuario dado de baja. No se eliminó el registro porque tiene historial ' +
          `(${conversations} conversaciones, ${tickets} tickets, ${metrics} métricas).`,
      };
    }

    await this.prisma.user.delete({ where: { id: userId } });
    this.logger.log(`Usuario ${userId} eliminado (sin tenants ni historial)`);
    return { deleted: true, message: 'Usuario eliminado.' };
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
