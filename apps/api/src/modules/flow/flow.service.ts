import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { systemTenantSlug } from '../../common/system-tenant';
import { CreateFlowDto, UpdateFlowDto, TenantAssignmentDto } from './dto/create-flow.dto';

@Injectable()
export class FlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async create(data: CreateFlowDto, userId?: string, activeTenantId?: string) {
    const { assignments, isStart, ...flowData } = data;

    // Aislamiento multitenant: un flujo importado/creado no puede quedar apuntando a
    // recursos de OTRA empresa (fuente de verdad, skill, usuarios de nodos, subflujos).
    // Ver `sanitizeCrossTenantRefs`. El conjunto válido es la empresa activa MÁS las
    // que el propio payload asigna. En contexto de sistema (superadmin administrando de
    // forma global) NO se sanea: puede vincular recursos de cualquier empresa a propósito.
    if (!(await this.isSystemContext(activeTenantId))) {
      const validTenantIds = await this.collectValidTenantIds(activeTenantId, undefined, assignments);
      await this.sanitizeCrossTenantRefs(flowData, validTenantIds);
    }

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

  /**
   * ¿La empresa activa es la de sistema? En ese contexto el superadmin administra flujos de
   * forma global y puede vincular recursos de cualquier empresa a propósito, así que el saneo
   * cross-tenant no aplica. El corte por leakeo apunta a quien opera DENTRO de una empresa
   * puntual (import en la empresa B, que no debe traerse la fuente de A) — ver FE-FLW-29.
   */
  private async isSystemContext(activeTenantId?: string): Promise<boolean> {
    if (!activeTenantId) return false;
    const systemTenant = await this.prisma.tenant.findUnique({
      where: { slug: systemTenantSlug(this.config) },
      select: { id: true },
    });
    return !!systemTenant && systemTenant.id === activeTenantId;
  }

  /**
   * Empresas contra las que se valida la pertenencia de las referencias de un flujo:
   * la empresa activa (header `X-Tenant-Id`) más las que el flujo tiene asignadas
   * (`TenantFlow`) y, en un `create`, las que trae el propio payload. Con esto un
   * `create`/`update` desde la empresa B acepta referencias de B; un `update` de un
   * flujo asignado a B, hecho por el superadmin parado en sistema, también las acepta
   * (el escenario de FLW-23: el editor puebla los dropdowns con la empresa del flujo).
   */
  private async collectValidTenantIds(
    activeTenantId?: string,
    flowId?: string,
    assignments?: TenantAssignmentDto[],
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    if (activeTenantId) ids.add(activeTenantId);
    for (const a of assignments ?? []) if (a?.tenantId) ids.add(a.tenantId);
    if (flowId) {
      const tenantFlows = await this.prisma.tenantFlow.findMany({
        where: { flowId },
        select: { tenantId: true },
      });
      for (const tf of tenantFlows) ids.add(tf.tenantId);
    }
    return ids;
  }

  /** Campos de nodo que guardan userIds (ver FlowNodeDataDto). */
  private static readonly USER_ID_NODE_FIELDS = [
    'assignees',
    'watchers',
    'collaborators',
    'recipients',
  ] as const;

