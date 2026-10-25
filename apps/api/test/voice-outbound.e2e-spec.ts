/**
 * Salientes desde pci (H5) — BE-OUT-*
 *
 * Contrato de integración §6, C34 y C63: pci publica `call.outbound` en `voicebot.commands` (RPC,
 * con el `callId` que genera pci), consume `call.outbound.result` de `voice.events` y maneja la
 * rotación y los reintentos. Números solo de `VOICEBOT_OUTBOUND_ALLOWED_PREFIXES` (vacía = cerrado).
 *
 * Vía: el broker real de la app (vhost efímero). El test hace de voicebot: consume
 * `voicebot.commands`, responde por el `replyTo` y publica los resultados en `voice.events`.
 */
import type * as amqp from 'amqplib';
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
  edge,
} from './support';
import { BrokerService, BrokerMessage } from '../src/modules/broker/broker.service';
import { VoiceOutboundService } from '../src/modules/voice/voice-outbound.service';
import { randomUUID } from 'crypto';

type Command = { pattern: string; data: Record<string, any> };

describe('Salientes desde pci: call.outbound y call.outbound.result (BE-OUT-*)', () => {
  let t: TestApp;
  let channel: amqp.Channel;
  let service: VoiceOutboundService;
  const commands: Command[] = [];
  /** Respuesta del voicebot falso a cada comando (por defecto, acepta el `callId`). */
  let reply: (cmd: Command) => Record<string, unknown> | null = (cmd) => ({ v: 1, callId: cmd.data.callId, ok: true });

  const waitFor = async <T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, label: string): Promise<T> => {
    for (let i = 0; i < 100; i++) {
      const v = await fn();
      if (v) return v as T;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout esperando: ${label}`);
  };
  const result = (data: Record<string, unknown>) => {
    const msg: BrokerMessage = { pattern: 'call.outbound.result', data: { v: 1, ...data }, timestamp: new Date().toISOString() };
    channel.sendToQueue('voice.events', Buffer.from(JSON.stringify(msg)), { persistent: true });
  };
  const outboundOf = (id: string) => t.prisma.voiceOutbound.findUniqueOrThrow({ where: { id }, include: { attempts: true } });

  /** Empresa con un usuario `voice_outbound:*` y un flujo de voz asignado. */
  async function scenario(permissions = ['voice_outbound:read', 'voice_outbound:create', 'voice_outbound:update']) {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('out') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Salientes', permissions });
    const user = await createUser(t.prisma, { email: uniqueEmail('out'), memberships: [{ tenantId: tenant.id, roleId: role.id }] });
    const flow = await createFlow(t.prisma, {
      name: 'saliente',
      channel: 'voice',
      nodes: [startNode('start', { text: 'Hola, te llamo de soporte.' }), messageNode('m', 'Chau.')],
      edges: [edge('start', 'm')],
      assign: [{ tenantId: tenant.id }],
    });
    return { tenant, user, flow, token: tokenFor(t, user) };
  }
  const post = (s: { token: string; tenant: { id: string } }, body: Record<string, unknown>) =>
    withAuth(http(t).post('/voice/outbound-calls'), s.token, s.tenant.id).send(body);

  /** El turno `start` de una saliente, como lo manda el voicebot [§5.3, C63]. */
  const replyQueue = `voicebot.rpc.reply.out-e2e-${randomUUID()}`;
  const pending = new Map<string, (r: any) => void>();
  const startTurn = (callId: string, calledNumber = '201') =>
    new Promise<any>((resolve, reject) => {
      const correlationId = `c-${randomUUID()}`;
      const timer = setTimeout(() => reject(new Error(`sin respuesta a ${correlationId}`)), 10_000);
      pending.set(correlationId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      const msg: BrokerMessage = {
        pattern: 'voice.turn',
        data: {
          v: 1,
          callId,
          turnId: randomUUID(),
          kind: 'start',
          call: { direction: 'outbound', extension: null, calledNumber, callerNumber: '' },
        },
        correlationId,
        replyTo: replyQueue,
      };
      channel.sendToQueue('voice.turn', Buffer.from(JSON.stringify(msg)), { persistent: true });
    });

  beforeAll(async () => {
    t = await createTestApp();
    service = t.moduleRef.get(VoiceOutboundService);
    channel = (t.moduleRef.get(BrokerService) as unknown as { channel: amqp.Channel }).channel;
    await channel.assertQueue(replyQueue, { exclusive: true, autoDelete: true });
    await channel.consume(replyQueue, (msg) => {
      if (!msg) return;
      const body = JSON.parse(msg.content.toString()) as BrokerMessage;
      channel.ack(msg);
      pending.get(body.correlationId!)?.(body.data);
      pending.delete(body.correlationId!);
    });
    await channel.assertQueue('voicebot.commands', { durable: true });
    await channel.consume('voicebot.commands', (msg) => {
      if (!msg) return;
      const body = JSON.parse(msg.content.toString()) as BrokerMessage;
      channel.ack(msg);
      const cmd = { pattern: body.pattern, data: body.data as Record<string, any> };
      commands.push(cmd);
      const data = reply(cmd);
      // `null` = el voicebot no responde (caído).
      if (body.replyTo && data) {
        channel.sendToQueue(
          body.replyTo,
          Buffer.from(JSON.stringify({ pattern: `${body.pattern}.reply`, data, correlationId: body.correlationId })),
        );
      }
    });
  });
  afterAll(async () => {
    await deleteSetting(t.prisma, 'VOICEBOT_ENABLED');
    await deleteSetting(t.prisma, 'VOICEBOT_OUTBOUND_ALLOWED_PREFIXES');
    await t.close();
  });
  beforeEach(async () => {
    commands.length = 0;
    reply = (cmd) => ({ v: 1, callId: cmd.data.callId, ok: true });
    await setSetting(t.prisma, 'VOICEBOT_ENABLED', 'true');
    await setSetting(t.prisma, 'VOICEBOT_OUTBOUND_ALLOWED_PREFIXES', '20, +54911');
  });

  it('BE-OUT-01: cerrado por defecto y por prefijo; con permiso propio; 404 con el voicebot apagado', async () => {
    const s = await scenario();
    await deleteSetting(t.prisma, 'VOICEBOT_OUTBOUND_ALLOWED_PREFIXES');
    const closed = await post(s, { to: ['201'], flowId: s.flow.id }).expect(403);
    expect(closed.body.message).toMatch(/cerradas/);

    await setSetting(t.prisma, 'VOICEBOT_OUTBOUND_ALLOWED_PREFIXES', '20, +54911');
    const blocked = await post(s, { to: ['201', '+5491155550000', '0800-333'] , flowId: s.flow.id }).expect(403);
    expect(blocked.body.message).toContain('0800333');
    await post(s, { to: ['20x'], flowId: s.flow.id }).expect(400);
    await post(s, { to: ['201'] }).expect(400); // ni flujo ni audio

    const reader = await scenario(['voice_outbound:read']);
    await post(reader, { to: ['201'], flowId: reader.flow.id }).expect(403);
    const voiceFlowsOnly = await scenario(['voice_flows:read', 'voice_flows:create']);
    await withAuth(http(t).get('/voice/outbound-calls'), voiceFlowsOnly.token, voiceFlowsOnly.tenant.id).expect(403);

    await setSetting(t.prisma, 'VOICEBOT_ENABLED', 'false');
    await withAuth(http(t).get('/voice/outbound-calls'), s.token, s.tenant.id).expect(404);
    expect(commands).toHaveLength(0);
  });

  it('BE-OUT-02: con flujo publica call.outbound con callId de pci y rotationKey; un flujo de otra empresa no', async () => {
    const s = await scenario();
    const res = await post(s, { to: ['201', '202'], flowId: s.flow.id, maxRounds: 2 }).expect(201);
    expect(res.body).toMatchObject({ status: 'calling', mode: 'flow', to: ['201', '202'], attemptsCount: 1 });

    const cmd = await waitFor(() => commands.find((c) => c.pattern === 'call.outbound'), 'call.outbound');
    expect(cmd.data).toMatchObject({ v: 1, to: ['201', '202'], flowId: s.flow.id, maxRounds: 2, rotationKey: res.body.id, resetRotation: true });
    expect(cmd.data.callId).toMatch(/^out-[0-9a-f-]{36}$/);
    expect(cmd.data.audioUrl).toBeUndefined();
    expect(res.body.attempts.map((a: { id: string }) => a.id)).toEqual([cmd.data.callId]);

    const other = await scenario();
    await post(s, { to: ['201'], flowId: other.flow.id }).expect(400);
    // Listado y detalle, solo de la empresa activa.
    const list = (await withAuth(http(t).get('/voice/outbound-calls'), s.token, s.tenant.id).expect(200)).body as { id: string }[];
    expect(list.map((o) => o.id)).toEqual([res.body.id]);
    await withAuth(http(t).get(`/voice/outbound-calls/${res.body.id}`), other.token, other.tenant.id).expect(404);
  });

  it('BE-OUT-03: rotación [C34]: no-answer reintenta con resetRotation false; answered termina', async () => {
    const s = await scenario();
    const { body } = await post(s, { to: ['201', '202'], flowId: s.flow.id }).expect(201);
    const first = await waitFor(() => commands.find((c) => c.pattern === 'call.outbound'), 'primer intento');

    result({ callId: first.data.callId, outcome: 'no-answer', answered: false, to: '201', round: 1, maxRounds: 3, lastAttempt: false });
    const waiting = await waitFor(async () => {
      const o = await outboundOf(body.id);
      return o.nextAttemptAt ? o : null;
    }, 'reintento agendado');
    expect(waiting.outcome).toBe('no-answer');
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 30_000); // 60 s por defecto

    // Vence la espera: el barrido publica el siguiente intento.
    await t.prisma.voiceOutbound.update({ where: { id: body.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await service.sweep();
    const second = await waitFor(() => commands.filter((c) => c.pattern === 'call.outbound')[1], 'segundo intento');
    expect(second.data.callId).not.toBe(first.data.callId);
    expect(second.data).toMatchObject({ rotationKey: body.id, resetRotation: false });

    result({ callId: second.data.callId, outcome: 'answered', answered: true, to: '202', round: 1, maxRounds: 3, lastAttempt: false });
    const done = await waitFor(async () => {
      const o = await outboundOf(body.id);
      return o.status === 'done' ? o : null;
    }, 'saliente terminada');
    expect(done).toMatchObject({ outcome: 'answered', attemptsCount: 2, nextAttemptAt: null });
    expect(done.attempts.find((a) => a.id === second.data.callId)).toMatchObject({ outcome: 'answered', answered: true, to: '202' });
  });

  it('BE-OUT-04: busy reintenta sin contar ronda; sin flujo, digit termina y no-answer en lastAttempt falla; exhausted falla', async () => {
    const s = await scenario();
    const flowCall = (await post(s, { to: ['201'], flowId: s.flow.id }).expect(201)).body;
    const c1 = await waitFor(() => commands.find((c) => c.data.rotationKey === flowCall.id), 'intento');
    result({ callId: c1.data.callId, outcome: 'busy', answered: false, lastAttempt: false });
    const busy = await waitFor(async () => {
      const o = await outboundOf(flowCall.id);
      return o.busyCount === 1 ? o : null;
    }, 'busy');
    expect(busy).toMatchObject({ status: 'calling', outcome: 'busy' });

    const audio = (await post(s, { to: ['+5491155550000'], audioUrl: 'https://audio.test/aviso.mp3', digits: '12' }).expect(201)).body;
    expect(audio.mode).toBe('audio');
    const c2 = await waitFor(() => commands.find((c) => c.data.rotationKey === audio.id), 'intento audio');
    expect(c2.data).toMatchObject({ audioUrl: 'https://audio.test/aviso.mp3', digits: '12' });
    expect(c2.data.flowId).toBeUndefined();
    result({ callId: c2.data.callId, outcome: 'digit', answered: true, digit: '1', lastAttempt: false });
    await waitFor(async () => (await outboundOf(audio.id)).status === 'done', 'digit → done');

    const last = (await post(s, { to: ['201'], audioUrl: 'https://audio.test/a.mp3' }).expect(201)).body;
    const c3 = await waitFor(() => commands.find((c) => c.data.rotationKey === last.id), 'intento último');
    result({ callId: c3.data.callId, outcome: 'no-answer', answered: false, lastAttempt: true });
    await waitFor(async () => (await outboundOf(last.id)).status === 'failed', 'lastAttempt → failed');

    const ex = (await post(s, { to: ['201'], flowId: s.flow.id }).expect(201)).body;
    const c4 = await waitFor(() => commands.find((c) => c.data.rotationKey === ex.id), 'intento exhausted');
    result({ callId: c4.data.callId, outcome: 'exhausted', answered: false, lastAttempt: true });
    const failed = await waitFor(async () => {
      const o = await outboundOf(ex.id);
      return o.status === 'failed' ? o : null;
    }, 'exhausted → failed');
    expect(failed.outcome).toBe('exhausted');
  });

  it('BE-OUT-05: cancelar con un intento en curso manda call.hangup y no reintenta; voicebot que rechaza → reintento', async () => {
    const s = await scenario();
    const { body } = await post(s, { to: ['201'], flowId: s.flow.id }).expect(201);
    const cmd = await waitFor(() => commands.find((c) => c.data.rotationKey === body.id), 'intento');
    const cancelled = await withAuth(http(t).post(`/voice/outbound-calls/${body.id}/cancel`), s.token, s.tenant.id).expect(201);
    expect(cancelled.body.status).toBe('cancelled');
    const hangup = await waitFor(() => commands.find((c) => c.pattern === 'call.hangup'), 'call.hangup');
    expect(hangup.data).toEqual({ v: 1, callId: cmd.data.callId, resetRotation: true });
    result({ callId: cmd.data.callId, outcome: 'no-answer', answered: false, lastAttempt: false });
    await waitFor(async () => (await outboundOf(body.id)).attempts[0].resultAt, 'resultado registrado');
    expect((await outboundOf(body.id)).status).toBe('cancelled');

    reply = () => ({ v: 1, error: 'callId en curso' });
    const rejected = (await post(s, { to: ['201'], flowId: s.flow.id }).expect(201)).body;
    const o = await waitFor(async () => {
      const r = await outboundOf(rejected.id);
      return r.nextAttemptAt && r.attempts[0]?.outcome === 'error' ? r : null;
    }, 'rechazo → reintento');
    expect(o).toMatchObject({ status: 'calling', outcome: 'error', busyCount: 1 });
  });

  it('BE-OUT-06: el start de una saliente abre la llamada en la empresa de la saliente y corre su flujo; un out-* ajeno, unknown_call', async () => {
    const s = await scenario();
    const { body } = await post(s, { to: ['201'], flowId: s.flow.id }).expect(201);
    const cmd = await waitFor(() => commands.find((c) => c.data.rotationKey === body.id), 'intento');
    result({ callId: cmd.data.callId, outcome: 'answered', answered: true, to: '201', lastAttempt: false });

    const r = await startTurn(cmd.data.callId);
    expect(r.error).toBeNull();
    expect(r.actions.filter((a: any) => a.mode === 'literal').map((a: any) => a.text)).toEqual(['Hola, te llamo de soporte.', 'Chau.']);
    const call = await t.prisma.voiceCall.findUniqueOrThrow({ where: { id: cmd.data.callId }, include: { conversation: true } });
    expect(call).toMatchObject({
      tenantId: s.tenant.id,
      direction: 'outbound',
      extensionId: null,
      extensionNumber: null,
      calledNumber: '201',
      callerNumber: null,
      outboundAttemptId: cmd.data.callId,
    });
    expect(call.conversation).toMatchObject({ userId: null, channel: 'voice', tenantId: s.tenant.id });

    const unknown = await startTurn(`out-${randomUUID()}`);
    expect(unknown.error).toBe('unknown_call');
  });

  it('BE-OUT-07: si el flujo de la saliente dejó de ser de la empresa, charla libre (delegate), nunca el de inicio', async () => {
    const s = await scenario();
    // Un flujo de inicio de la empresa que NO se tiene que usar.
    await createFlow(t.prisma, {
      name: 'inicio',
      channel: 'voice',
      nodes: [startNode('start', { text: 'Soy el de inicio.' })],
      edges: [],
      assign: [{ tenantId: s.tenant.id, isStart: true }],
    });
    const { body } = await post(s, { to: ['201'], flowId: s.flow.id }).expect(201);
    const cmd = await waitFor(() => commands.find((c) => c.data.rotationKey === body.id), 'intento');
    await t.prisma.tenantFlow.deleteMany({ where: { flowId: s.flow.id, tenantId: s.tenant.id } });

    const r = await startTurn(cmd.data.callId);
    expect(r.error).toBeNull();
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ type: 'say', mode: 'delegate' });
  });

  it('BE-OUT-08: "Probar conexión" y "Re-provisionar SIP" por voicebot.commands, solo desde el tenant de sistema', async () => {
    const admin = await t.prisma.user.findUniqueOrThrow({ where: { email: 'admin@pci.local' } });
    const system = await t.prisma.tenant.findUniqueOrThrow({ where: { slug: 'system' } });
    const token = tokenFor(t, admin);
    const version = (await t.prisma.integrationConfigVersion.findUnique({ where: { id: 'voicebot' } }))?.version ?? 0;
    reply = (cmd) =>
      cmd.pattern === 'health.check'
        ? { v: 1, ok: true, livekit: 'ok', rabbitmq: 'ok', minimax: 'ok', configVersion: version, activeCalls: 1 }
        : { v: 1, trunks: ['in', 'out'], rules: ['201'] };

    const health = await withAuth(http(t).post('/integrations/voicebot/health'), token, system.id).expect(201);
    expect(health.body).toMatchObject({ ok: true, livekit: 'ok', activeCalls: 1, pciConfigVersion: version, configUpToDate: true });
    expect(commands.find((c) => c.pattern === 'health.check')!.data).toEqual({ v: 1 });

    const sip = await withAuth(http(t).post('/integrations/voicebot/sip-provision'), token, system.id).expect(201);
    expect(sip.body).toMatchObject({ ok: true, trunks: ['in', 'out'], rules: ['201'] });

    reply = (cmd) => (cmd.pattern === 'health.check' ? { v: 1, ok: true, configVersion: version - 1 } : null);
    expect((await withAuth(http(t).post('/integrations/voicebot/health'), token, system.id).expect(201)).body).toMatchObject({
      ok: true,
      configUpToDate: false,
    });

    // Un admin de empresa no llega, aunque tenga el permiso `settings`.
    const s = await scenario(['settings:read', 'settings:update']);
    await withAuth(http(t).post('/integrations/voicebot/health'), s.token, s.tenant.id).expect(403);
  });

  it('BE-OUT-09: voicebot caído: "Probar conexión" responde ok:false con el motivo a los 5 s, sin tirar', async () => {
    const admin = await t.prisma.user.findUniqueOrThrow({ where: { email: 'admin@pci.local' } });
    const system = await t.prisma.tenant.findUniqueOrThrow({ where: { slug: 'system' } });
    reply = () => null;
    const res = await withAuth(http(t).post('/integrations/voicebot/health'), tokenFor(t, admin), system.id).expect(201);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/no respondió en 5 s/);
  }, 15_000);
});
