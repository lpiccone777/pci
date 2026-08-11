import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAreaDto, UpdateAreaDto } from './dto/area.dto';

/**
 * Áreas: agrupación de usuarios dentro de una empresa, para auditoría y métricas.
 *
 * No participa del motor de flujos IVR — ese decide por rol. Si algún día un flujo
 * necesita mirar el área, va a haber que sumarla a `identity` en
 * `ConversationsService.handleMessage`, no consultarla desde adentro de un nodo.
 *
 * Toda operación está scopeada por el tenant activo, que sale del header y no del body.
 */
@Injectable()
export class AreasService {
  private readonly logger = new Logger(AreasService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Áreas del tenant activo, con cuántos usuarios tiene asignados cada una. */
  async findAll(tenantId: string) {
    const areas = await this.prisma.area.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { userTenants: true } } },
    });

    return areas.map(({ _count, ...area }) => ({
      ...area,
      userCount: _count.userTenants,
    }));
  }

  /**
   * Áreas de TODAS las empresas, con la empresa a la que pertenece cada una. Es el modo
   * lectura del superadmin ("Todas las empresas"): mismo mapeo que `findAll` pero sin scope
   * de tenant y sumando `tenant` para la columna Empresa. El corte de acceso lo pone
   * `SystemTenantGuard` en el controlador, no este método.
   */
  async findAllCrossTenant() {
    const areas = await this.prisma.area.findMany({
      orderBy: [{ tenant: { name: 'asc' } }, { name: 'asc' }],
      include: {
        tenant: { select: { id: true, name: true, slug: true } },
        _count: { select: { userTenants: true } },
      },
    });

    return areas.map(({ _count, ...area }) => ({
      ...area,
      userCount: _count.userTenants,
    }));
  }

  async findOne(tenantId: string, id: string) {
    const area = await this.prisma.area.findFirst({ where: { id, tenantId } });
    if (!area) {
      throw new NotFoundException('El área no existe en este tenant');
    }
    return area;
  }

  /** Quiénes están asignados al área, para la ventana de usuarios de la pantalla. */
  async findUsers(tenantId: string, id: string) {
    await this.findOne(tenantId, id); // valida pertenencia al tenant

    const memberships = await this.prisma.userTenant.findMany({
      where: { areaId: id, tenantId },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((m) => m.user);
  }

  async create(tenantId: string, dto: CreateAreaDto) {
    const name = dto.name.trim();
    await this.assertNameAvailable(tenantId, name);

    const area = await this.prisma.area.create({ data: { name, tenantId } });
    this.logger.log(`Área creada: ${area.name} en tenant ${tenantId}`);
    return area;
  }

  async update(tenantId: string, id: string, dto: UpdateAreaDto) {
    await this.findOne(tenantId, id); // valida pertenencia al tenant

    const name = dto.name.trim();
    await this.assertNameAvailable(tenantId, name, id);

    return this.prisma.area.update({ where: { id }, data: { name } });
  }

  /**
   * Un área con gente asignada no se borra: primero hay que mover a esos usuarios.
   * Es la decisión explícita del usuario — borrar en cascada dejaría a un grupo de
   * gente sin área de un plumazo y sin forma de saber en cuál estaba.
   */
  async remove(tenantId: string, id: string) {
    const area = await this.findOne(tenantId, id);

    const assigned = await this.prisma.userTenant.count({ where: { areaId: id } });
    if (assigned > 0) {
      throw new ConflictException(
        `El área "${area.name}" tiene ${assigned} ${
          assigned === 1 ? 'usuario asignado' : 'usuarios asignados'
        }. Reasignalos antes de eliminarla.`,
      );
    }

    await this.prisma.area.delete({ where: { id } });
    this.logger.log(`Área eliminada: ${area.name} (tenant ${tenantId})`);
    return { deleted: true, message: 'Área eliminada.' };
  }

  // --- helpers ---

  /**
   * El nombre es único por tenant (`@@unique([name, tenantId])`). El chequeo previo es
   * para dar el mensaje en castellano: sin él, el choque sale como error crudo de Prisma.
   * Va sin distinguir mayúsculas para que "Soporte" y "soporte" no convivan — el índice
   * de la base sí las distingue, así que esta es la única barrera contra ese duplicado.
   */
  private async assertNameAvailable(
    tenantId: string,
    name: string,
    exceptId?: string,
  ) {
    const existing = await this.prisma.area.findFirst({
      where: {
        tenantId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });

    if (existing) {
      throw new ConflictException('Ya existe un área con ese nombre en este tenant');
    }
  }
}
