/**
 * Integración voicebot — internos (contrato de integración §3.5, H2) — BE-EXT-*
 *
 * `/voicebot/extensions` (ABM, `SystemTenantGuard` + `settings:*`), validación cruzada con
 * `User.internalPhone` en los dos sentidos [C5], internos en `extensions` de
 * `GET /integrations/voicebot/config`, y versión + `config.changed` con `sections: ["internos"]`.
 *
 * Vía: endpoints REST reales con supertest sobre la base efímera; el evento se observa con una
 * cola propia bindeada al exchange real, sobre el canal del `BrokerService` de la app.
 */
import type * as amqp from 'amqplib';
import {
  createTestApp,
  TestApp,
  tokenFor,
  withAuth,
  http,
  getSystemContext,
  createTenant,
  createFlow,
  createRole,
  createUser,
  uniqueEmail,
  uniqueSlug,
  setSetting,
  deleteSetting,
} from './support';
import { BrokerService, BrokerMessage } from '../src/modules/broker/broker.service';

const VOICEBOT_TOKEN = 'e2e-ext-voicebot-token-0123456789';

/** Número de interno único en la corrida (la numeración es global). */
let seq = 0;
const extNumber = () => `7${process.pid % 1000}${Date.now() % 100000}${seq++}`;

describe('Integración voicebot: internos (BE-EXT-*)', () => {
  let t: TestApp;
  let adminToken: string;
  let systemTenantId: string;
  let superAdminRoleId: string;
  let tenantId: string;
  let channel: amqp.Channel;
  const received: BrokerMessage[] = [];

  const asAdmin = (req: ReturnType<ReturnType<typeof http>['get']>) => withAuth(req, adminToken, systemTenantId);
  const createExt = (body: Record<string, unknown>) => asAdmin(http(t).post('/voicebot/extensions')).send(body);
  const version = async () =>
    (await t.prisma.integrationConfigVersion.findUniqueOrThrow({ where: { id: 'voicebot' } })).version;
  const waitForEvent = async (minVersion: number) => {
    for (let i = 0; i < 50; i++) {
      const found = received.find((m) => (m.data as { version: number }).version >= minVersion);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no llegó config.changed con version >= ${minVersion}`);
  };
  const voicebotConfig = () =>
    http(t).get('/integrations/voicebot/config').set('Authorization', `Bearer ${VOICEBOT_TOKEN}`).expect(200);

  beforeAll(async () => {
    t = await createTestApp();
    const { admin, tenant } = await getSystemContext(t.prisma);
    adminToken = tokenFor(t, admin);
    systemTenantId = tenant.id;
    superAdminRoleId = (await t.prisma.userTenant.findFirstOrThrow({ where: { userId: admin.id, tenantId: tenant.id } }))
      .roleId;
    tenantId = (await createTenant(t.prisma, { slug: uniqueSlug('ext') })).id;
    await asAdmin(http(t).patch('/settings/VOICEBOT_SERVICE_TOKEN')).send({ value: VOICEBOT_TOKEN }).expect(200);

    channel = (t.moduleRef.get(BrokerService) as unknown as { channel: amqp.Channel }).channel;
    await channel.assertExchange('voicebot.events', 'topic', { durable: true });
    const queue = `e2e.ext.${Date.now()}`;
    await channel.assertQueue(queue, { exclusive: true, autoDelete: true });
    await channel.bindQueue(queue, 'voicebot.events', 'config.changed');
    await channel.consume(queue, (msg) => {
      if (!msg) return;
      received.push(JSON.parse(msg.content.toString()));
      channel.ack(msg);
    });
  });

  afterAll(async () => {
    await t.prisma.extension.deleteMany({});
    await deleteSetting(t.prisma, 'VOICEBOT_SERVICE_TOKEN');
    await t.close();
  });

  it('BE-EXT-01: sin JWT → 401; desde un tenant que no es el de sistema → 403', async () => {
    await http(t).get('/voicebot/extensions').expect(401);

    const role = await createRole(t.prisma, { tenantId, name: 'Admin empresa', permissions: ['settings:read'] });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('ext01'),
      memberships: [{ tenantId, roleId: role.id }],
    });
    const res = await withAuth(http(t).get('/voicebot/extensions'), tokenFor(t, user), tenantId);
    expect(res.status).toBe(403);
  });

  it('BE-EXT-02: alta → 201, aparece en el listado, sube la versión y publica config.changed ["internos"] sin reinicio', async () => {
    const before = await version();
    const number = extNumber();
    const res = await createExt({ number, name: 'Mesa de ayuda', tenantId }).expect(201);

    expect(res.body).toMatchObject({ number, name: 'Mesa de ayuda', tenantId, flowId: null, enabled: true });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    const list = await asAdmin(http(t).get('/voicebot/extensions')).expect(200);
    expect((list.body as Array<{ number: string }>).map((e) => e.number)).toContain(number);

    expect(await version()).toBe(before + 1);
    const evt = await waitForEvent(before + 1);
    expect(evt.data).toEqual({ v: 1, version: before + 1, sections: ['internos'], restart: { stt: false } });
  });

  it('BE-EXT-03: validaciones: número duplicado → 409; con espacios → 400; flowId inexistente → 400; empresa inexistente o dada de baja → 400', async () => {
    const number = extNumber();
    await createExt({ number, name: 'A', tenantId }).expect(201);
    const before = await version();

    expect((await createExt({ number, name: 'B', tenantId })).status).toBe(409);
    expect((await createExt({ number: '20 1', name: 'B', tenantId })).status).toBe(400);
    // Un flowId que no es un flujo de voz de la empresa (acá, ni existe) → 400 (ver BE-EXT-10).
    expect((await createExt({ number: extNumber(), name: 'B', tenantId, flowId: 'x' })).status).toBe(400);
    expect((await createExt({ number: extNumber(), name: 'B', tenantId: 'no-existe' })).status).toBe(400);
    const gone = await createTenant(t.prisma, { slug: uniqueSlug('ext03'), deletedAt: new Date() });
    expect((await createExt({ number: extNumber(), name: 'B', tenantId: gone.id })).status).toBe(400);

    // Ningún rechazo sube la versión.
    expect(await version()).toBe(before);
  });

  it('BE-EXT-04: un interno no puede ser el User.internalPhone de una persona activa [C5]', async () => {
    const number = extNumber();
    await createUser(t.prisma, { email: uniqueEmail('ext04'), internalPhone: number });
    const res = await createExt({ number, name: 'Choca', tenantId });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/interno de una persona/);

    // Una persona dada de baja no ocupa el número.
    const freed = extNumber();
    await createUser(t.prisma, { email: uniqueEmail('ext04b'), internalPhone: freed, deletedAt: new Date() });
    await createExt({ number: freed, name: 'Libre', tenantId }).expect(201);
  });

  it('BE-EXT-05: al revés, el interno de una persona no puede ser un interno del voicebot (alta, edición, verificación en vivo y carga masiva)', async () => {
    const number = extNumber();
    await createExt({ number, name: 'Ocupado', tenantId }).expect(201);
    const users = (path: string) => withAuth(http(t).post(path), adminToken, systemTenantId);

    const created = await users('/users').send({
      email: uniqueEmail('ext05'),
      firstName: 'Ana',
      lastName: 'Pérez',
      password: 'changeme123',
      roleId: superAdminRoleId,
      internalPhone: number,
    });
    expect(created.status).toBe(409);
    expect(created.body.message).toMatch(/interno del voicebot/);

    const person = await createUser(t.prisma, {
      email: uniqueEmail('ext05b'),
      memberships: [{ tenantId: systemTenantId, roleId: superAdminRoleId }],
    });
    const updated = await withAuth(http(t).patch(`/users/${person.id}`), adminToken, systemTenantId).send({
      internalPhone: number,
    });
    expect(updated.status).toBe(409);

    const check = await withAuth(
      http(t).get(`/users/check-availability?field=internalPhone&value=${number}`),
      adminToken,
      systemTenantId,
    ).expect(200);
    expect(check.body).toMatchObject({ available: false, field: 'internalPhone' });
    expect(check.body.message).toMatch(/interno del voicebot/);

    const bulk = await users('/users/bulk-import')
      .send({
        defaultRoleId: superAdminRoleId,
        rows: [{ email: uniqueEmail('ext05c'), firstName: 'B', lastName: 'C', internalPhone: number }],
      })
      .expect(201);
    expect(bulk.body.summary).toMatchObject({ created: 0, failed: 1 });
    expect(bulk.body.failed[0].reason).toMatch(/interno del voicebot/);
  });

  it('BE-EXT-06: los internos viajan en extensions de /integrations/voicebot/config; los de una empresa dada de baja, deshabilitados', async () => {
    const number = extNumber();
    const ext = (await createExt({ number, name: 'Config', tenantId }).expect(201)).body;
    const otherTenant = await createTenant(t.prisma, { slug: uniqueSlug('ext06') });
    const numberGone = extNumber();
    await createExt({ number: numberGone, name: 'Baja', tenantId: otherTenant.id }).expect(201);
    await t.prisma.tenant.update({ where: { id: otherTenant.id }, data: { deletedAt: new Date() } });

    const res = await voicebotConfig();
    const extensions = res.body.extensions as Array<Record<string, unknown>>;
    expect(extensions.find((e) => e.number === number)).toEqual({
      id: ext.id,
      number,
      name: 'Config',
      tenantId,
      flowId: null,
      enabled: true,
    });
    expect(extensions.find((e) => e.number === numberGone)?.enabled).toBe(false);
  });

  it('BE-EXT-07: editar (deshabilitar) y borrar suben la versión y publican; el borrado desaparece de la config', async () => {
    const number = extNumber();
    const ext = (await createExt({ number, name: 'Cambia', tenantId }).expect(201)).body;

    let before = await version();
    const patched = await asAdmin(http(t).patch(`/voicebot/extensions/${ext.id}`)).send({ enabled: false }).expect(200);
    expect(patched.body.enabled).toBe(false);
    expect(await version()).toBe(before + 1);
    expect((await waitForEvent(before + 1)).data).toMatchObject({ sections: ['internos'] });
    expect(
      ((await voicebotConfig()).body.extensions as Array<{ number: string; enabled: boolean }>).find(
        (e) => e.number === number,
      )?.enabled,
    ).toBe(false);

    before = await version();
    await asAdmin(http(t).delete(`/voicebot/extensions/${ext.id}`)).expect(200);
    expect(await version()).toBe(before + 1);
    await waitForEvent(before + 1);
    expect(
      ((await voicebotConfig()).body.extensions as Array<{ number: string }>).some((e) => e.number === number),
    ).toBe(false);
    await asAdmin(http(t).delete(`/voicebot/extensions/${ext.id}`)).expect(404);
  });

  it('BE-EXT-08: cambiar el número a uno ocupado → 409; a uno libre → 200', async () => {
    const a = (await createExt({ number: extNumber(), name: 'A', tenantId }).expect(201)).body;
    const b = (await createExt({ number: extNumber(), name: 'B', tenantId }).expect(201)).body;
    const patch = (body: Record<string, unknown>) => asAdmin(http(t).patch(`/voicebot/extensions/${b.id}`)).send(body);

    expect((await patch({ number: a.number })).status).toBe(409);
    const free = extNumber();
    expect((await patch({ number: free })).body.number).toBe(free);
  });

  it('BE-EXT-10: flujo propio del interno [DA8]: solo de voz, activo y de su empresa; viaja en la config y se puede sacar', async () => {
    const other = (await createTenant(t.prisma, { slug: uniqueSlug('ext10') })).id;
    const mk = (name: string, opts: { channel?: 'text' | 'voice'; isActive?: boolean; tenant?: string }) =>
      createFlow(t.prisma, {
        name,
        channel: opts.channel ?? 'voice',
        isActive: opts.isActive ?? true,
        nodes: [{ id: 'start', type: 'start', data: {}, position: { x: 0, y: 0 } }],
        assign: [{ tenantId: opts.tenant ?? tenantId }],
      });
    const good = await mk('voz ok', {});
    const text = await mk('texto', { channel: 'text' });
    const inactive = await mk('voz apagada', { isActive: false });
    const foreign = await mk('voz ajena', { tenant: other });

    const options = (await asAdmin(http(t).get(`/voicebot/extensions/flow-options?tenantId=${tenantId}`)).expect(200)).body;
    expect(options).toEqual([{ id: good.id, name: 'voz ok' }]);

    for (const bad of [text.id, inactive.id, foreign.id]) {
      expect((await createExt({ number: extNumber(), name: 'mal', tenantId, flowId: bad })).status).toBe(400);
    }
    const created = await createExt({ number: extNumber(), name: 'con flujo', tenantId, flowId: good.id }).expect(201);
    expect(created.body.flowId).toBe(good.id);
    const inConfig = (await voicebotConfig()).body.extensions.find((e: { id: string }) => e.id === created.body.id);
    expect(inConfig.flowId).toBe(good.id);

    // Cambiar de empresa con el flujo de la anterior → 400; sacarle el flujo → null.
    await asAdmin(http(t).patch(`/voicebot/extensions/${created.body.id}`)).send({ tenantId: other }).expect(400);
    const cleared = await asAdmin(http(t).patch(`/voicebot/extensions/${created.body.id}`)).send({ flowId: null }).expect(200);
    expect(cleared.body.flowId).toBeNull();
  });

  it('BE-EXT-09: sin settings:update no se puede dar de alta (403)', async () => {
    const role = await createRole(t.prisma, { tenantId: systemTenantId, name: `Lector ${seq}`, permissions: ['settings:read'] });
    const reader = await createUser(t.prisma, {
      email: uniqueEmail('ext09'),
      memberships: [{ tenantId: systemTenantId, roleId: role.id }],
    });
    const token = tokenFor(t, reader);
    await withAuth(http(t).get('/voicebot/extensions'), token, systemTenantId).expect(200);
    const res = await withAuth(http(t).post('/voicebot/extensions'), token, systemTenantId).send({
      number: extNumber(),
      name: 'X',
      tenantId,
    });
    expect(res.status).toBe(403);
  });
});
