import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateSkillDto, UpdateSkillDto } from './dto/skill.dto';

/**
 * Skills: texto de contexto libre que se concatena al system prompt base
 * (LLM_SYSTEM_PROMPT de /settings) según qué skill tenga seleccionado el flujo en
 * curso — ver `ConversationsService.buildBasePrompt` y `Flow.skillId`.
 *
 * A diferencia de ContextSource (conexión a un servicio externo que se consulta en
 * tiempo real), acá no hay red ni broker: es texto estático guardado en la fila.
 *
 * Toda operación está scopeada por el tenant activo, que sale del header y no del
 * body — mismo criterio que Areas y ContextSource.
 */
@Injectable()
export class SkillsService {
  private readonly logger = new Logger(SkillsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string) {
    return this.prisma.skill.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Skills de TODAS las empresas (vista consolidada "Todas las empresas" del superadmin).
   * Cross-tenant → `SystemTenantGuard` en el controller. Incluye la empresa de cada fila
   * para la columna "Empresa". Espejo de `AreasService.findAllCrossTenant`.
   */
  async findAllCrossTenant() {
    return this.prisma.skill.findMany({
      where: { tenant: { deletedAt: null } },
      orderBy: [{ tenant: { name: 'asc' } }, { name: 'asc' }],
      include: { tenant: { select: { id: true, name: true, slug: true } } },
    });
  }

  /**
   * Skills de TODAS las empresas del propio usuario (vista "Todas mis empresas" del usuario
   * común). Acotado a las empresas donde su rol tiene `skills:read`. Espejo de
   * `AreasService.findMine`.
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
        m.role.permissions.some((p) => p.resource === 'skills' && p.action === 'read'),
      )
      .map((m) => m.tenantId);

    if (readableTenantIds.length === 0) return [];

    return this.prisma.skill.findMany({
      where: { tenantId: { in: readableTenantIds } },
      orderBy: [{ tenant: { name: 'asc' } }, { name: 'asc' }],
      include: { tenant: { select: { id: true, name: true, slug: true } } },
    });
  }

  async findOne(tenantId: string, id: string) {
    return this.getOwned(tenantId, id);
  }

  async create(tenantId: string, dto: CreateSkillDto) {
    const name = dto.name.trim();
    await this.assertNameAvailable(tenantId, name);

    const skill = await this.prisma.skill.create({
      data: {
        tenantId,
        name,
        promptText: dto.promptText,
        isActive: dto.isActive ?? true,
      },
    });
    this.logger.log(`Skill creado: ${skill.name} en tenant ${tenantId}`);
    return skill;
  }

  async update(tenantId: string, id: string, dto: UpdateSkillDto) {
    await this.getOwned(tenantId, id);

    const data: { name?: string; promptText?: string; isActive?: boolean } = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      await this.assertNameAvailable(tenantId, name, id);
      data.name = name;
    }
    if (dto.promptText !== undefined) data.promptText = dto.promptText;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    return this.prisma.skill.update({ where: { id }, data });
  }

  /**
   * A diferencia de ContextSource, borrar un skill en uso no bloquea: `Flow.skillId`
   * tiene `onDelete: SetNull`, así que el flujo simplemente se queda sin skill (mismo
   * efecto que desvincularlo a mano desde el editor). Bloquear acá obligaría a un paso
   * extra sin ganancia real — el skill es texto de apoyo, no una credencial ni una
   * integración que dejaría de funcionar silenciosamente.
   */
  async remove(tenantId: string, id: string) {
    const skill = await this.getOwned(tenantId, id);
    await this.prisma.skill.delete({ where: { id } });
    this.logger.log(`Skill eliminado: ${skill.name} (tenant ${tenantId})`);
    return { deleted: true, message: 'Skill eliminado.' };
  }

  // --- helpers ---

  private async getOwned(tenantId: string, id: string) {
    const skill = await this.prisma.skill.findFirst({ where: { id, tenantId } });
    if (!skill) throw new NotFoundException('El skill no existe en este tenant');
    return skill;
  }

  /** Mismo criterio que AreasService/ContextSourcesService.assertNameAvailable. */
  private async assertNameAvailable(tenantId: string, name: string, exceptId?: string) {
    const existing = await this.prisma.skill.findFirst({
      where: {
        tenantId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });
    if (existing) {
      throw new ConflictException('Ya existe un skill con ese nombre en este tenant');
    }
  }
}
