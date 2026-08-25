/**
 * 1.8 Flujos — CRUD y asignación por tenant (BE-FLW-*)
 *
 * Vía: endpoints REST reales (`/flows/*`) con supertest, sobre la base efímera. BE-FLW-08/09/10
 * (`findActiveFlowForTenant`) no tienen endpoint HTTP propio — se llaman directo sobre
 * `FlowService` (instancia real, sacada del `moduleRef`), que es la única forma de ejercitar esa
 * lógica sin inventar una ruta que no existe en producción.
 *
 * No hay frontera externa que mockear acá: CRUD de flujos es puro Nest + Postgres.
 *
 * Los casos invertidos (SEC-03) van como `it.failing`: verifican el comportamiento SEGURO que
 * hoy no existe (`FlowService.findById`/`update`/`delete`/`assignTenants`/`setDefault` no
 * scopean por tenant), así que hoy fallan y `it.failing` los da por verdes.
 */
import {
  createTestApp,
  TestApp,
  tokenFor,
  withAuth,
  http,
  createTenant,
  createRole,
  createUser,
  createFlow,
  createSkill,
  getSystemContext,
  uniqueEmail,
  uniqueSlug,
} from './support';
import { FlowService } from '../src/modules/flow/flow.service';

/** Permisos completos de flujos, para los tenants de negocio que arma este spec. */
const FLOW_CRUD_PERMS = ['flows:create', 'flows:read', 'flows:update', 'flows:delete'];

/** Arma una empresa + rol con CRUD de flujos + una persona con esa membresía. Devuelve también
 *  el token listo para usar con `withAuth`. */
async function buildTenantWithFlowsAccess(t: TestApp, label: string) {
  const tenant = await createTenant(t.prisma, { slug: uniqueSlug(label) });
  const role = await createRole(t.prisma, {
    tenantId: tenant.id,
    name: 'Gestor de flujos',
    permissions: FLOW_CRUD_PERMS,
  });
  const user = await createUser(t.prisma, {
    email: uniqueEmail(label),
    memberships: [{ tenantId: tenant.id, roleId: role.id }],
  });
  const token = tokenFor(t, user);
  return { tenant, role, user, token };
}

