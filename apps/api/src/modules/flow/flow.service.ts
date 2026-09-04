import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFlowDto, UpdateFlowDto, TenantAssignmentDto } from './dto/create-flow.dto';
import { ScheduleCalendarService } from '../schedule-calendar/schedule-calendar.service';
import { isValidScheduleEntryType } from '../schedule-calendar/schedule-entry-types.catalog';
import { resolveReadableTenantIds } from '../../common/rbac/readable-tenant-ids';
import { isSystemSuperAdmin } from '../../common/system-superadmin';

/** Mismo nodo `start` por defecto que el editor arma para un flujo nuevo (ver `isNew` en apps/web/.../flows/edit/page.tsx). */
const BLANK_VARIANT_NODES = [
  {
    id: 'start_1',
    type: 'start',
    position: { x: 250, y: 50 },
    data: { text: 'Bienvenido al soporte técnico' },
  },
];

/** Vínculo del que llama (lo deja `TenantGuard` en `request.userTenant`), para resolver SuperAdmin. */
type CallerUserTenant = { userId?: string; tenantId: string; roleId: string } | null | undefined;

@Injectable()
export class FlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduleCalendarService: ScheduleCalendarService,
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
   * la empresa activa (header `X-Tenant-Id`) más las que el flujo YA tiene asignadas
   * (`TenantFlow`) y, en un `create`, las que trae el propio payload.
   *
   * NINGUNA de esas dos fuentes se da por válida a ciegas: tanto las que trae el payload
   * como las que el flujo ya tiene asignadas (compartido con otra empresa) solo cuentan si
   * el que edita REALMENTE pertenece a ellas (`UserTenant`) — si no, un usuario de la empresa
   * A que edita un flujo compartido con B (acceso legítimo: `assertFlowAccessible` lo permite
   * con `flows:read` en A sola) podría colar una referencia a un recurso de B sin ser
   * miembro de B, solo porque el flujo ya estaba compartido con ella. Antes las tenants YA
   * asignadas se aceptaban sin este chequeo (comentario original, FLW-23: "el editor puebla
   * los dropdowns con la empresa del flujo") — pero ESE escenario es el del SuperAdmin, que
   * ni siquiera pasa por acá (`update()` salta este saneo entero para él).
   */
  private async collectValidTenantIds(
    activeTenantId?: string,
    flowId?: string,
    assignments?: TenantAssignmentDto[],
    userId?: string,
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    if (activeTenantId) ids.add(activeTenantId);

    const claimedTenantIds = new Set(
      (assignments ?? []).map((a) => a?.tenantId).filter((t): t is string => !!t),
    );

    if (flowId) {
      const tenantFlows = await this.prisma.tenantFlow.findMany({
        where: { flowId },
        select: { tenantId: true },
      });
      for (const tf of tenantFlows) claimedTenantIds.add(tf.tenantId);
    }

    if (claimedTenantIds.size && userId) {
      const memberships = await this.prisma.userTenant.findMany({
        // Mismo criterio que `assertAssignableTenants`: una empresa dada de baja no habilita sus
        // recursos para el saneo cross-tenant, aunque la membresía siga existiendo.
        where: { userId, tenantId: { in: [...claimedTenantIds] }, tenant: { deletedAt: null } },
        select: { tenantId: true },
      });
      for (const m of memberships) ids.add(m.tenantId);
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
    // legítima al guardar desde otra empresa activa (FLW-23) — pero solo las que el propio
    // editor integra: se pasa `userTenant?.userId` para que `collectValidTenantIds` las
    // filtre por membresía real, igual que hace con las de `create`. El SuperAdmin (admin
    // global) no se sanea (ver `create`). `sanitizeCrossTenantRefs` mutá los nodos en el lugar.
    if (!isSuperAdmin) {
      const validTenantIds = await this.collectValidTenantIds(
        activeTenantId,
        id,
        undefined,
        userTenant?.userId,
      );
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

  /**
   * Variantes (Feriado/Guardia) configuradas para este flow como Principal.
   *
   * Con corte de pertenencia, igual que el resto de las operaciones sobre un `:id` de flujo
   * (`findByIdScoped`/`update`/`delete`/`assignTenants`): sin esto, `flows:read` en la propia
   * empresa alcanzaba para consultar las variantes de un flujo ajeno.
   */
  async listAlternatives(baseFlowId: string, userTenant?: CallerUserTenant) {
    await this.assertFlowAccessible(baseFlowId, userTenant, await this.isSuperAdmin(userTenant));
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
    userTenant?: CallerUserTenant,
  ) {
    if (!isValidScheduleEntryType(type)) {
      throw new BadRequestException(`Tipo de variante desconocido: "${type}"`);
    }
    // Corte de pertenencia sobre el flujo base Y sobre el de origen: sin esto, `flows:create`
    // en la empresa propia alcanzaba para crear una variante a partir de un flujo de otra
    // empresa, y la respuesta devolvía sus `nodes`/`edges` copiados enteros.
    const isSuperAdmin = await this.isSuperAdmin(userTenant);
    await this.assertFlowAccessible(baseFlowId, userTenant, isSuperAdmin);
    if (opts?.sourceFlowId) {
      await this.assertFlowAccessible(opts.sourceFlowId, userTenant, isSuperAdmin);
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
  async deleteVariant(baseFlowId: string, type: string, userTenant?: CallerUserTenant) {
    await this.assertFlowAccessible(baseFlowId, userTenant, await this.isSuperAdmin(userTenant));
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
