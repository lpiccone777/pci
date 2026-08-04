import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFlowDto, UpdateFlowDto } from './dto/create-flow.dto';

@Injectable()
export class FlowService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateFlowDto, userId?: string) {
    const { tenantIds, isStart, ...flowData } = data;

    const flow = await this.prisma.flow.create({
      data: {
        ...flowData,
        nodes: JSON.parse(JSON.stringify(flowData.nodes)),
        edges: JSON.parse(JSON.stringify(flowData.edges)),
        createdBy: userId,
      },
    });

    if (tenantIds?.length) {
      await this.applyTenantAssignment(flow.id, tenantIds, !!isStart);
    }

    return this.findById(flow.id);
  }

  async findAll(tenantId?: string) {
    const where = tenantId
      ? {
          tenantFlows: {
            some: { tenantId },
          },
        }
      : {};

    return this.prisma.flow.findMany({
      where,
      include: {
        tenantFlows: {
          include: {
            tenant: {
              select: { id: true, name: true, slug: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    const flow = await this.prisma.flow.findUnique({
      where: { id },
      include: {
        tenantFlows: {
          include: {
            tenant: {
              select: { id: true, name: true, slug: true },
            },
          },
        },
      },
    });

    if (!flow) throw new NotFoundException('Flujo no encontrado');
    return flow;
  }

  async update(id: string, data: UpdateFlowDto) {
    const { nodes, edges, ...rest } = data;

    const updateData: any = { ...rest };
    if (nodes) updateData.nodes = JSON.parse(JSON.stringify(nodes));
    if (edges) updateData.edges = JSON.parse(JSON.stringify(edges));

    const flow = await this.prisma.flow.update({
      where: { id },
      data: updateData,
    });

    return this.findById(flow.id);
  }

  async delete(id: string) {
    await this.prisma.flow.delete({ where: { id } });
    return { message: 'Flujo eliminado' };
  }

  async assignTenants(flowId: string, tenantIds: string[], isStart = false) {
    await this.applyTenantAssignment(flowId, tenantIds, isStart);
    return this.findById(flowId);
  }

  /**
   * Reemplaza las asignaciones de tenant de un flujo (usado por `create` y
   * `assignTenants`). Si `isStart` es true, aplica la invariante "un tenant tiene
   * como máximo un flujo de inicio": desmarca cualquier otro flujo que lo fuera
   * para alguno de los tenants seleccionados.
   *
   * Todo en una transacción: borrar + desmarcar + crear tienen que ser atómicos,
   * si no un fallo a mitad de camino puede dejar un tenant sin ningún flujo de
   * inicio (o con dos).
   */
  private async applyTenantAssignment(flowId: string, tenantIds: string[], isStart: boolean) {
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantFlow.deleteMany({ where: { flowId } });
      if (!tenantIds.length) return;

      if (isStart) {
        await tx.tenantFlow.updateMany({
          where: { tenantId: { in: tenantIds }, isStart: true },
          data: { isStart: false },
        });
      }

      await tx.tenantFlow.createMany({
        data: tenantIds.map((tenantId) => ({ flowId, tenantId, isStart })),
        skipDuplicates: true,
      });
    });
  }

  async findActiveFlowForTenant(tenantId: string) {
    // Flujo de inicio explícito para este tenant (TenantFlow.isStart). Reemplaza
    // el `findFirst({where:{tenantId}})` de antes, que agarraba CUALQUIER flujo
    // asignado sin ningún orden — ambiguo apenas había más de uno, que es
    // justamente el caso de uso de tener varios flujos por tenant.
    const tenantFlow = await this.prisma.tenantFlow.findFirst({
      where: { tenantId, isStart: true },
      include: { flow: true },
    });

    if (tenantFlow?.flow?.isActive) {
      return tenantFlow.flow;
    }

    // Legado: sin flujo de inicio explícito para este tenant, cae al default
    // global (`Flow.isDefault`). Se mantiene por compatibilidad con instalaciones
    // que todavía no configuraron un flujo de inicio por tenant.
    return this.prisma.flow.findFirst({
      where: { isDefault: true, isActive: true },
    });
  }

  async setDefault(id: string) {
    // Unset any existing default
    await this.prisma.flow.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });

    // Set new default
    await this.prisma.flow.update({
      where: { id },
      data: { isDefault: true },
    });

    return this.findById(id);
  }
}
