/**
 * 1.26 Variantes de flujo por feriado/guardia (BE-VAR-*)
 *
 * Vía: endpoints REST reales (`/flows/:id/variants`) con supertest sobre la base efímera, más
 * `FlowService.findActiveFlowForTenant` tomado del contenedor para los casos que dependen del
 * instante consultado (BE-VAR-09), y `POST /conversations/simulate` —que atraviesa el broker
 * efímero— para el caso de la conversación en curso (BE-VAR-10).
 *
 * Frontera mockeada: `LlmService` (el motor de flujos, los guards y el servicio de flujos se
 * ejercitan de verdad).
 *
 * BE-VAR-11 va como `it.failing`: verifica el comportamiento correcto que hoy NO existe
 * (borrar el Principal debería llevarse sus variantes).
 */
import { LlmService } from '../src/modules/llm/llm.service';
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
  uniqueEmail,
  uniquePhone,
  uniqueSlug,
  FakeLlmService,
  startNode,
  messageNode,
  inputNode,
  endNode,
  edge,
} from './support';
import { FlowService } from '../src/modules/flow/flow.service';

const FLOW_PERMS = ['flows:read', 'flows:create', 'flows:update', 'flows:delete'];

describe('1.26 Variantes de flujo por feriado/guardia (BE-VAR-*)', () => {
  let t: TestApp;
  let llm: FakeLlmService;
  let flowService: FlowService;

  let tenantA: { id: string };
  let tenantB: { id: string };
  let roleA: { id: string };
  let roleB: { id: string };
  let tokenA: string;
  let tokenB: string;

  /** Flujo base de la empresa A, recreado en cada test (los tests lo mutan). */
  let base: { id: string; name: string };

  beforeAll(async () => {
    llm = new FakeLlmService();
    t = await createTestApp({ customize: (b) => b.overrideProvider(LlmService).useValue(llm) });
    flowService = t.moduleRef.get(FlowService);

    tenantA = await createTenant(t.prisma, { slug: uniqueSlug('var-a') });
    tenantB = await createTenant(t.prisma, { slug: uniqueSlug('var-b') });
    roleA = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Flujos A', permissions: FLOW_PERMS });
    roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Flujos B', permissions: FLOW_PERMS });
    const userA = await createUser(t.prisma, {
      email: uniqueEmail('var-a'),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const userB = await createUser(t.prisma, {
      email: uniqueEmail('var-b'),
      memberships: [{ tenantId: tenantB.id, roleId: roleB.id }],
    });
    tokenA = tokenFor(t, userA);
    tokenB = tokenFor(t, userB);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    llm.reset();
    // `resolvePrincipalFlow` toma el PRIMER TenantFlow con `isStart` de (empresa, rol), y estos
    // fixtures crean flujos por Prisma (sin pasar por `applyTenantAssignment`, que es quien
    // aplica la invariante "un flujo de inicio por empresa"). Sin esta limpieza, el flujo del
    // primer test le gana a los de los siguientes y BE-VAR-08/09/10 resuelven contra él.
    await t.prisma.tenantFlow.deleteMany({ where: { tenantId: tenantA.id } });
    base = await createFlow(t.prisma, {
      name: `Principal ${uniqueSlug('f')}`,
      description: 'El flujo de todos los días',
      nodes: [startNode('s'), messageNode('m', 'Mensaje del Principal'), endNode('e')],
      edges: [edge('s', 'm', 'known'), edge('m', 'e')],
      assign: [{ tenantId: tenantA.id, isStart: true, roleIds: [roleA.id] }],
    });
  });

  afterEach(async () => {
    await t.prisma.scheduleCalendarEntry.deleteMany({
      where: { tenantId: { in: [tenantA.id, tenantB.id] } },
    });
  });

  const listVariants = (flowId: string, token = tokenA, tenantId = tenantA.id) =>
    withAuth(http(t).get(`/flows/${flowId}/variants`), token, tenantId);

  const createVariant = (
    flowId: string,
    body: Record<string, unknown>,
    token = tokenA,
    tenantId = tenantA.id,
  ) => withAuth(http(t).post(`/flows/${flowId}/variants`), token, tenantId).send(body);

  const deleteVariant = (flowId: string, type: string, token = tokenA, tenantId = tenantA.id) =>
    withAuth(http(t).delete(`/flows/${flowId}/variants/${type}`), token, tenantId);

  // --- BE-VAR-01 / 02 / 03 / 04 / 05 ---

  it('BE-VAR-01: GET /flows/:id/variants lista los tipos configurados con su variantFlowId', async () => {
    const vacio = await listVariants(base.id);
    expect(vacio.status).toBe(200);
    expect(vacio.body).toEqual([]);

    const creada = await createVariant(base.id, { type: 'feriado' });

    const res = await listVariants(base.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ type: 'feriado', variantFlowId: creada.body.id }]);
  });

  it('BE-VAR-02: sin opciones, la variante duplica el grafo del Principal', async () => {
    const res = await createVariant(base.id, { type: 'feriado' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`${base.name} (feriado)`);
    expect(res.body.isActive).toBe(true);
    expect(res.body.isDefault).toBe(false);
    expect(res.body.description).toBe('El flujo de todos los días');
    expect(res.body.nodes.map((n: any) => n.id)).toEqual(['s', 'm', 'e']);
    // Nace sin empresas asignadas: nunca elegible por sí sola.
    const asignaciones = await t.prisma.tenantFlow.count({ where: { flowId: res.body.id } });
    expect(asignaciones).toBe(0);
  });

  it('BE-VAR-02: con sourceFlowId, la variante copia el grafo de ese otro flujo', async () => {
    const otro = await createFlow(t.prisma, {
      name: 'Otro flujo de A',
      nodes: [startNode('os'), messageNode('om', 'Vengo del otro flujo'), endNode('oe')],
      edges: [edge('os', 'om', 'known'), edge('om', 'oe')],
      assign: [{ tenantId: tenantA.id }],
    });

    const res = await createVariant(base.id, { type: 'guardia', sourceFlowId: otro.id });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`${base.name} (guardia)`);
    expect(res.body.nodes.map((n: any) => n.id)).toEqual(['os', 'om', 'oe']);
  });

  it('BE-VAR-02: con blank:true, la variante arranca con un único nodo start', async () => {
    const res = await createVariant(base.id, { type: 'feriado', blank: true });

    expect(res.status).toBe(201);
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.nodes[0].type).toBe('start');
    expect(res.body.edges).toEqual([]);
    expect(res.body.description).toBeNull();
  });

  it('BE-VAR-03: crear dos veces la variante del mismo tipo devuelve 409', async () => {
    await createVariant(base.id, { type: 'feriado' });

    const res = await createVariant(base.id, { type: 'feriado' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Ya existe una variante de este tipo para este flujo');
  });

  it('BE-VAR-04: un type fuera del catálogo de tipos del calendario devuelve 400', async () => {
    const res = await createVariant(base.id, { type: 'vacaciones' });

    // El corte efectivo por HTTP lo pone el `@IsIn` del DTO (mismo catálogo que valida
    // `ScheduleCalendarEntry.type`), así que el mensaje es el del DTO y no el
    // "Tipo de variante desconocido" del servicio, que queda como red de seguridad interna.
    expect(res.status).toBe(400);
    const msg = String(res.body.message);
    expect(msg).toContain('feriado');
    expect(msg).toContain('guardia');
    expect(await t.prisma.flowAlternative.count({ where: { baseFlowId: base.id } })).toBe(0);
  });

  it('BE-VAR-05: DELETE borra la fila Flow variante y su FlowAlternative', async () => {
    const creada = await createVariant(base.id, { type: 'guardia' });

    const res = await deleteVariant(base.id, 'guardia');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(await t.prisma.flow.findUnique({ where: { id: creada.body.id } })).toBeNull();
    expect(await t.prisma.flowAlternative.count({ where: { baseFlowId: base.id } })).toBe(0);
  });

  it('BE-VAR-05: borrar un tipo sin variante configurada devuelve 404', async () => {
    const res = await deleteVariant(base.id, 'feriado');

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('No hay variante de ese tipo para este flujo');
  });

  // --- BE-VAR-06 / 07: aislamiento entre empresas ---

  it('BE-VAR-06: listar, crear y borrar variantes de un flujo ajeno devuelve 404 en los tres', async () => {
    await createVariant(base.id, { type: 'feriado' });

    const list = await listVariants(base.id, tokenB, tenantB.id);
    const create = await createVariant(base.id, { type: 'guardia' }, tokenB, tenantB.id);
    const del = await deleteVariant(base.id, 'feriado', tokenB, tenantB.id);

    for (const res of [list, create, del]) {
      expect(res.status).toBe(404);
    }
    // Y no se filtró el grafo del flujo ajeno en ninguna respuesta.
    expect(JSON.stringify(create.body)).not.toContain('Mensaje del Principal');
    expect(await t.prisma.flowAlternative.count({ where: { baseFlowId: base.id } })).toBe(1);
  });

  it('BE-VAR-07: crear una variante propia con un sourceFlowId de otra empresa devuelve 404', async () => {
    const ajeno = await createFlow(t.prisma, {
      name: 'Flujo de B',
      nodes: [startNode('bs'), messageNode('bm', 'Secreto de B'), endNode('be')],
      edges: [edge('bs', 'bm', 'known'), edge('bm', 'be')],
      assign: [{ tenantId: tenantB.id }],
    });

    const res = await createVariant(base.id, { type: 'feriado', sourceFlowId: ajeno.id });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Secreto de B');
    expect(await t.prisma.flowAlternative.count({ where: { baseFlowId: base.id } })).toBe(0);
  });

  // --- BE-VAR-08: la variante no aparece en listados ---

  it('BE-VAR-08: la fila variante no aparece en GET /flows ni en /flows/mine', async () => {
    const variante = await createVariant(base.id, { type: 'feriado' });

    const listado = await withAuth(http(t).get('/flows'), tokenA, tenantA.id);
    const mios = await withAuth(http(t).get('/flows/mine'), tokenA, tenantA.id);

    expect(listado.status).toBe(200);
    expect(listado.body.map((f: any) => f.id)).toContain(base.id);
    expect(listado.body.map((f: any) => f.id)).not.toContain(variante.body.id);
    expect(mios.body.map((f: any) => f.id)).not.toContain(variante.body.id);
  });

  it('BE-VAR-08: la variante tampoco es elegible como flujo de inicio por sí misma', async () => {
    const variante = await createVariant(base.id, { type: 'feriado' });

    // Sin feriado vigente, el flujo activo es el Principal — nunca la variante.
    const activo = await flowService.findActiveFlowForTenant(
      tenantA.id,
      roleA.id,
      new Date('2026-07-09T12:00:00.000Z'),
    );

    expect(activo?.id).toBe(base.id);
    expect(activo?.id).not.toBe(variante.body.id);
  });

  // --- BE-VAR-09: findActiveFlowForTenant con y sin estado temporal ---

  describe('BE-VAR-09: findActiveFlowForTenant con y sin estado temporal', () => {
    const instante = new Date('2026-07-09T12:00:00.000Z');

    const sembrarFeriado = () =>
      t.prisma.scheduleCalendarEntry.create({
        data: {
          tenantId: tenantA.id,
          type: 'feriado',
          title: 'Feriado de prueba',
          roleId: null,
          allDay: true,
          startAt: new Date('2026-07-09T00:00:00.000Z'),
          endAt: new Date('2026-07-09T23:59:00.000Z'),
        },
      });

    it('BE-VAR-09: sin feriado ni guardia devuelve el Principal', async () => {
      await createVariant(base.id, { type: 'feriado' });

      const activo = await flowService.findActiveFlowForTenant(tenantA.id, roleA.id, instante);

      expect(activo?.id).toBe(base.id);
    });

    it('BE-VAR-09: con el estado resuelto y la variante activa devuelve la variante', async () => {
      const variante = await createVariant(base.id, { type: 'feriado' });
      await sembrarFeriado();

      const activo = await flowService.findActiveFlowForTenant(tenantA.id, roleA.id, instante);

      expect(activo?.id).toBe(variante.body.id);
    });

    it('BE-VAR-09: con la variante inactiva cae al Principal', async () => {
      const variante = await createVariant(base.id, { type: 'feriado' });
      await t.prisma.flow.update({ where: { id: variante.body.id }, data: { isActive: false } });
      await sembrarFeriado();

      const activo = await flowService.findActiveFlowForTenant(tenantA.id, roleA.id, instante);

      expect(activo?.id).toBe(base.id);
    });

    it('BE-VAR-09: con el estado resuelto pero sin variante para ese tipo cae al Principal', async () => {
      await createVariant(base.id, { type: 'guardia' }); // configurada para el OTRO tipo
      await sembrarFeriado();

      const activo = await flowService.findActiveFlowForTenant(tenantA.id, roleA.id, instante);

      expect(activo?.id).toBe(base.id);
    });
  });

  // --- BE-VAR-10: la variante se elige una sola vez, al iniciar ---

  it('BE-VAR-10: un feriado que empieza a mitad de la charla no cambia el flujo en curso', async () => {
    // Flujo Principal que espera una respuesta, para que la charla siga viva entre mensajes.
    await t.prisma.tenantFlow.deleteMany({ where: { flowId: base.id } });
    const principal = await createFlow(t.prisma, {
      name: `Principal con espera ${uniqueSlug('f')}`,
      nodes: [
        startNode('ps'),
        inputNode('pi', { text: '¿Cuál es tu consulta?', variableName: 'consulta' }),
        messageNode('pm', 'Respuesta del PRINCIPAL'),
        endNode('pe'),
      ],
      edges: [edge('ps', 'pi', 'known'), edge('pi', 'pm'), edge('pm', 'pe')],
      assign: [{ tenantId: tenantA.id, isStart: true, roleIds: [roleA.id] }],
    });
    const variante = await createVariant(principal.id, { type: 'feriado', blank: true });
    await t.prisma.flow.update({
      where: { id: variante.body.id },
      data: {
        nodes: [
          startNode('vs'),
          messageNode('vm', 'Respuesta de la VARIANTE'),
          endNode('ve'),
        ] as never,
        edges: [edge('vs', 'vm', 'known'), edge('vm', 've')] as never,
      },
    });

    const phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('var-chat'),
      phone,
      firstName: 'Vera',
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const simulate = (body: string) =>
      http(t)
        .post('/conversations/simulate')
        .set('Authorization', `Bearer ${t.authToken}`)
        .send({ from: phone, body, tenantId: tenantA.id });

    const primero = await simulate('hola');
    expect(primero.body.reply).toContain('¿Cuál es tu consulta?');

    // El feriado arranca AHORA, con la conversación ya iniciada.
    const ahora = new Date();
    await t.prisma.scheduleCalendarEntry.create({
      data: {
        tenantId: tenantA.id,
        type: 'feriado',
        title: 'Feriado que empieza a mitad',
        roleId: null,
        allDay: true,
        startAt: new Date(ahora.getTime() - 60_000),
        endAt: new Date(ahora.getTime() + 3_600_000),
      },
    });

    const segundo = await simulate('no me anda la impresora');

    expect(segundo.body.reply).toContain('Respuesta del PRINCIPAL');
    expect(segundo.body.reply).not.toContain('Respuesta de la VARIANTE');
  });

  // --- BE-VAR-11: invertido ---

  it.failing(
    'BE-VAR-11: borrar el Principal debería llevarse sus filas Flow variantes (hoy quedan huérfanas)',
    async () => {
      const variante = await createVariant(base.id, { type: 'feriado' });

      await withAuth(http(t).delete(`/flows/${base.id}`), tokenA, tenantA.id);

      // Comportamiento correcto esperado: la variante se borra junto con su base, como hace
      // `deleteVariant`. Hoy el cascade solo se lleva el `FlowAlternative`, así que la fila
      // Flow variante sobrevive y —al perder su FlowAlternative— deja de estar excluida por
      // `variantOf: null` y reaparece en los listados del superusuario.
      const huerfana = await t.prisma.flow.findUnique({ where: { id: variante.body.id } });
      expect(huerfana).toBeNull();
    },
  );
});
