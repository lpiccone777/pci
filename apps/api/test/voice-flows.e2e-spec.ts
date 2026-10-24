/**
 * Flujos de voz en la administración (H4a) — BE-VFLW-*
 *
 * Contrato de integración C52 y DA6: los flujos de voz (`Flow.channel = "voice"`) tienen su API
 * (`/voice-flows`) y su permiso (`voice_flows`), separados de los de texto (`/flows`, `flows`).
 * Toda la sección responde 404 con el voicebot apagado; el menú se arma con `GET /features`.
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
  uniqueSlug,
  uniqueEmail,
  setSetting,
  deleteSetting,
  startNode,
  messageNode,
  delayNode,
  subflowNode,
  edge,
} from './support';

describe('Flujos de voz: /voice-flows y permiso voice_flows (BE-VFLW-*)', () => {
  let t: TestApp;

  /** Una empresa nueva con un usuario cuyo rol tiene exactamente `permissions`. */
  async function scenario(permissions: string[]) {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('vflw') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol voz', permissions });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('vflw'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    return { tenant, role, user, token: tokenFor(t, user) };
  }
  const voiceNodes = () => [startNode('start', { text: 'Hola.' }), messageNode('m', 'Te escucho.')];
  const body = (name: string, nodes: unknown[] = voiceNodes()) => ({ name, nodes, edges: [edge('start', 'm')] });

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await deleteSetting(t.prisma, 'VOICEBOT_ENABLED');
    await t.close();
  });
  beforeEach(() => setSetting(t.prisma, 'VOICEBOT_ENABLED', 'true'));

  it('BE-VFLW-01: con el voicebot apagado /voice-flows no existe (404) y /features lo dice; prendido, responde', async () => {
    const { tenant, token } = await scenario(['voice_flows:read']);
    await setSetting(t.prisma, 'VOICEBOT_ENABLED', 'false');
    await withAuth(http(t).get('/voice-flows'), token, tenant.id).expect(404);
    expect((await withAuth(http(t).get('/features'), token, tenant.id).expect(200)).body).toEqual({ voicebot: false });

    await setSetting(t.prisma, 'VOICEBOT_ENABLED', 'true');
    await withAuth(http(t).get('/voice-flows'), token, tenant.id).expect(200);
    expect((await withAuth(http(t).get('/features'), token, tenant.id).expect(200)).body).toEqual({ voicebot: true });
  });

  it('BE-VFLW-02: cada canal con su permiso: flows:* no abre /voice-flows y voice_flows:* no abre /flows [DA6]', async () => {
    const text = await scenario(['flows:read', 'flows:create']);
    await withAuth(http(t).get('/voice-flows'), text.token, text.tenant.id).expect(403);
    await withAuth(http(t).post('/voice-flows'), text.token, text.tenant.id).send(body('x')).expect(403);

    const voice = await scenario(['voice_flows:read', 'voice_flows:create']);
    await withAuth(http(t).get('/flows'), voice.token, voice.tenant.id).expect(403);
    const created = await withAuth(http(t).post('/voice-flows'), voice.token, voice.tenant.id).send(body('voz')).expect(201);
    expect(created.body.channel).toBe('voice');
  });

  it('BE-VFLW-03: aislamiento por canal: listados separados y un :id del otro canal da 404, aun para el SuperAdmin', async () => {
    const { tenant, token } = await scenario(['flows:read', 'flows:update', 'voice_flows:read', 'voice_flows:update']);
    const voice = await createFlow(t.prisma, { name: 'voz', channel: 'voice', nodes: voiceNodes(), assign: [{ tenantId: tenant.id }] });
    const text = await createFlow(t.prisma, { name: 'texto', nodes: voiceNodes(), assign: [{ tenantId: tenant.id }] });

    const voiceList = (await withAuth(http(t).get('/voice-flows'), token, tenant.id).expect(200)).body as { id: string }[];
    const textList = (await withAuth(http(t).get('/flows'), token, tenant.id).expect(200)).body as { id: string }[];
    expect(voiceList.map((f) => f.id)).toEqual([voice.id]);
    expect(textList.map((f) => f.id)).toEqual([text.id]);

    await withAuth(http(t).get(`/flows/${voice.id}`), token, tenant.id).expect(404);
    await withAuth(http(t).patch(`/voice-flows/${text.id}`), token, tenant.id).send({ name: 'x' }).expect(404);
    await withAuth(http(t).get(`/voice-flows/${voice.id}`), token, tenant.id).expect(200);
    // isDefault es el fallback global de texto: un flujo de voz no puede serlo.
    const admin = await t.prisma.user.findUniqueOrThrow({ where: { email: 'admin@pci.local' } });
    const system = await t.prisma.tenant.findUniqueOrThrow({ where: { slug: 'system' } });
    await withAuth(http(t).post(`/flows/${voice.id}/default`), tokenFor(t, admin), system.id).expect(404);
    await withAuth(http(t).get(`/flows/${voice.id}`), tokenFor(t, admin), system.id).expect(404);
  });

  it('BE-VFLW-04: un flujo de voz no admite nodos que no existen por voz ni subflujos de texto (y al revés)', async () => {
    const { tenant, token } = await scenario(['flows:create', 'voice_flows:create', 'voice_flows:update']);
    const bad = await withAuth(http(t).post('/voice-flows'), token, tenant.id)
      .send(body('con delay', [startNode('start'), delayNode('d', 1)]))
      .expect(400);
    expect(bad.body.message).toMatch(/delay/);

    const textFlow = await createFlow(t.prisma, { name: 'sub de texto', nodes: [startNode()], assign: [{ tenantId: tenant.id }] });
    await withAuth(http(t).post('/voice-flows'), token, tenant.id)
      .send(body('salta a texto', [startNode('start'), subflowNode('s', { flowId: textFlow.id })]))
      .expect(400);

    const voiceFlow = await createFlow(t.prisma, { name: 'sub de voz', channel: 'voice', nodes: [startNode()], assign: [{ tenantId: tenant.id }] });
    await withAuth(http(t).post('/flows'), token, tenant.id)
      .send(body('salta a voz', [startNode('start'), subflowNode('s', { flowId: voiceFlow.id })]))
      .expect(400);
    await withAuth(http(t).post('/voice-flows'), token, tenant.id)
      .send(body('salta a voz', [startNode('start'), subflowNode('s', { flowId: voiceFlow.id })]))
      .expect(201);
  });

  it('BE-VFLW-05: asignar empresas a un flujo de voz no guarda roles; el de inicio es uno por empresa', async () => {
    const { tenant, role, token } = await scenario(['voice_flows:create', 'voice_flows:update']);
    const first = (await withAuth(http(t).post('/voice-flows'), token, tenant.id).send(body('voz 1')).expect(201)).body;
    const second = (await withAuth(http(t).post('/voice-flows'), token, tenant.id).send(body('voz 2')).expect(201)).body;
    for (const id of [first.id, second.id]) {
      await withAuth(http(t).post(`/voice-flows/${id}/assign-tenants`), token, tenant.id)
        .send({ assignments: [{ tenantId: tenant.id, roleIds: [role.id] }], isStart: true })
        .expect(201);
    }
    const rows = await t.prisma.tenantFlow.findMany({ where: { tenantId: tenant.id }, include: { roles: true } });
    expect(rows.every((r) => r.roles.length === 0)).toBe(true);
    expect(rows.filter((r) => r.isStart).map((r) => r.flowId)).toEqual([second.id]);
  });

  it('BE-VFLW-06: las variantes heredan el canal; el origen tiene que ser del mismo canal', async () => {
    const { tenant, token } = await scenario(['voice_flows:read', 'voice_flows:create', 'flows:read']);
    const base = (await withAuth(http(t).post('/voice-flows'), token, tenant.id).send(body('voz base')).expect(201)).body;
    await t.prisma.tenantFlow.create({ data: { flowId: base.id, tenantId: tenant.id } });

    const variant = (
      await withAuth(http(t).post(`/voice-flows/${base.id}/variants`), token, tenant.id).send({ type: 'feriado' }).expect(201)
    ).body;
    expect(variant.channel).toBe('voice');

    const text = await createFlow(t.prisma, { name: 'texto origen', nodes: [startNode()], assign: [{ tenantId: tenant.id }] });
    await withAuth(http(t).post(`/voice-flows/${base.id}/variants`), token, tenant.id)
      .send({ type: 'guardia', sourceFlowId: text.id })
      .expect(404);
  });
});
