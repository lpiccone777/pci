import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import * as bcrypt from 'bcrypt';

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Usuarios del tenant activo, con el rol que tienen *en ese* tenant. */
  async findAll(tenantId: string) {
    const memberships = await this.prisma.userTenant.findMany({
      where: { tenantId },
      include: {
        user: { select: USER_SELECT },
        role: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((m) => ({
      ...m.user,
      role: m.role,
      joinedAt: m.createdAt,
    }));
  }

  async findOne(tenantId: string, userId: string) {
    const membership = await this.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      include: {
        user: { select: USER_SELECT },
        role: { select: { id: true, name: true } },
      },
    });

    if (!membership) {
      throw new NotFoundException('El usuario no existe en este tenant');
    }

    return { ...membership.user, role: membership.role, joinedAt: membership.createdAt };
  }

  async create(tenantId: string, dto: CreateUserDto) {
    await this.assertRoleBelongsToTenant(tenantId, dto.roleId);

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
        data: { userId: existing.id, tenantId, roleId: dto.roleId },
      });
      this.logger.log(`Usuario existente ${existing.email} agregado al tenant ${tenantId}`);
      return this.findOne(tenantId, existing.id);
    }

    if (dto.phone) await this.assertPhoneAvailable(dto.phone);

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone || null,
        passwordHash,
        tenants: {
          create: { tenantId, roleId: dto.roleId },
        },
      },
    });

    this.logger.log(`Usuario creado: ${user.email} en tenant ${tenantId}`);
    return this.findOne(tenantId, user.id);
  }

  async update(tenantId: string, userId: string, dto: UpdateUserDto) {
    await this.findOne(tenantId, userId); // valida pertenencia al tenant

    if (dto.roleId) {
      await this.assertRoleBelongsToTenant(tenantId, dto.roleId);
      await this.prisma.userTenant.update({
        where: { userId_tenantId: { userId, tenantId } },
        data: { roleId: dto.roleId },
      });
    }

    if (dto.phone) await this.assertPhoneAvailable(dto.phone, userId);

    const data: Record<string, unknown> = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName;
    if (dto.lastName !== undefined) data.lastName = dto.lastName;
    if (dto.phone !== undefined) data.phone = dto.phone || null;
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

  private async assertPhoneAvailable(phone: string, exceptUserId?: string) {
    const owner = await this.prisma.user.findUnique({ where: { phone } });
    if (owner && owner.id !== exceptUserId) {
      throw new ConflictException('Ya existe un usuario con ese teléfono');
    }
  }
}
