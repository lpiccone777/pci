/**
 * 1.23 Skills (BE-SKL-*)
 *
 * Vía: endpoints REST reales (`/skills/*`, `/flows/*`) con supertest, sobre la base efímera.
 *
 * BE-SKL-08 y BE-SKL-10 son de RUNTIME (motor de conversaciones, no CRUD): la única forma real
 * de comprobarlos es dejar una `Conversation` parada justo en un nodo `llm_query` de un flujo
 * con Skill vinculada, y disparar `POST /conversations/simulate` (mismo camino que un mensaje
 * real: RabbitMQ de punta a punta, ver `ConversationsService`). La frontera que se mockea ahí es
 * el LLM (`LlmService` → `FakeLlmService`, mismo patrón que usaría un test de CHAT-*): así se
 * puede leer el `systemPrompt` con el que se lo llamó y comprobar si el texto de la Skill entró
 * o no — sin eso, el texto se pierde adentro de la llamada al proveedor real.
 *
 * Los casos invertidos (SEC-17 y el de robustez de BE-SKL-10) van como `it.failing`: verifican
 * el comportamiento SEGURO que hoy no existe, así que hoy fallan y `it.failing` los da por
 * verdes.
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
  uniqueEmail,
  uniquePhone,
  uniqueSlug,
} from './support';
import { LlmService } from '../src/modules/llm/llm.service';
import { FakeLlmService } from './support/mocks';

const SKILL_CRUD_PERMS = ['skills:create', 'skills:read', 'skills:update', 'skills:delete'];
const FLOW_CRUD_PERMS = ['flows:create', 'flows:read', 'flows:update', 'flows:delete'];

async function buildTenantWithPerms(t: TestApp, label: string, perms: string[]) {
  const tenant = await createTenant(t.prisma, { slug: uniqueSlug(label) });
  const role = await createRole(t.prisma, { tenantId: tenant.id, name: `Rol ${label}`, permissions: perms });
  const user = await createUser(t.prisma, {
    email: uniqueEmail(label),
    memberships: [{ tenantId: tenant.id, roleId: role.id }],
  });
  const token = tokenFor(t, user);
  return { tenant, role, user, token };
}

/** Nodo `llm_query` mínimo, y el flujo posicionado ahí de entrada (sin pasar por `start`):
 *  lo único que importa para BE-SKL-08/10 es que `executeNode` procese ESTE nodo, que es el
 *  único punto donde se arma el `systemPrompt` con `buildBasePrompt`. */
const LLM_QUERY_NODE_ID = 'llm1';
function llmOnlyFlowNodes() {
  return [{ id: LLM_QUERY_NODE_ID, type: 'llm_query', data: {} }];
}

