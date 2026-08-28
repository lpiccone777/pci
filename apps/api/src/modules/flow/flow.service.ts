import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFlowDto, UpdateFlowDto, TenantAssignmentDto } from './dto/create-flow.dto';
import { resolveReadableTenantIds } from '../../common/rbac/readable-tenant-ids';
import { isSystemSuperAdmin } from '../../common/system-superadmin';

/** Vínculo del que llama (lo deja `TenantGuard` en `request.userTenant`), para resolver SuperAdmin. */
type CallerUserTenant = { userId?: string; tenantId: string; roleId: string } | null | undefined;

@Injectable()
export class FlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async create(
    data: CreateFlowDto,
    userId?: string,
    activeTenantId?: string,
    userTenant?: CallerUserTenant,
  ) {
    const { assignments, isStart, ...flowData } = data;
    const isSuperAdmin = await this.isSuperAdmin(userTenant);

    // Autoridad sobre las empresas destino: solo se puede asignar el flujo a empresas propias
    // (el SuperAdmin, a cualquiera). Se valida ANTES de crear el flujo, para no dejar un flujo
    // huérfano si el payload trae una empresa ajena. Misma validación que `assignTenants`.
    await this.assertAssignableTenants(assignments, userId, isSuperAdmin);

    // Aislamiento multitenant: un flujo importado/creado no puede quedar apuntando a
    // recursos de OTRA empresa (fuente de verdad, skill, usuarios de nodos, subflujos).
    // Ver `sanitizeCrossTenantRefs`. El conjunto válido es la empresa activa MÁS las
    // que el propio payload asigna. El SuperAdmin administra de forma global, así que NO
    // se le sanea: puede vincular recursos de cualquier empresa a propósito.
    if (!isSuperAdmin) {
      const validTenantIds = await this.collectValidTenantIds(
        activeTenantId,
        undefined,
        assignments,
        userId,
      );
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
   * ¿El que llama es el SuperAdmin del sistema? Es el único que administra flujos de forma
   * global: saltea el saneo cross-tenant (puede vincular recursos de cualquier empresa a
   * propósito), opera sobre flujos de cualquier empresa y los asigna a cualquiera. Antes este
   * corte era "¿la empresa activa es la de sistema?" (`isSystemContext`), que dejaba pasar a
   * CUALQUIER miembro del tenant de sistema aunque no fuera SuperAdmin — ver `isSystemSuperAdmin`,
   * que mira rol + tenant, no la mera pertenencia.
   */
  private async isSuperAdmin(userTenant?: CallerUserTenant): Promise<boolean> {
    return isSystemSuperAdmin(this.prisma, this.config, userTenant ?? null);
  }

  /**
   * Corta si el flujo no es de ninguna empresa del usuario (y quien llama no es SuperAdmin). El
   * scope lo pone la membresía del usuario, NO la empresa activa del header: la vista "Todas mis
   * empresas" manda una empresa de respaldo en el header (no la del flujo), así que cortar por la
   * activa rompería abrir/editar un flujo de otra de las empresas del usuario. Mismo criterio que
   * `findMine`/`resolveReadableTenantIds`. Se tira `NotFound` (no `Forbidden`) a propósito: así no
   * se filtra si un id existe en una empresa ajena. No va dentro de `findById` porque ese lo
   * reusan las lecturas internas post-escritura, que no deben pasar por este corte.
   */
  private async assertFlowAccessible(
    flowId: string,
    userTenant: CallerUserTenant,
    isSuperAdmin: boolean,
  ): Promise<void> {
    if (isSuperAdmin) return;

    const flow = await this.prisma.flow.findUnique({
      where: { id: flowId },
      select: { createdBy: true, tenantFlows: { select: { tenantId: true } } },
    });
    if (!flow) throw new NotFoundException('Flujo no encontrado');

    const userId = userTenant?.userId;

    // Flujo sin empresas (borrador recién creado: "nace sin empresas"): accesible solo por su
    // creador, hasta que se le asignen empresas. No aparece en ningún listado (findAll/findMine
    // exigen `tenantFlows.some`), así que nadie más puede descubrir su id.
    if (flow.tenantFlows.length === 0) {
      if (userId && flow.createdBy === userId) return;
      throw new NotFoundException('Flujo no encontrado');
    }

    // Flujo asignado: accesible si alguna de sus empresas es una donde el usuario puede ver
    // flujos (`flows:read`) — exactamente el conjunto que la vista "Todas mis empresas" muestra.
    if (userId) {
      const readable = new Set(await resolveReadableTenantIds(this.prisma, userId, 'flows'));
      if (flow.tenantFlows.some((tf) => readable.has(tf.tenantId))) return;
    }
    throw new NotFoundException('Flujo no encontrado');
  }

  /**
   * Valida que todas las empresas destino de `assignments` sean del propio usuario (salvo
   * SuperAdmin, que asigna a cualquiera). Mismo criterio para `create` y `assignTenants`: sin
   * esto, cualquiera con `flows:create`/`update` podía enganchar un flujo a una empresa ajena
   * mandándola en el payload (con `roleIds` vacío ni siquiera se validaban roles).
   */
  private async assertAssignableTenants(
    assignments: TenantAssignmentDto[] | undefined,
    userId: string | undefined,
    isSuperAdmin: boolean,
  ): Promise<void> {
    if (isSuperAdmin) return;
    const targetTenantIds = [
      ...new Set((assignments ?? []).map((a) => a?.tenantId).filter((t): t is string => !!t)),
    ];
    if (!targetTenantIds.length) return;
    const memberships = userId
      ? await this.prisma.userTenant.findMany({
          // Una empresa dada de baja no cuenta como destino válido: la membresía (`UserTenant`)
          // sobrevive a la baja lógica, así que sin este filtro se podría asignar el flujo a una
          // empresa muerta con un request armado a mano. Mismo criterio que `resolveReadableTenantIds`.
          where: { userId, tenantId: { in: targetTenantIds }, tenant: { deletedAt: null } },
          select: { tenantId: true },
        })
      : [];
    const allowed = new Set(memberships.map((m) => m.tenantId));
    const foreign = targetTenantIds.filter((id) => !allowed.has(id));
    if (foreign.length) {
      throw new ForbiddenException(
        `No podés asignar el flujo a una empresa a la que no pertenecés: ${foreign.join(', ')}`,
      );
    }
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
    userId?: string,
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    if (activeTenantId) ids.add(activeTenantId);

    // Las empresas que trae el payload (`assignments`) NO se dan por válidas a ciegas: si
    // se aceptara el `tenantId` que manda el cliente, un usuario podría listar una empresa
    // ajena solo para que su fuente/skill/usuarios pasen el saneo cross-tenant. Cada empresa
    // del body se acepta únicamente si el usuario realmente pertenece a ella (`UserTenant`).
    const claimedTenantIds = [
      ...new Set((assignments ?? []).map((a) => a?.tenantId).filter((t): t is string => !!t)),
    ];
    if (claimedTenantIds.length && userId) {
      const memberships = await this.prisma.userTenant.findMany({
        // Mismo criterio que `assertAssignableTenants`: una empresa dada de baja no habilita sus
        // recursos para el saneo cross-tenant, aunque la membresía siga existiendo.
        where: { userId, tenantId: { in: claimedTenantIds }, tenant: { deletedAt: null } },
        select: { tenantId: true },
      });
      for (const m of memberships) ids.add(m.tenantId);
    }

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

    // Subflujos ajenos, en tres casos:
    //  - tiene empresas asignadas y NINGUNA es válida → ajeno (import de otra empresa);
    //  - NO tiene empresas y no es `isDefault` → borrador ajeno (antes se colaba como si
    //    fuera un subflujo "global legítimo", que es exactamente lo que hay que evitar);
    //  - el flowId referenciado ni siquiera existe → referencia colgada, también se descarta.
    // Un subflujo sin empresas pero `isDefault` SÍ es global legítimo (default del sistema) y
    // se respeta, para no romper referencias válidas dentro del mismo ambiente.
    const foreignSubflowIds = new Set<string>();
    if (subflowIds.size) {
      const flows = await this.prisma.flow.findMany({
        where: { id: { in: [...subflowIds] } },
        select: {
          id: true,
          isDefault: true,
          tenantFlows: { select: { tenantId: true } },
        },
      });
      const known = new Set(flows.map((f) => f.id));
      for (const f of flows) {
        const tenants = f.tenantFlows.map((tf) => tf.tenantId);
        if (tenants.length) {
          if (!tenants.some((t) => validTenantIds.has(t))) foreignSubflowIds.add(f.id);
        } else if (!f.isDefault) {
          foreignSubflowIds.add(f.id);
        }
      }
      for (const id of subflowIds) if (!known.has(id)) foreignSubflowIds.add(id);
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
    const readableTenantIds = await resolveReadableTenantIds(this.prisma, userId, 'flows');

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

  /**
   * `findById` con corte de pertenencia, para el endpoint `GET /flows/:id`: solo devuelve el
   * flujo si es de alguna de las empresas del usuario (o el que llama es SuperAdmin) — ver
   * `assertFlowAccessible`. Se separa de `findById` porque este último lo reusan las lecturas
   * internas post-escritura, que no llevan corte.
   */
  async findByIdScoped(id: string, userTenant?: CallerUserTenant) {
    const isSuperAdmin = await this.isSuperAdmin(userTenant);
    await this.assertFlowAccessible(id, userTenant, isSuperAdmin);
    return this.findById(id);
  }

  async update(
    id: string,
    data: UpdateFlowDto,
    activeTenantId?: string,
    userTenant?: CallerUserTenant,
  ) {
    const { nodes, edges, ...rest } = data;
    const isSuperAdmin = await this.isSuperAdmin(userTenant);

    // Corte de pertenencia: no se edita un flujo de una empresa ajena (el SuperAdmin, cualquiera).
    await this.assertFlowAccessible(id, userTenant, isSuperAdmin);

    // Mismo saneo multitenant que en `create`: aunque el editor solo ofrezca recursos
    // válidos, un PATCH directo podría mandar ids de otra empresa. El conjunto válido
    // suma las empresas ya asignadas al flujo (`TenantFlow`) para no pisar una fuente
    // legítima al guardar desde otra empresa activa (FLW-23). El SuperAdmin (admin global) no
    // se sanea (ver `create`). `sanitizeCrossTenantRefs` mutá los nodos en el lugar.
    if (!isSuperAdmin) {
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

  async delete(id: string, userTenant?: CallerUserTenant) {
    const isSuperAdmin = await this.isSuperAdmin(userTenant);
    // Corte de pertenencia: no se borra un flujo de una empresa ajena (el SuperAdmin, cualquiera).
    await this.assertFlowAccessible(id, userTenant, isSuperAdmin);
    // Borrado total: si el flujo está compartido con otras empresas, se elimina para TODAS
    // (decisión explícita "compartido = compartido", misma limitación conocida que la edición
    // de un flujo compartido). Alcanza con que el flujo sea de una empresa del usuario.
    await this.prisma.flow.delete({ where: { id } });
    return { message: 'Flujo eliminado' };
  }

  async assignTenants(
    flowId: string,
    assignments: TenantAssignmentDto[],
    isStart = false,
    userTenant?: CallerUserTenant,
  ) {
    const isSuperAdmin = await this.isSuperAdmin(userTenant);

    // Corte de pertenencia sobre el flujo de ORIGEN: no se reasigna un flujo de una empresa ajena
    // (antes se validaba solo el destino, no que tuvieras relación con el flujo — el propio
    // código lo dejaba como pendiente). El SuperAdmin administra todos.
    await this.assertFlowAccessible(flowId, userTenant, isSuperAdmin);

    // Autoridad sobre las empresas DESTINO: solo empresas propias (el SuperAdmin, a cualquiera).
    // Sin esto, cualquiera con `flows:update` podía enganchar el flujo a una empresa ajena
    // mandándola en `assignments` (con `roleIds` vacío ni siquiera se validaban roles).
    await this.assertAssignableTenants(assignments, userTenant?.userId, isSuperAdmin);

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
