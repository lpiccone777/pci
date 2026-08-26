import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFlowDto, UpdateFlowDto, TenantAssignmentDto } from './dto/create-flow.dto';
import { ScheduleCalendarService } from '../schedule-calendar/schedule-calendar.service';
import { isValidScheduleEntryType } from '../schedule-calendar/schedule-entry-types.catalog';

/** Mismo nodo `start` por defecto que el editor arma para un flujo nuevo (ver `isNew` en apps/web/.../flows/edit/page.tsx). */
const BLANK_VARIANT_NODES = [
  {
    id: 'start_1',
    type: 'start',
    position: { x: 250, y: 50 },
    data: { text: 'Bienvenido al soporte técnico' },
  },
];

@Injectable()
export class FlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduleCalendarService: ScheduleCalendarService,
  ) {}

  async create(data: CreateFlowDto, userId?: string) {
    const { assignments, isStart, ...flowData } = data;

    const flow = await this.prisma.flow.create({
      data: {
        ...flowData,
        nodes: JSON.parse(JSON.stringify(flowData.nodes)),
        edges: JSON.parse(JSON.stringify(flowData.edges)),
        createdBy: userId,
      },
    });

    if (assignments?.length) {
      await this.applyTenantAssignment(flow.id, assignments, !!isStart);
    }

    return this.findById(flow.id);
  }

  async findAll(tenantId?: string) {
    // `variantOf: null` excluye las filas Flow que son variante (Feriado/Guardia) de otro
    // flow — nunca deben aparecer en listados/dropdowns generales (nodo subflow, asignación
    // de tenants, etc.), solo se acceden vía FlowService.listAlternatives/findById. Ver
    // FlowAlternative en schema.prisma.
    const where = {
      variantOf: null,
      ...(tenantId
        ? {
            tenantFlows: {
              some: { tenantId },
            },
          }
        : {}),
    };

    return this.prisma.flow.findMany({
      where,
      include: {
        tenantFlows: {
          include: {
            tenant: {
              select: { id: true, name: true, slug: true },
            },
            roles: {
              select: { roleId: true },
            },
          },
        },
        contextSource: {
          select: { id: true, name: true, type: true },
        },
        skill: {
          select: { id: true, name: true, promptText: true },
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
            roles: {
              select: { roleId: true },
            },
          },
        },
        contextSource: {
          select: { id: true, name: true, type: true },
        },
        skill: {
          select: { id: true, name: true, promptText: true },
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

  async assignTenants(flowId: string, assignments: TenantAssignmentDto[], isStart = false) {
    await this.applyTenantAssignment(flowId, assignments, isStart);
    return this.findById(flowId);
  }

  /**
   * Reemplaza las asignaciones de empresa+roles de un flujo (usado por `create` y
   * `assignTenants`). Si `isStart` es true, aplica la invariante "un flujo de
   * inicio por (empresa + rol)": para cada par (empresa, rol) que este flujo
   * reclama como inicio, le saca ese rol a cualquier OTRO flujo que sea inicio en
   * esa empresa.
   *
   * Todo en una transacción: borrar + destronar + crear tienen que ser atómicos,
   * si no un fallo a mitad de camino puede dejar un par (empresa, rol) sin ningún
   * flujo de inicio (o con dos).
   */
  private async applyTenantAssignment(
    flowId: string,
    assignments: TenantAssignmentDto[],
    isStart: boolean,
  ) {
    // Una misma empresa puede venir repetida en el payload (p.ej. un cliente de API
    // que la incluye dos veces). Antes `createMany({ skipDuplicates })` ignoraba la
    // repetición; ahora que cada empresa se crea de a una, un duplicado chocaría con
    // el índice único (flowId, tenantId) y abortaría todo el guardado. Colapsamos las
    // repeticiones en una sola asignación por empresa, uniendo sus roles, para
    // conservar ese comportamiento tolerante sin perder ningún rol marcado.
    const rolesByTenant = new Map<string, Set<string>>();
    for (const { tenantId, roleIds } of assignments) {
      const roles = rolesByTenant.get(tenantId) ?? new Set<string>();
      for (const roleId of roleIds ?? []) roles.add(roleId);
      rolesByTenant.set(tenantId, roles);
    }
    const uniqueAssignments = [...rolesByTenant].map(([tenantId, roles]) => ({
      tenantId,
      roleIds: [...roles],
    }));

    // Mismo criterio que `UsersService.assertRoleBelongsToTenant`: un roleId de otra
    // empresa no puede colarse acá — si no, un flujo quedaría con su recepción atada
    // a un rol sin ninguna relación real con el tenant al que se está asignando.
    const allRoleIds = uniqueAssignments.flatMap((a) => a.roleIds);
    if (allRoleIds.length) {
      const roles = await this.prisma.role.findMany({
        where: { id: { in: allRoleIds } },
        select: { id: true, tenantId: true },
      });
      const tenantByRole = new Map(roles.map((r) => [r.id, r.tenantId]));
      for (const { tenantId, roleIds } of uniqueAssignments) {
        for (const roleId of roleIds) {
          if (tenantByRole.get(roleId) !== tenantId) {
            throw new BadRequestException(
              `El rol ${roleId} no existe o no pertenece al tenant ${tenantId}`,
            );
          }
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // Reemplazo total: borrar las asignaciones actuales de este flujo. El cascade
      // de TenantFlowRole limpia solo los roles asociados.
      await tx.tenantFlow.deleteMany({ where: { flowId } });
      if (!uniqueAssignments.length) return;

      if (isStart) {
        // Destronar el inicio de cada rol reclamado: si otro flujo era el inicio de
        // ese (empresa + rol), se le quita esa habilitación de rol. Eso también le
        // saca la recepción de ese rol, que es justo el traspaso del inicio deseado.
        for (const { tenantId, roleIds } of uniqueAssignments) {
          if (!roleIds.length) continue;
          await tx.tenantFlowRole.deleteMany({
            where: {
              roleId: { in: roleIds },
              tenantFlow: { tenantId, isStart: true, flowId: { not: flowId } },
            },
          });
        }
      }

      for (const { tenantId, roleIds } of uniqueAssignments) {
        const tenantFlow = await tx.tenantFlow.create({
          data: { flowId, tenantId, isStart },
        });
        if (roleIds.length) {
          await tx.tenantFlowRole.createMany({
            data: roleIds.map((roleId) => ({ tenantFlowId: tenantFlow.id, roleId })),
            skipDuplicates: true,
          });
        }
      }
    });
  }

  /**
   * Flow de inicio (empresa + rol), sin considerar feriado/guardia — la lógica de
   * `findActiveFlowForTenant` de antes de sumar variantes, ahora privada. La resuelve
   * `findActiveFlowForTenant` siempre primero como "Principal", y a partir de ahí decide si
   * corresponde devolver una variante en su lugar.
   */
  private async resolvePrincipalFlow(tenantId: string, roleId?: string | null) {
    // Flujo de inicio que matchea (empresa + rol del usuario). El candado de
    // recepción es por rol: un usuario recibe el flujo de inicio solo si su rol
    // está habilitado para ese flujo en esta empresa.
    if (roleId) {
      const tenantFlow = await this.prisma.tenantFlow.findFirst({
        where: {
          tenantId,
          isStart: true,
          roles: { some: { roleId } },
        },
        include: { flow: true },
      });

      if (tenantFlow?.flow?.isActive) {
        return tenantFlow.flow;
      }
    }

    // Sin rol (usuario desconocido) o ningún flujo de inicio habilitado para su
    // rol → default global (`Flow.isDefault`). Si tampoco hay default, null y la
    // conversación cae al orquestador LLM (comportamiento actual).
    return this.prisma.flow.findFirst({
      where: { isDefault: true, isActive: true },
    });
  }

  /**
   * Igual que antes de sumar feriados/guardias, más una dimensión temporal: si el
   * (tenant, rol) resuelve a feriado o guardia en `atDate` y el flow Principal encontrado
   * tiene una variante activa configurada para ese estado (`FlowAlternative`), se devuelve
   * la variante en su lugar. Sin variante configurada (o inactiva) → cae al Principal, igual
   * que hoy. Se calcula una sola vez al iniciar la conversación (ver
   * ConversationsService.executeFlow) — nunca se re-evalúa a mitad de una charla.
   */
  async findActiveFlowForTenant(tenantId: string, roleId?: string | null, atDate: Date = new Date()) {
    const principal = await this.resolvePrincipalFlow(tenantId, roleId);
    if (!principal) return principal;

    const status = await this.scheduleCalendarService.resolveStatus(tenantId, roleId ?? null, atDate);
    if (!status) return principal;

    const alternative = await this.prisma.flowAlternative.findUnique({
      where: { baseFlowId_type: { baseFlowId: principal.id, type: status } },
      include: { variantFlow: true },
    });
    return alternative?.variantFlow?.isActive ? alternative.variantFlow : principal;
  }

  /** Variantes (Feriado/Guardia) configuradas para este flow como Principal. */
  async listAlternatives(baseFlowId: string) {
    return this.prisma.flowAlternative.findMany({
      where: { baseFlowId },
      select: { type: true, variantFlowId: true },
    });
  }

  /**
   * Crea la variante de `type` para `baseFlowId`. Tres orígenes posibles para el grafo
   * inicial (`opts.blank` y `opts.sourceFlowId` son mutuamente excluyentes; ninguno de los
   * dos = duplicar el Principal de `baseFlowId`, el default original del MVP):
   * - Duplicar el Principal de `baseFlowId` (default)
   * - Duplicar otro flujo cualquiera (`opts.sourceFlowId` — típicamente el Principal de OTRO
   *   flow, elegido por el usuario en el editor)
   * - Arrancar en blanco (`opts.blank` — mismo nodo `start` por defecto que un flujo nuevo)
   * La fila nueva nace sin `tenantFlows` propios ni `isDefault`: nunca debe ser elegible
   * directamente por `resolvePrincipalFlow`, solo a través de `FlowAlternative`.
   */
  async createVariant(
    baseFlowId: string,
    type: string,
    opts?: { blank?: boolean; sourceFlowId?: string },
  ) {
    if (!isValidScheduleEntryType(type)) {
      throw new BadRequestException(`Tipo de variante desconocido: "${type}"`);
    }
    const base = await this.findById(baseFlowId);

    const existing = await this.prisma.flowAlternative.findUnique({
      where: { baseFlowId_type: { baseFlowId, type } },
    });
    if (existing) {
      throw new ConflictException('Ya existe una variante de este tipo para este flujo');
    }

    let graphSource: { nodes: unknown; edges: unknown; description: string | null; contextSourceId: string | null; skillId: string | null };
    if (opts?.blank) {
      graphSource = {
        nodes: BLANK_VARIANT_NODES,
        edges: [],
        description: null,
        contextSourceId: null,
        skillId: null,
      };
    } else if (opts?.sourceFlowId) {
      const source = await this.findById(opts.sourceFlowId);
      graphSource = {
        nodes: source.nodes,
        edges: source.edges,
        description: source.description,
        contextSourceId: source.contextSourceId,
        skillId: source.skillId,
      };
    } else {
      graphSource = {
        nodes: base.nodes,
        edges: base.edges,
        description: base.description,
        contextSourceId: base.contextSourceId,
        skillId: base.skillId,
      };
    }

    const variant = await this.prisma.flow.create({
      data: {
        name: `${base.name} (${type})`,
        description: graphSource.description,
        nodes: graphSource.nodes as any,
        edges: graphSource.edges as any,
        contextSourceId: graphSource.contextSourceId,
        skillId: graphSource.skillId,
        isActive: true,
        isDefault: false,
      },
    });
    await this.prisma.flowAlternative.create({ data: { baseFlowId, type, variantFlowId: variant.id } });
    return this.findById(variant.id);
  }

  /** Borra la variante de `type` para `baseFlowId` (y con ella la fila Flow variante, por cascade). */
  async deleteVariant(baseFlowId: string, type: string) {
    const alternative = await this.prisma.flowAlternative.findUnique({
      where: { baseFlowId_type: { baseFlowId, type } },
    });
    if (!alternative) throw new NotFoundException('No hay variante de ese tipo para este flujo');

    await this.prisma.flow.delete({ where: { id: alternative.variantFlowId } });
    return { deleted: true };
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