  /**
   * Descarta las referencias del flujo que apuntan a recursos de una empresa fuera de
   * `validTenantIds` — el vector de FE-FLW-29: exportar un flujo de la empresa A e
   * importarlo en B lo dejaba apuntando a la fuente/skill/usuarios de A. Mutá `refs` en
   * el lugar (contextSourceId/skillId a `null`, y limpia los ids embebidos en los nodos):
   *
   * - `contextSourceId` / `skillId`: a `null` si no pertenecen a una empresa válida.
   * - userIds de nodos (assignees/watchers/collaborators/recipients): se filtran los que
   *   no son miembros de ninguna empresa válida.
   * - `flowId` de un nodo `subflow`: se borra solo si apunta a un flujo CLARAMENTE ajeno
   *   (asignado a otras empresas y a ninguna válida); un subflujo global (sin empresas)
   *   se respeta, para no romper referencias legítimas dentro del mismo ambiente.
   */
  private async sanitizeCrossTenantRefs(
    refs: { contextSourceId?: string | null; skillId?: string | null; nodes?: any[] },
    validTenantIds: Set<string>,
  ): Promise<void> {
    const valid = [...validTenantIds];

    if (refs.contextSourceId) {
      const source = await this.prisma.contextSource.findUnique({
        where: { id: refs.contextSourceId },
        select: { tenantId: true },
      });
      if (!source || !validTenantIds.has(source.tenantId)) refs.contextSourceId = null;
    }

    if (refs.skillId) {
      const skill = await this.prisma.skill.findUnique({
        where: { id: refs.skillId },
        select: { tenantId: true },
      });
      if (!skill || !validTenantIds.has(skill.tenantId)) refs.skillId = null;
    }

    const nodes = refs.nodes;
    if (!Array.isArray(nodes) || !nodes.length) return;

    // Junta todos los userIds y flowIds de subflujo referenciados por los nodos.
    const userIds = new Set<string>();
    const subflowIds = new Set<string>();
    for (const node of nodes) {
      const data = node?.data;
      if (!data) continue;
      for (const field of FlowService.USER_ID_NODE_FIELDS) {
        const arr = data[field];
        if (Array.isArray(arr)) for (const id of arr) if (typeof id === 'string') userIds.add(id);
      }
      if (typeof data.flowId === 'string' && data.flowId) subflowIds.add(data.flowId);
    }

    // userIds válidos = los que son miembros de alguna empresa válida.
    let validUserIds = new Set<string>();
    if (userIds.size && valid.length) {
      const memberships = await this.prisma.userTenant.findMany({
        where: { userId: { in: [...userIds] }, tenantId: { in: valid } },
        select: { userId: true },
      });
      validUserIds = new Set(memberships.map((m) => m.userId));
    }

    // Subflujos "claramente ajenos": tienen alguna asignación y ninguna es válida.
    const foreignSubflowIds = new Set<string>();
    if (subflowIds.size) {
      const rows = await this.prisma.tenantFlow.findMany({
        where: { flowId: { in: [...subflowIds] } },
        select: { flowId: true, tenantId: true },
      });
      const tenantsByFlow = new Map<string, string[]>();
      for (const r of rows) {
        const list = tenantsByFlow.get(r.flowId) ?? [];
        list.push(r.tenantId);
        tenantsByFlow.set(r.flowId, list);
      }
      for (const [flowId, tenants] of tenantsByFlow) {
        if (!tenants.some((t) => validTenantIds.has(t))) foreignSubflowIds.add(flowId);
      }
    }

    for (const node of nodes) {
      const data = node?.data;
      if (!data) continue;
      for (const field of FlowService.USER_ID_NODE_FIELDS) {
        if (Array.isArray(data[field])) {
          data[field] = data[field].filter(
            (id: unknown) => typeof id === 'string' && validUserIds.has(id),
          );
        }
      }
      if (typeof data.flowId === 'string' && foreignSubflowIds.has(data.flowId)) {
        delete data.flowId;
      }
    }
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

  /**
   * Flujos de TODAS las empresas del propio usuario (vista "Todas mis empresas" del usuario
   * común, que no es superadmin). Una fila por flujo, deduplicado, con sus empresas — mismo
   * shape que `findAll`, pero acotado a las empresas donde ESTE usuario puede ver flujos (su
   * rol tiene `flows:read`).
   *
   * Es la contraparte no-privilegiada de `findAll()` sin tenant (que trae todo el sistema y va
   * con `SystemTenantGuard`): el superadmin ve todos los flujos; el usuario común, solo los de
   * sus empresas. El scope lo pone el propio userId, no el header, así que no necesita
   * `SystemTenantGuard` ni un tenant activo — cada empresa se filtra por el permiso que el
   * usuario tiene en ella. No trae los flujos sin ninguna empresa asignada (administración
   * global del sistema): un usuario común no debe verlos.
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
          (p) => p.resource === 'flows' && p.action === 'read',
        ),
      )
      .map((m) => m.tenantId);

    if (readableTenantIds.length === 0) return [];

    return this.prisma.flow.findMany({
      where: {
        tenantFlows: { some: { tenantId: { in: readableTenantIds } } },
      },
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

  async update(id: string, data: UpdateFlowDto, activeTenantId?: string) {
    const { nodes, edges, ...rest } = data;

    // Mismo saneo multitenant que en `create`: aunque el editor solo ofrezca recursos
    // válidos, un PATCH directo podría mandar ids de otra empresa. El conjunto válido
    // suma las empresas ya asignadas al flujo (`TenantFlow`) para no pisar una fuente
    // legítima al guardar desde otra empresa activa (FLW-23). En contexto de sistema no
    // se sanea (ver `create`). `sanitizeCrossTenantRefs` mutá los nodos en el lugar.
    if (!(await this.isSystemContext(activeTenantId))) {
      const validTenantIds = await this.collectValidTenantIds(activeTenantId, id);
      const refs: { contextSourceId?: string | null; skillId?: string | null; nodes?: any[] } = {
        contextSourceId: rest.contextSourceId,
        skillId: rest.skillId,
        nodes,
      };
      await this.sanitizeCrossTenantRefs(refs, validTenantIds);
      if ('contextSourceId' in rest) rest.contextSourceId = refs.contextSourceId;
      if ('skillId' in rest) rest.skillId = refs.skillId;
    }

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

  async findActiveFlowForTenant(tenantId: string, roleId?: string | null) {
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
