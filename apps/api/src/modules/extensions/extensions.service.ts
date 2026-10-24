import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationsConfigService } from '../integrations/integrations-config.service';
import { CreateExtensionDto, UpdateExtensionDto } from './dto/extension.dto';

const EXTENSION_SELECT = {
  id: true,
  number: true,
  name: true,
  tenantId: true,
  flowId: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
  tenant: { select: { id: true, name: true, slug: true, deletedAt: true } },
} satisfies Prisma.ExtensionSelect;

/**
 * Internos que atiende el voicebot (contrato de integración §3.5). Infra global: no se scopea
 * por el tenant activo (lo garantiza `SystemTenantGuard` en el controller).
 *
 * - `number` es único y no puede coincidir con el `User.internalPhone` de una persona activa:
 *   comparten la numeración de la central [C5]. El chequeo inverso vive en `UsersService`.
 * - Todo cambio sube la versión de la configuración y publica `config.changed` con
 *   `sections: ["internos"]`.
 */
@Injectable()
export class ExtensionsService {
  private readonly logger = new Logger(ExtensionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrationsConfig: IntegrationsConfigService,
  ) {}

  findAll() {
    return this.prisma.extension.findMany({ select: EXTENSION_SELECT, orderBy: { number: 'asc' } });
  }

  /** Flujos que puede tener un interno de `tenantId`: de voz, activos y asignados a esa empresa [DA8]. */
  flowOptions(tenantId: string) {
    return this.prisma.flow.findMany({
      where: { channel: 'voice', isActive: true, variantOf: null, tenantFlows: { some: { tenantId } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async create(dto: CreateExtensionDto) {
    const number = dto.number.trim();
    await this.assertNumberAvailable(number);
    await this.assertTenantActive(dto.tenantId);
    const flowId = dto.flowId || null;
    await this.assertFlowFits(flowId, dto.tenantId);

    const ext = await this.withUniqueNumber(number, () =>
      this.prisma.extension.create({
        data: { number, name: dto.name.trim(), tenantId: dto.tenantId, flowId, enabled: dto.enabled ?? true },
        select: EXTENSION_SELECT,
      }),
    );
    this.logger.log(`Interno ${ext.number} creado`);
    await this.integrationsConfig.notifyExtensionsChanged(`interno ${ext.number}`);
    return ext;
  }

  async update(id: string, dto: UpdateExtensionDto) {
    const current = await this.requireExtension(id);
    const number = dto.number?.trim();
    if (number !== undefined && number !== current.number) await this.assertNumberAvailable(number, id);
    if (dto.tenantId !== undefined && dto.tenantId !== current.tenantId) {
      await this.assertTenantActive(dto.tenantId);
    }
    // El flujo propio tiene que ser de la empresa que queda: se valida si cambia cualquiera de los dos.
    const flowId = dto.flowId === undefined ? current.flowId : dto.flowId || null;
    if (dto.flowId !== undefined || dto.tenantId !== undefined) {
      await this.assertFlowFits(flowId, dto.tenantId ?? current.tenantId);
    }

    const ext = await this.withUniqueNumber(number ?? current.number, () =>
      this.prisma.extension.update({
        where: { id },
        data: {
          ...(number !== undefined && { number }),
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          ...(dto.tenantId !== undefined && { tenantId: dto.tenantId }),
          ...(dto.flowId !== undefined && { flowId }),
          ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        },
        select: EXTENSION_SELECT,
      }),
    );
    this.logger.log(`Interno ${ext.number} actualizado`);
    await this.integrationsConfig.notifyExtensionsChanged(`interno ${ext.number}`);
    return ext;
  }

  async remove(id: string) {
    const current = await this.requireExtension(id);
    await this.prisma.extension.delete({ where: { id } });
    this.logger.log(`Interno ${current.number} eliminado`);
    await this.integrationsConfig.notifyExtensionsChanged(`interno ${current.number}`);
    return { id };
  }

  private async requireExtension(id: string) {
    const ext = await this.prisma.extension.findUnique({ where: { id } });
    if (!ext) throw new NotFoundException('No existe ese interno');
    return ext;
  }

  /** Único entre internos y distinto de todo `User.internalPhone` activo [C5]. */
  private async assertNumberAvailable(number: string, exceptId?: string) {
    const [ext, user] = await Promise.all([
      this.prisma.extension.findUnique({ where: { number }, select: { id: true } }),
      this.prisma.user.findFirst({ where: { internalPhone: number, deletedAt: null }, select: { id: true } }),
    ]);
    if (ext && ext.id !== exceptId) {
      throw new ConflictException({ message: 'Ya existe un interno con ese número', field: 'number' });
    }
    if (user) {
      throw new ConflictException({
        message: 'Ese número es el interno de una persona (usuario): la central comparte la numeración',
        field: 'number',
      });
    }
  }

  /** Flujo propio del interno [DA8, paso 1]: de voz, activo y asignado a la empresa del interno. */
  private async assertFlowFits(flowId: string | null, tenantId: string) {
    if (!flowId) return;
    const flow = await this.prisma.flow.findFirst({
      where: { id: flowId, channel: 'voice', isActive: true, tenantFlows: { some: { tenantId } } },
      select: { id: true },
    });
    if (!flow) {
      throw new BadRequestException({
        message: 'El flujo del interno tiene que ser un flujo de voz activo asignado a la empresa del interno',
        field: 'flowId',
      });
    }
  }

  private async assertTenantActive(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { deletedAt: true } });
    if (!tenant || tenant.deletedAt) throw new BadRequestException('La empresa no existe o está dada de baja');
  }

  /** Carrera entre el chequeo y la escritura: el índice único decide. */
  private async withUniqueNumber<T>(number: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ message: `Ya existe un interno con el número ${number}`, field: 'number' });
      }
      throw err;
    }
  }
}
