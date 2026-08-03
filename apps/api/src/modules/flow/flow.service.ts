import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFlowDto, UpdateFlowDto } from './dto/create-flow.dto';

@Injectable()
export class FlowService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateFlowDto, userId?: string) {
    const { tenantIds, ...flowData } = data;

    const flow = await this.prisma.flow.create({
      data: {
        ...flowData,
        nodes: JSON.parse(JSON.stringify(flowData.nodes)),
        edges: JSON.parse(JSON.stringify(flowData.edges)),
        createdBy: userId,
      },
    });

    if (tenantIds?.length) {
      await this.prisma.tenantFlow.createMany({
        data: tenantIds.map((tenantId) => ({
          flowId: flow.id,
          tenantId,
        })),
        skipDuplicates: true,
      });
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

  async assignTenants(flowId: string, tenantIds: string[]) {
    // Remove existing assignments
    await this.prisma.tenantFlow.deleteMany({
      where: { flowId },
    });

    // Create new assignments
    if (tenantIds.length) {
      await this.prisma.tenantFlow.createMany({
        data: tenantIds.map((tenantId) => ({
          flowId,
          tenantId,
        })),
        skipDuplicates: true,
      });
    }

    return this.findById(flowId);
  }

  async findActiveFlowForTenant(tenantId: string) {
    // First try to find a tenant-specific flow
    const tenantFlow = await this.prisma.tenantFlow.findFirst({
      where: { tenantId },
      include: {
        flow: true,
      },
    });

    if (tenantFlow?.flow?.isActive) {
      return tenantFlow.flow;
    }

    // Fallback to default flow
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