describe('1.23 Skills (BE-SKL-*)', () => {
  let t: TestApp;
  let fakeLlm: FakeLlmService;

  beforeAll(async () => {
    fakeLlm = new FakeLlmService();
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(fakeLlm),
    });
  });

  afterAll(async () => {
    await t.close();
  });

  afterEach(() => {
    fakeLlm.reset();
  });

  it('BE-SKL-01: GET /skills parado en un tenant devuelve solo las skills de ese tenant', async () => {
    const { tenant: tenantA, token: tokenA } = await buildTenantWithPerms(t, 'skl01a', SKILL_CRUD_PERMS);
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('skl01b') });
    const skillA = await createSkill(t.prisma, { tenantId: tenantA.id, name: uniqueSlug('skillA'), promptText: 'texto A' });
    await createSkill(t.prisma, { tenantId: tenantB.id, name: uniqueSlug('skillB'), promptText: 'texto B' });

    const res = await withAuth(http(t).get('/skills'), tokenA, tenantA.id);

    expect(res.status).toBe(200);
    const ids = res.body.map((s: any) => s.id);
    expect(ids).toEqual([skillA.id]);
  });

  it('BE-SKL-02: POST /skills con name y promptText crea 201, scopeada por el tenant activo (no por el body)', async () => {
    const { tenant, token } = await buildTenantWithPerms(t, 'skl02', SKILL_CRUD_PERMS);

    const res = await withAuth(http(t).post('/skills'), token, tenant.id).send({
      name: uniqueSlug('skl02-skill'),
      promptText: 'Sos un asistente de RRHH.',
    });

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(tenant.id);
  });

  it('BE-SKL-03: un name ya usado en la empresa devuelve 409; el mismo name en otra empresa devuelve 201', async () => {
    const { tenant: tenantA, token: tokenA } = await buildTenantWithPerms(t, 'skl03a', SKILL_CRUD_PERMS);
    const { tenant: tenantB, token: tokenB } = await buildTenantWithPerms(t, 'skl03b', SKILL_CRUD_PERMS);
    const name = uniqueSlug('skl03-repetido');
    await createSkill(t.prisma, { tenantId: tenantA.id, name, promptText: 'texto' });

    const dup = await withAuth(http(t).post('/skills'), tokenA, tenantA.id).send({ name, promptText: 'otro texto' });
    expect(dup.status).toBe(409);

    const otraEmpresa = await withAuth(http(t).post('/skills'), tokenB, tenantB.id).send({ name, promptText: 'otro texto' });
    expect(otraEmpresa.status).toBe(201);
  });

  it('BE-SKL-04: GET/PATCH/DELETE /skills/:id de una skill de otra empresa devuelve 404', async () => {
    const { tenant: tenantA, token: tokenA } = await buildTenantWithPerms(t, 'skl04a', SKILL_CRUD_PERMS);
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('skl04b') });
    const skillB = await createSkill(t.prisma, { tenantId: tenantB.id, name: uniqueSlug('skl04-skillB'), promptText: 'texto' });

    const getRes = await withAuth(http(t).get(`/skills/${skillB.id}`), tokenA, tenantA.id);
    expect(getRes.status).toBe(404);

    const patchRes = await withAuth(http(t).patch(`/skills/${skillB.id}`), tokenA, tenantA.id).send({ promptText: 'hackeado' });
    expect(patchRes.status).toBe(404);

    const deleteRes = await withAuth(http(t).delete(`/skills/${skillB.id}`), tokenA, tenantA.id);
    expect(deleteRes.status).toBe(404);

    // Y sigue existiendo, sin tocar, del lado de B.
    const stillThere = await t.prisma.skill.findUnique({ where: { id: skillB.id } });
    expect(stillThere?.promptText).toBe('texto');
  });

  it('BE-SKL-05: PATCH /skills/:id cambiando promptText devuelve 200 y actualiza', async () => {
    const { tenant, token } = await buildTenantWithPerms(t, 'skl05', SKILL_CRUD_PERMS);
    const skill = await createSkill(t.prisma, { tenantId: tenant.id, name: uniqueSlug('skl05-skill'), promptText: 'texto viejo' });

    const res = await withAuth(http(t).patch(`/skills/${skill.id}`), token, tenant.id).send({ promptText: 'texto nuevo' });

    expect(res.status).toBe(200);
    expect(res.body.promptText).toBe('texto nuevo');
  });

  it('BE-SKL-06: DELETE /skills/:id de una skill vinculada a un flujo deja Flow.skillId en null sin romper el flujo', async () => {
    const { tenant, token } = await buildTenantWithPerms(t, 'skl06', SKILL_CRUD_PERMS);
    const skill = await createSkill(t.prisma, { tenantId: tenant.id, name: uniqueSlug('skl06-skill'), promptText: 'texto' });
    const flow = await createFlow(t.prisma, { name: 'Flujo vinculado', nodes: [], edges: [], skillId: skill.id });

    const res = await withAuth(http(t).delete(`/skills/${skill.id}`), token, tenant.id);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Skill eliminado.');
    const reloadedFlow = await t.prisma.flow.findUnique({ where: { id: flow.id } });
    expect(reloadedFlow).not.toBeNull();
    expect(reloadedFlow!.skillId).toBeNull();
  });

  it('BE-SKL-07: cualquier operación sin el permiso skills:* devuelve 403 "Permiso denegado: skills:accion"', async () => {
    const { tenant, token } = await buildTenantWithPerms(t, 'skl07', []); // sin ningún permiso

    const res = await withAuth(http(t).get('/skills'), token, tenant.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Permiso denegado: skills:read');
  });

  // --- BE-SKL-08 (SEC-17): un Flow compartido entre A (dueña de la skill) y B no debe filtrar
  // el texto de la skill de A hacia una charla de B ---
  it.failing(
    'BE-SKL-08: una charla del tenant B en un Flow compartido con A no debe recibir la Skill de A (SEC-17) @invertido',
    async () => {
      const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('skl08a') });
      const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('skl08b') });
      const skillDeA = await createSkill(t.prisma, {
        tenantId: tenantA.id,
        name: uniqueSlug('skl08-skill'),
        promptText: `SECRETO-DE-A-${uniqueSlug('x')}`,
      });
      // Flow compartido de verdad (TenantFlow N:N) entre A (dueña de la skill) y B — el mismo
      // patrón que documenta AGENTS.md sobre la limitación de ContextSource/Skill por tenant.
      const flowCompartido = await createFlow(t.prisma, {
        name: 'Flujo compartido A/B',
        nodes: llmOnlyFlowNodes(),
        edges: [],
        skillId: skillDeA.id,
        assign: [{ tenantId: tenantA.id }, { tenantId: tenantB.id }],
      });
      // Necesita membresía real en B: desde "no hablamos con desconocidos" (2026-08-27),
      // `handleMessage` rechaza cualquier teléfono sin `UserTenant` en el tenant del mensaje
      // ANTES de llegar al motor de flujos — sin esto, el test "pasaba" porque el LLM nunca
      // se llegaba a llamar (systemPrompt vacío), no porque el saneo funcionara de verdad.
      const roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol B SKL-08' });
      const userDeB = await createUser(t.prisma, {
        email: uniqueEmail('skl08-userb'),
        phone: uniquePhone(),
        memberships: [{ tenantId: tenantB.id, roleId: roleB.id }],
      });
      // Se posiciona la conversación directo en el nodo llm_query (mismo estado que dejaría
      // `executeFlow` tras un `start`): lo que se ejercita es `executeNode`/`buildBasePrompt`
      // con el Skill de un Flow compartido, no el ruteo de inicio.
      await t.prisma.conversation.create({
        data: {
          userId: userDeB.id,
          tenantId: tenantB.id,
          channel: 'whatsapp',
          status: 'active',
          currentFlowId: flowCompartido.id,
          currentNodeId: LLM_QUERY_NODE_ID,
          sessionStartedAt: new Date(),
        },
      });

      const res = await http(t)
        .post('/conversations/simulate').set('Authorization', `Bearer ${t.authToken}`)
        .send({ from: userDeB.phone, body: 'Hola, tengo una consulta sobre mi cuenta', tenantId: tenantB.id });

      expect(res.status).toBe(201); // @Post() default
      const lastCall = fakeLlm.calls[fakeLlm.calls.length - 1];
      const systemPrompt = String(lastCall?.options?.systemPrompt ?? '');

      // SEGURO: el texto de la Skill de A (otra empresa) no debería inyectarse en una charla de
      // B, aunque el Flow esté compartido entre ambas. Hoy `FlowService.findById` no re-chequea
      // el tenant en curso al traer `skill.promptText` → el texto de A entra en el prompt de B.
      expect(systemPrompt).not.toContain(skillDeA.promptText);
    },
    20000,
  );

  // --- BE-SKL-09 (SEC-17): POST/PATCH /flows con un skillId de OTRA empresa debe rechazar ---
  describe('BE-SKL-09 (SEC-17): skillId de otra empresa en /flows', () => {
    it.failing('BE-SKL-09: POST /flows con un skillId de otra empresa debe devolver 400/403 (SEC-17) @invertido', async () => {
      const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('skl09posta') });
      const skillDeA = await createSkill(t.prisma, { tenantId: tenantA.id, name: uniqueSlug('skl09-skill'), promptText: 'texto' });
      const { tenant: tenantB, token: tokenB } = await buildTenantWithPerms(t, 'skl09postb', FLOW_CRUD_PERMS);

      const res = await withAuth(http(t).post('/flows'), tokenB, tenantB.id).send({
        name: 'Flujo con skill ajena',
        nodes: [],
        edges: [],
        skillId: skillDeA.id,
      });

      // SEGURO: un skillId que no pertenece al tenant activo debería rechazarse. Hoy
      // `FlowService.create` propaga `skillId` por spread sin validar pertenencia — la FK sólo
      // valida que exista, no de quién es → 201.
      expect([400, 403]).toContain(res.status);
    });

    it.failing('BE-SKL-09: PATCH /flows/:id con un skillId de otra empresa debe devolver 400/403 (SEC-17) @invertido', async () => {
      const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('skl09patcha') });
      const skillDeA = await createSkill(t.prisma, { tenantId: tenantA.id, name: uniqueSlug('skl09-skill-patch'), promptText: 'texto' });
      const { tenant: tenantB, token: tokenB } = await buildTenantWithPerms(t, 'skl09patchb', FLOW_CRUD_PERMS);
      const flowDeB = await createFlow(t.prisma, { name: 'Flujo de B', nodes: [], edges: [] });

      const res = await withAuth(http(t).patch(`/flows/${flowDeB.id}`), tokenB, tenantB.id).send({
        skillId: skillDeA.id,
      });

      // SEGURO: mismo criterio que el POST. Hoy `FlowService.update` tampoco valida pertenencia.
      expect([400, 403]).toContain(res.status);
    });
  });

  // --- BE-SKL-10 (robustez, sin número de hallazgo): una Skill isActive:false no debería
  // concatenarse al prompt aunque el flujo la tenga vinculada ---
  it.failing(
    'BE-SKL-10: una Skill marcada isActive:false no debería concatenarse al prompt del flujo que la usa @invertido',
    async () => {
      const tenant = await createTenant(t.prisma, { slug: uniqueSlug('skl10') });
      const skillInactiva = await createSkill(t.prisma, {
        tenantId: tenant.id,
        name: uniqueSlug('skl10-skill'),
        promptText: `INACTIVA-NO-DEBERIA-USARSE-${uniqueSlug('x')}`,
        isActive: false,
      });
      const flow = await createFlow(t.prisma, {
        name: 'Flujo con skill inactiva',
        nodes: llmOnlyFlowNodes(),
        edges: [],
        skillId: skillInactiva.id,
      });
      // Mismo motivo que BE-SKL-08: necesita membresía real, si no el mensaje se rechaza antes
      // de llegar al LLM y el assert pasa vacío en vez de verificar algo real.
      const roleT = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol SKL-10' });
      const user = await createUser(t.prisma, {
        email: uniqueEmail('skl10-user'),
        phone: uniquePhone(),
        memberships: [{ tenantId: tenant.id, roleId: roleT.id }],
      });
      await t.prisma.conversation.create({
        data: {
          userId: user.id,
          tenantId: tenant.id,
          channel: 'whatsapp',
          status: 'active',
          currentFlowId: flow.id,
          currentNodeId: LLM_QUERY_NODE_ID,
          sessionStartedAt: new Date(),
        },
      });

      const res = await http(t)
        .post('/conversations/simulate').set('Authorization', `Bearer ${t.authToken}`)
        .send({ from: user.phone, body: 'Hola, necesito información', tenantId: tenant.id });

      expect(res.status).toBe(201);
      const lastCall = fakeLlm.calls[fakeLlm.calls.length - 1];
      const systemPrompt = String(lastCall?.options?.systemPrompt ?? '');

      // SEGURO: una Skill inactiva no debería concatenarse. Hoy `FlowService.findById` ni
      // siquiera trae `isActive`, y el motor no la chequea: el texto se inyecta igual.
      expect(systemPrompt).not.toContain(skillInactiva.promptText);
    },
    20000,
  );
});