describe('1.8 Flujos (BE-FLW-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('BE-FLW-01: crear un flujo nace sin empresas asignadas', async () => {
    const { tenant, token } = await buildTenantWithFlowsAccess(t, 'flw01');

    const res = await withAuth(http(t).post('/flows'), token, tenant.id).send({
      name: 'Flujo nuevo',
      nodes: [],
      edges: [],
    });

    expect(res.status).toBe(201); // @Post() sin @HttpCode → default de Nest
    expect(res.body.name).toBe('Flujo nuevo');
    expect(res.body.tenantFlows).toEqual([]);
  });

  it('BE-FLW-02: un nodo con campos de ReactFlow no declarados (measured, selected) devuelve 400', async () => {
    const { tenant, token } = await buildTenantWithFlowsAccess(t, 'flw02');

    const res = await withAuth(http(t).post('/flows'), token, tenant.id).send({
      name: 'Flujo con ruido de ReactFlow',
      nodes: [
        {
          id: 'n1',
          type: 'message',
          data: { text: 'hola' },
          measured: { width: 150, height: 40 }, // no declarado en FlowNodeDto
          selected: false, // idem
        },
      ],
      edges: [],
    });

    expect(res.status).toBe(400);
    // No debería haber quedado persistido nada de ese intento.
    const count = await t.prisma.flow.count({ where: { name: 'Flujo con ruido de ReactFlow' } });
    expect(count).toBe(0);
  });

  it('BE-FLW-03: GET /flows parado en un tenant devuelve solo los flujos asignados a ese tenant', async () => {
    const { tenant: tenantA, token: tokenA } = await buildTenantWithFlowsAccess(t, 'flw03a');
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('flw03b') });

    const flowA = await createFlow(t.prisma, { name: 'Flujo de A', assign: [{ tenantId: tenantA.id }] });
    const flowB = await createFlow(t.prisma, { name: 'Flujo de B', assign: [{ tenantId: tenantB.id }] });

    const res = await withAuth(http(t).get('/flows'), tokenA, tenantA.id);

    expect(res.status).toBe(200);
    const ids = res.body.map((f: any) => f.id);
    expect(ids).toContain(flowA.id);
    expect(ids).not.toContain(flowB.id);
  });

  it('BE-FLW-04: GET /flows/all desde el tenant de sistema devuelve todos los flujos, tengan o no empresas', async () => {
    const { admin } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const orphanFlow = await createFlow(t.prisma, { name: uniqueSlug('flw04-huerfano') }); // sin assign

    const res = await withAuth(http(t).get('/flows/all'), token);

    expect(res.status).toBe(200);
    const ids = res.body.map((f: any) => f.id);
    expect(ids).toContain(orphanFlow.id);
  });

  it('BE-FLW-05: asignar como inicio a (empresa, rol) con otro flujo ya de inicio para ese par le saca el inicio al anterior', async () => {
    const { tenant, token, role } = await buildTenantWithFlowsAccess(t, 'flw05');
    // Un segundo rol de la MISMA empresa, con SU propio flujo de inicio: no debería tocarse.
    const otherRole = await createRole(t.prisma, { tenantId: tenant.id, name: 'Otro rol', permissions: [] });
    const untouchedFlow = await createFlow(t.prisma, {
      name: 'No debería tocarse',
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [otherRole.id] }],
    });
    const previousStart = await createFlow(t.prisma, {
      name: 'Inicio anterior',
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });
    const newStart = await createFlow(t.prisma, { name: 'Inicio nuevo', nodes: [], edges: [] });

    const res = await withAuth(http(t).post(`/flows/${newStart.id}/assign-tenants`), token, tenant.id).send({
      assignments: [{ tenantId: tenant.id, roleIds: [role.id] }],
      isStart: true,
    });

    expect(res.status).toBe(201); // @Post() default

    // El anterior deja de ser inicio PARA ESE ROL (se le borra la fila TenantFlowRole).
    const previousRoles = await t.prisma.tenantFlowRole.findMany({
      where: { roleId: role.id, tenantFlow: { flowId: previousStart.id } },
    });
    expect(previousRoles).toHaveLength(0);

    // El nuevo lo recibe.
    const newRoles = await t.prisma.tenantFlowRole.findMany({
      where: { roleId: role.id, tenantFlow: { flowId: newStart.id } },
    });
    expect(newRoles).toHaveLength(1);

    // El otro par (empresa, otherRole) no se tocó.
    const untouchedRoles = await t.prisma.tenantFlowRole.findMany({
      where: { roleId: otherRole.id, tenantFlow: { flowId: untouchedFlow.id } },
    });
    expect(untouchedRoles).toHaveLength(1);
  });

  it('BE-FLW-06: asignar con la misma empresa repetida colapsa uniendo los roles, sin romper el índice único', async () => {
    const { tenant, token } = await buildTenantWithFlowsAccess(t, 'flw06');
    const roleUno = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol uno', permissions: [] });
    const roleDos = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol dos', permissions: [] });
    const flow = await createFlow(t.prisma, { name: 'Flujo a asignar dos veces', nodes: [], edges: [] });

    const res = await withAuth(http(t).post(`/flows/${flow.id}/assign-tenants`), token, tenant.id).send({
      assignments: [
        { tenantId: tenant.id, roleIds: [roleUno.id] },
        { tenantId: tenant.id, roleIds: [roleDos.id] },
      ],
    });

    expect(res.status).toBe(201);
    const tenantFlowsForThisTenant = res.body.tenantFlows.filter((tf: any) => tf.tenant.id === tenant.id);
    expect(tenantFlowsForThisTenant).toHaveLength(1); // una sola fila TenantFlow, no dos
    const roleIds = tenantFlowsForThisTenant[0].roles.map((r: any) => r.roleId).sort();
    expect(roleIds).toEqual([roleUno.id, roleDos.id].sort());
  });

  it('BE-FLW-07: marcar un flujo como isDefault desmarca el default anterior (único global)', async () => {
    const flowViejo = await createFlow(t.prisma, { name: uniqueSlug('flw07-viejo'), isDefault: true });
    const flowNuevo = await createFlow(t.prisma, { name: uniqueSlug('flw07-nuevo') });
    const { tenant, token } = await buildTenantWithFlowsAccess(t, 'flw07');

    const res = await withAuth(http(t).post(`/flows/${flowNuevo.id}/default`), token, tenant.id);

    expect(res.status).toBe(201);
    const reloadedViejo = await t.prisma.flow.findUnique({ where: { id: flowViejo.id } });
    const reloadedNuevo = await t.prisma.flow.findUnique({ where: { id: flowNuevo.id } });
    expect(reloadedViejo!.isDefault).toBe(false);
    expect(reloadedNuevo!.isDefault).toBe(true);
  });

  it('BE-FLW-08: findActiveFlowForTenant con un rol que tiene inicio propio activo devuelve ese flujo', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('flw08') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol con inicio', permissions: [] });
    const flow = await createFlow(t.prisma, {
      name: 'Inicio propio',
      isActive: true,
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });

    const flowService = t.moduleRef.get(FlowService, { strict: false });
    const result = await flowService.findActiveFlowForTenant(tenant.id, role.id);

    expect(result?.id).toBe(flow.id);
  });

  it('BE-FLW-09: un rol sin flujo de inicio propio cae al default global activo; sin default, null', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('flw09') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol sin inicio', permissions: [] });
    const flowService = t.moduleRef.get(FlowService, { strict: false });

    // Sin ningún default activo en toda la BD → null. Nos aseguramos apagando cualquier
    // default que haya quedado de otro test de este archivo (todos corren contra la misma base).
    await t.prisma.flow.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const sinDefault = await flowService.findActiveFlowForTenant(tenant.id, role.id);
    expect(sinDefault).toBeNull();

    const defaultFlow = await createFlow(t.prisma, { name: uniqueSlug('flw09-default'), isDefault: true, isActive: true });
    const conDefault = await flowService.findActiveFlowForTenant(tenant.id, role.id);
    expect(conDefault?.id).toBe(defaultFlow.id);
  });

  it('BE-FLW-10: un flujo de inicio existente pero isActive:false no se usa; cae al default', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('flw10') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol con inicio inactivo', permissions: [] });
    await createFlow(t.prisma, {
      name: 'Inicio inactivo',
      isActive: false,
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });
    // `isDefault` único no es una constraint de BD (solo la garantiza `FlowService.setDefault`,
    // ver AGENTS.md): otro test de este archivo pudo haber dejado un default propio por fixture
    // directa. Se limpia para que este caso sea determinista sin depender del orden de corrida.
    await t.prisma.flow.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const defaultFlow = await createFlow(t.prisma, {
      name: uniqueSlug('flw10-default'),
      isDefault: true,
      isActive: true,
    });

    const flowService = t.moduleRef.get(FlowService, { strict: false });
    const result = await flowService.findActiveFlowForTenant(tenant.id, role.id);

    expect(result?.id).toBe(defaultFlow.id); // NO el inicio inactivo
  });

  it('BE-FLW-11: GET /flows/:id devuelve 200 con nodos/aristas/asignaciones; 404 si no existe', async () => {
    const { tenant, token } = await buildTenantWithFlowsAccess(t, 'flw11');
    const flow = await createFlow(t.prisma, {
      name: 'Flujo con contenido',
      nodes: [{ id: 'n1', type: 'message', data: { text: 'hola' } }],
      edges: [],
      assign: [{ tenantId: tenant.id }],
    });

    const ok = await withAuth(http(t).get(`/flows/${flow.id}`), token, tenant.id);
    expect(ok.status).toBe(200);
    expect(ok.body.nodes).toHaveLength(1);
    expect(ok.body.tenantFlows).toHaveLength(1);

    const notFound = await withAuth(http(t).get('/flows/no-existe-este-id'), token, tenant.id);
    expect(notFound.status).toBe(404);
    expect(notFound.body.message).toBe('Flujo no encontrado');
  });

  it('BE-FLW-12: PATCH /flows/:id edita nodos/aristas, no toca los campos ausentes, y sigue filtrando la whitelist', async () => {
    const { tenant, token } = await buildTenantWithFlowsAccess(t, 'flw12');
    const flow = await createFlow(t.prisma, {
      name: 'Nombre original',
      nodes: [{ id: 'n1', type: 'message', data: { text: 'v1' } }],
      edges: [],
    });

    const res = await withAuth(http(t).patch(`/flows/${flow.id}`), token, tenant.id).send({
      nodes: [{ id: 'n1', type: 'message', data: { text: 'v2' } }],
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Nombre original'); // no se mandó `name`: no se toca
    expect(res.body.nodes[0].data.text).toBe('v2');

    const badWhitelist = await withAuth(http(t).patch(`/flows/${flow.id}`), token, tenant.id).send({
      nodes: [{ id: 'n1', type: 'message', data: { text: 'v3' }, measured: { width: 1, height: 1 } }],
    });
    expect(badWhitelist.status).toBe(400);
  });

  it('BE-FLW-13: DELETE /flows/:id devuelve 200 y borra físicamente (cascade en TenantFlow/roles)', async () => {
    const { tenant, token, role } = await buildTenantWithFlowsAccess(t, 'flw13');
    const flow = await createFlow(t.prisma, {
      name: 'Para borrar',
      assign: [{ tenantId: tenant.id, roleIds: [role.id] }],
    });

    const res = await withAuth(http(t).delete(`/flows/${flow.id}`), token, tenant.id);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Flujo eliminado');
    expect(await t.prisma.flow.findUnique({ where: { id: flow.id } })).toBeNull();
    expect(await t.prisma.tenantFlow.findMany({ where: { flowId: flow.id } })).toHaveLength(0);
  });

  // --- BE-FLW-14 (SEC-03): operar por id sobre un flujo de OTRA empresa debe cortar ---
  describe('BE-FLW-14 (SEC-03): acceso por id a un flujo de otra empresa', () => {
    it.failing('BE-FLW-14: GET /flows/:id de un flujo de otra empresa debe devolver 403/404 (SEC-03) @invertido', async () => {
      const { token: tokenA, tenant: tenantA } = await buildTenantWithFlowsAccess(t, 'flw14geta');
      const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('flw14getb') });
      const flowB = await createFlow(t.prisma, { name: 'Flujo privado de B', assign: [{ tenantId: tenantB.id }] });

      const res = await withAuth(http(t).get(`/flows/${flowB.id}`), tokenA, tenantA.id);

      // SEGURO: un flujo de otra empresa no debería poder leerse por id. Hoy `findById` no
      // filtra por tenant → devuelve 200 con el flujo de B igual.
      expect([403, 404]).toContain(res.status);
    });

    it.failing('BE-FLW-14: PATCH /flows/:id de un flujo de otra empresa debe devolver 403/404 (SEC-03) @invertido', async () => {
      const { token: tokenA, tenant: tenantA } = await buildTenantWithFlowsAccess(t, 'flw14patcha');
      const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('flw14patchb') });
      const flowB = await createFlow(t.prisma, { name: 'Flujo privado de B (patch)', assign: [{ tenantId: tenantB.id }] });

      const res = await withAuth(http(t).patch(`/flows/${flowB.id}`), tokenA, tenantA.id).send({
        name: 'Modificado desde A',
      });

      // SEGURO: editar por id un flujo ajeno debería cortar. Hoy `update` no filtra por tenant
      // → 200 y el nombre queda modificado.
      expect([403, 404]).toContain(res.status);
    });

    it.failing('BE-FLW-14: DELETE /flows/:id de un flujo de otra empresa debe devolver 403/404 (SEC-03) @invertido', async () => {
      const { token: tokenA, tenant: tenantA } = await buildTenantWithFlowsAccess(t, 'flw14dela');
      const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('flw14delb') });
      const flowB = await createFlow(t.prisma, { name: 'Flujo privado de B (delete)', assign: [{ tenantId: tenantB.id }] });

      const res = await withAuth(http(t).delete(`/flows/${flowB.id}`), tokenA, tenantA.id);

      // SEGURO: borrar por id un flujo ajeno debería cortar. Hoy `delete` no filtra por tenant
      // → 200 y el flujo de B desaparece de verdad.
      expect([403, 404]).toContain(res.status);
    });
  });

  // --- BE-FLW-16 (SEC-03): mismo criterio para assign-tenants y default ---
  describe('BE-FLW-16 (SEC-03): assign-tenants/default sobre un flujo de otra empresa', () => {
    it.failing(
      'BE-FLW-16: POST /flows/:id/assign-tenants con el id de un flujo de otra empresa debe devolver 403/404 (SEC-03) @invertido',
      async () => {
        const { token: tokenA, tenant: tenantA } = await buildTenantWithFlowsAccess(t, 'flw16assigna');
        const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('flw16assignb') });
        const flowB = await createFlow(t.prisma, { name: 'Flujo de B (assign)', assign: [{ tenantId: tenantB.id }] });

        const res = await withAuth(http(t).post(`/flows/${flowB.id}/assign-tenants`), tokenA, tenantA.id).send({
          assignments: [{ tenantId: tenantA.id }],
        });

        // SEGURO: reasignar por id un flujo ajeno debería cortar. Hoy opera sin filtrar por
        // tenant → 201 y A le roba la asignación del flujo de B.
        expect([403, 404]).toContain(res.status);
      },
    );

    it.failing(
      'BE-FLW-16: POST /flows/:id/default con el id de un flujo de otra empresa debe devolver 403/404 (SEC-03) @invertido',
      async () => {
        const { token: tokenA, tenant: tenantA } = await buildTenantWithFlowsAccess(t, 'flw16defaulta');
        const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('flw16defaultb') });
        const flowB = await createFlow(t.prisma, { name: 'Flujo de B (default)', assign: [{ tenantId: tenantB.id }] });

        const res = await withAuth(http(t).post(`/flows/${flowB.id}/default`), tokenA, tenantA.id);

        // SEGURO: marcar default por id un flujo ajeno debería cortar. Hoy opera sin filtrar
        // por tenant → 201 y el flujo de B pasa a ser el default global, decidido por alguien
        // de A que ni siquiera lo tiene asignado.
        expect([403, 404]).toContain(res.status);
      },
    );
  });

  it('BE-FLW-15: context fuera de la lista cerrada devuelve 400; uno válido se persiste', async () => {
    const { tenant, token } = await buildTenantWithFlowsAccess(t, 'flw15');

    const invalido = await withAuth(http(t).post('/flows'), token, tenant.id).send({
      name: 'Flujo con context inválido',
      nodes: [],
      edges: [],
      context: 'no_existe_este_valor',
    });
    expect(invalido.status).toBe(400);

    const valido = await withAuth(http(t).post('/flows'), token, tenant.id).send({
      name: 'Flujo con context válido',
      nodes: [],
      edges: [],
      context: 'invgate',
    });
    expect(valido.status).toBe(201);
    expect(valido.body.context).toBe('invgate');
  });

  it('BE-FLW-17: vincular una Skill a un flujo se refleja en findById; skillId:null desvincula', async () => {
    const { tenant, token } = await buildTenantWithFlowsAccess(t, 'flw17');
    const skill = await createSkill(t.prisma, {
      tenantId: tenant.id,
      name: uniqueSlug('flw17-skill'),
      promptText: 'Sos un asistente de facturación.',
    });
    const flow = await createFlow(t.prisma, { name: 'Flujo con skill', nodes: [], edges: [] });

    const linked = await withAuth(http(t).patch(`/flows/${flow.id}`), token, tenant.id).send({
      skillId: skill.id,
    });
    expect(linked.status).toBe(200);
    expect(linked.body.skill).toMatchObject({
      id: skill.id,
      name: skill.name,
      promptText: skill.promptText,
    });

    const unlinked = await withAuth(http(t).patch(`/flows/${flow.id}`), token, tenant.id).send({
      skillId: null,
    });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.skill).toBeNull();
  });

  it('BE-FLW-18: GET /flows/mine arma la lista por userId y devuelve los flujos de otra empresa aunque el header apunte a una donde no hay flows:read', async () => {
    // Escenario deliberadamente más estricto que su hermano `BE-ARE-05`: el usuario tiene
    // `flows:read` SOLO en la empresa B, y se para en la A (header) donde NO lo tiene. `/flows/mine`
    // debe devolver igual los flujos de B, porque la autorización es por-empresa adentro del
    // servicio, no sobre el tenant activo. Si alguien repusiera `@RequirePermission('flows','read')`
    // en el controlador, `RolesGuard` lo evaluaría contra el rol de A (sin el permiso) y cortaría
    // con 403: este caso rompería y avisaría de la regresión.
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('flw18-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('flw18-b') });
    const roleSinFlows = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Rol sin flujos', permissions: ['users:read'] });
    const roleConFlows = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol con flujos', permissions: ['flows:read'] });
    const flowA = await createFlow(t.prisma, { name: 'Flujo en A', assign: [{ tenantId: tenantA.id }] });
    const flowB = await createFlow(t.prisma, { name: 'Flujo en B', assign: [{ tenantId: tenantB.id }] });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('flw18'),
      memberships: [
        { tenantId: tenantA.id, roleId: roleSinFlows.id },
        { tenantId: tenantB.id, roleId: roleConFlows.id },
      ],
    });
    const token = tokenFor(t, user);

    // Parado en A (donde NO tiene flows:read), pero la lista sale del userId.
    const res = await withAuth(http(t).get('/flows/mine'), token, tenantA.id);

    expect(res.status).toBe(200); // NO 403, aunque el rol de A no tenga flows:read
    const ids = res.body.map((f: any) => f.id);
    expect(ids).toContain(flowB.id); // los de la empresa donde SÍ tiene el permiso
    expect(ids).not.toContain(flowA.id); // no los de A: ahí no tiene flows:read
  });

  it('BE-FLW-19: GET /flows/mine de un usuario sin flows:read en ninguna empresa devuelve [] (no 403)', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('flw19') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol sin flujos', permissions: ['users:read'] });
    await createFlow(t.prisma, { name: 'Flujo de la empresa', assign: [{ tenantId: tenant.id }] });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('flw19'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/flows/mine'), token); // 1 sola membresía: header opcional

    // Sin flows:read en ninguna empresa: lista vacía, no 403. Un `@RequirePermission` repuesto
    // en el controlador daría 403 acá — otra red de seguridad del mismo cambio.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('BE-FLW-20: assign-tenants con un roleId de otra empresa (o inexistente) devuelve 400 y no persiste la asignación', async () => {
    const { tenant, token } = await buildTenantWithFlowsAccess(t, 'flw20');
    // Rol de OTRA empresa: no puede habilitar la recepción de un flujo en `tenant`.
    const otherTenant = await createTenant(t.prisma, { slug: uniqueSlug('flw20-otra') });
    const foreignRole = await createRole(t.prisma, { tenantId: otherTenant.id, name: 'Rol ajeno', permissions: [] });
    const flow = await createFlow(t.prisma, { name: 'Flujo a asignar (flw20)', nodes: [], edges: [] });

    // `applyTenantAssignment` valida la pertenencia de cada roleId ANTES de la transacción de
    // reemplazo (ver flow.service.ts): un rol de otra empresa corta con 400 y mensaje explícito.
    const conRolAjeno = await withAuth(http(t).post(`/flows/${flow.id}/assign-tenants`), token, tenant.id).send({
      assignments: [{ tenantId: tenant.id, roleIds: [foreignRole.id] }],
    });
    expect(conRolAjeno.status).toBe(400);
    expect(conRolAjeno.body.message).toBe(
      `El rol ${foreignRole.id} no existe o no pertenece al tenant ${tenant.id}`,
    );

    // Un roleId inexistente cae por el mismo camino (no está en el mapa `tenantByRole` → mismatch).
    const roleInexistente = 'rol-que-no-existe';
    const conRolInexistente = await withAuth(http(t).post(`/flows/${flow.id}/assign-tenants`), token, tenant.id).send({
      assignments: [{ tenantId: tenant.id, roleIds: [roleInexistente] }],
    });
    expect(conRolInexistente.status).toBe(400);
    expect(conRolInexistente.body.message).toBe(
      `El rol ${roleInexistente} no existe o no pertenece al tenant ${tenant.id}`,
    );

    // La validación corta antes del `$transaction`: no quedó ninguna asignación para ese flujo.
    const tenantFlows = await t.prisma.tenantFlow.findMany({ where: { flowId: flow.id } });
    expect(tenantFlows).toHaveLength(0);
  });

  // --- BE-FLW-21 (❌ robustez): el DTO de nodo no valida rango/forma de los campos de `llm_query` ---
  // Invertidos (`it.failing`): asertan el comportamiento SEGURO (que el endpoint rechace con 400
  // los valores inválidos). Hoy `FlowNodeDataDto` valida `temperature` solo con `@IsNumber` (sin
  // rango), `maxAttempts` sin ningún validador de tipo, y `extractVariables` solo con `@IsArray`
  // (sin `@ValidateNested`/`@Type` por item), así que esos valores pasan y el flujo se crea (201).
  // Cuando se endurezca el DTO, estos tests pasarán a verde real y hay que sacarles el `.failing`.
  describe('BE-FLW-21: validación de rango/forma de los campos de un nodo llm_query', () => {
    it.failing('BE-FLW-21: temperature fuera de rango (999) debería rechazarse con 400 @invertido', async () => {
      const { tenant, token } = await buildTenantWithFlowsAccess(t, 'flw21temp');

      const res = await withAuth(http(t).post('/flows'), token, tenant.id).send({
        name: 'Flujo temperature inválida',
        nodes: [{ id: 'n1', type: 'llm_query', data: { temperature: 999 } }],
        edges: [],
      });

      // SEGURO: temperature vive en 0-2 (ver el comentario del campo en flow-elements.dto.ts).
      // Hoy el DTO la valida solo con `@IsNumber`, sin rango → 999 pasa y el flujo se crea.
      expect(res.status).toBe(400);
    });

    it.failing('BE-FLW-21: maxAttempts no numérico ("abc") debería rechazarse con 400 @invertido', async () => {
      const { tenant, token } = await buildTenantWithFlowsAccess(t, 'flw21max');

      const res = await withAuth(http(t).post('/flows'), token, tenant.id).send({
        name: 'Flujo maxAttempts inválido',
        nodes: [{ id: 'n1', type: 'llm_query', data: { maxAttempts: 'abc' } }],
        edges: [],
      });

      // SEGURO: maxAttempts es una cantidad de reintentos (debería llevar `@IsNumber`/`@Min`).
      // Hoy el DTO lo declara solo `@IsOptional`, sin validador de tipo → "abc" pasa.
      expect(res.status).toBe(400);
    });

    it.failing(
      'BE-FLW-21: un item de extractVariables sin forma (sin `variable`) debería rechazarse con 400 @invertido',
      async () => {
        const { tenant, token } = await buildTenantWithFlowsAccess(t, 'flw21extract');

        const res = await withAuth(http(t).post('/flows'), token, tenant.id).send({
          name: 'Flujo extractVariables inválido',
          nodes: [{ id: 'n1', type: 'llm_query', data: { extractVariables: [{ noEsVariable: 'x' }] } }],
          edges: [],
        });

        // SEGURO: cada item necesita al menos `variable: string` (debería llevar
        // `@ValidateNested({ each: true })` + `@Type(...)`). Hoy `extractVariables` se valida
        // solo con `@IsArray` → un item sin esquema pasa sin control.
        expect(res.status).toBe(400);
      },
    );
  });
});
