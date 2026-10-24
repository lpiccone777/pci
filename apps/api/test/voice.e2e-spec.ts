/**
 * Canal de voz (H3) — `voice.events` y RPC `voice.turn` — BE-VOZ-*
 *
 * Contrato de integración (repo voicebot, `docs/integracion-pci/contrato.md`) §5 y C47:
 * - La llamada se abre con lo primero que llegue (`call.started` o `kind: "start"`), sin usuario
 *   [DA5] y con el tenant del interno.
 * - Flujo de la llamada [DA8]: `Extension.flowId` → flujo de voz de inicio del tenant →
 *   charla libre (`delegate`). Nunca el `isDefault` global ni un flujo de otro tenant.
 * - Idempotencia por `turnId`, `previous`/`lastSpoken`, `supersedes` con snapshot, serialización
 *   por llamada, y siempre una respuesta (con `error` si falla).
 *
 * Vía: el broker real de la app (vhost efímero). El test hace de voicebot: publica en
 * `voice.turn`/`voice.events` y espera la respuesta en una cola de respuesta propia, exclusiva y
 * con nombre (como `voicebot.rpc.reply.<instanceId>` [C35]). El LLM de pci es falso: por voz no
 * se tiene que llamar nunca en estos caminos.
 */
import type * as amqp from 'amqplib';
import { randomUUID } from 'crypto';
import {
  createTestApp,
  TestApp,
  FakeLlmService,
  createTenant,
  createFlow,
  uniqueSlug,
  startNode,
  inputNode,
  messageNode,
  endNode,
  menuNode,
  llmQueryNode,
  ticketCreateNode,
  edge,
  createSkill,
  setSetting,
  deleteSetting,
} from './support';
import { BrokerService, BrokerMessage } from '../src/modules/broker/broker.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { FlowService } from '../src/modules/flow/flow.service';
import { IntegrationsConfigService } from '../src/modules/integrations/integrations-config.service';
import { VOICEBOT_FREE_CHAT_PROMPT_DEFAULT } from '../src/modules/settings/voicebot-settings.catalog';

type Reply = {
  v: number;
  turnId: string;
  actions: Array<{ type: string; mode?: string; text?: string; systemPrompt?: string }>;
  awaitInput: boolean;
  committed: boolean;
  superseded: boolean;
  error: string | null;
};

const uid = () => randomUUID();
let extSeq = 0;
const extNumber = () => `9${Date.now() % 100000}${++extSeq}`;

describe('Canal de voz: voice.events y voice.turn (BE-VOZ-*)', () => {
  let t: TestApp;
  const llm = new FakeLlmService();
  let channel: amqp.Channel;
  const replyQueue = `voicebot.rpc.reply.e2e-${uid()}`;
  const pending = new Map<string, (r: Reply) => void>();

  let tenantId: string;
  let extension: string;
  let voiceFlowId: string;

  /** Un `voice.turn` como lo manda el voicebot, esperando la respuesta correlacionada. */
  const turn = (data: Record<string, unknown>, timeoutMs = 10_000): Promise<Reply> => {
    const correlationId = `c-${uid()}`;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(correlationId);
        reject(new Error(`sin respuesta a ${correlationId}`));
      }, timeoutMs);
      pending.set(correlationId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      const msg: BrokerMessage = {
        pattern: 'voice.turn',
        data: { v: 1, ...data },
        correlationId,
        replyTo: replyQueue,
        timestamp: new Date().toISOString(),
      };
      channel.sendToQueue('voice.turn', Buffer.from(JSON.stringify(msg)), { persistent: true });
    });
  };
  const event = (pattern: string, data: Record<string, unknown>) => {
    const msg: BrokerMessage = { pattern, data: { v: 1, ...data }, timestamp: new Date().toISOString() };
    channel.sendToQueue('voice.events', Buffer.from(JSON.stringify(msg)), { persistent: true });
  };
  const callInfo = (ext = extension) => ({ extension: ext, calledNumber: ext, callerNumber: '+5491100000000', direction: 'inbound' });
  const start = (callId: string, ext = extension) => turn({ callId, turnId: uid(), kind: 'start', call: callInfo(ext) });
  const say = (callId: string, text: string, extra: Record<string, unknown> = {}) =>
    turn({ callId, turnId: uid(), kind: 'user', text, call: callInfo(), ...extra });
  const literals = (r: Reply) => r.actions.filter((a) => a.mode === 'literal').map((a) => a.text);
  const waitFor = async <T>(fn: () => Promise<T | null | undefined | false>, label: string): Promise<T> => {
    for (let i = 0; i < 100; i++) {
      const v = await fn();
      if (v) return v as T;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout esperando: ${label}`);
  };
  const callOf = (callId: string) =>
    t.prisma.voiceCall.findUnique({ where: { id: callId }, include: { conversation: true } });

  /** start → nombre → apellido → "Gracias…" → end. Literal de punta a punta: sin LLM. */
  const literalFlow = () => ({
    nodes: [
      startNode('start', { text: 'Hola, habla el asistente.' }),
      inputNode('nombre', { text: '¿Cuál es tu nombre?', variableName: 'nombre' }),
      inputNode('apellido', { text: '¿Y tu apellido?', variableName: 'apellido' }),
      messageNode('gracias', 'Gracias {{nombre}} {{apellido}}.'),
      endNode('fin', 'Chau.'),
    ],
    edges: [edge('start', 'nombre'), edge('nombre', 'apellido'), edge('apellido', 'gracias'), edge('gracias', 'fin')],
  });

  beforeAll(async () => {
    t = await createTestApp({ customize: (b) => b.overrideProvider(LlmService).useValue(llm) });
    channel = (t.moduleRef.get(BrokerService) as unknown as { channel: amqp.Channel }).channel;
    await channel.assertQueue(replyQueue, { exclusive: true, autoDelete: true });
    await channel.consume(replyQueue, (msg) => {
      if (!msg) return;
      const body = JSON.parse(msg.content.toString()) as BrokerMessage;
      channel.ack(msg);
      expect(body.pattern).toBe('voice.turn.reply');
      pending.get(body.correlationId!)?.(body.data as Reply);
      pending.delete(body.correlationId!);
    });

    tenantId = (await createTenant(t.prisma, { slug: uniqueSlug('voz') })).id;
    extension = extNumber();
    await t.prisma.extension.create({ data: { number: extension, name: 'Mesa de ayuda', tenantId } });
    voiceFlowId = (
      await createFlow(t.prisma, { name: 'voz inicio', channel: 'voice', ...literalFlow(), assign: [{ tenantId, isStart: true }] })
    ).id;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    llm.calls.length = 0;
  });

  describe('Apertura de la llamada [§5.2, DA5]', () => {
    it('BE-VOZ-01: kind "start" sin call.started abre la llamada sin usuario y saluda desde start', async () => {
      const callId = uid();
      const r = await start(callId);

      expect(r.error).toBeNull();
      expect(literals(r)).toEqual(['Hola, habla el asistente.', '¿Cuál es tu nombre?']);
      expect(r).toMatchObject({ v: 1, awaitInput: true, committed: false, superseded: false });

      const call = await callOf(callId);
      expect(call).toMatchObject({ tenantId, extensionNumber: extension, callerNumber: '+5491100000000' });
      expect(call!.conversation).toMatchObject({ userId: null, channel: 'voice', externalId: callId, tenantId });
      expect(llm.calls).toHaveLength(0);
    });

    it('BE-VOZ-02: call.started que llega después del start no abre otra conversación y fija la entrada real [C48]', async () => {
      const callId = uid();
      await start(callId);
      const realStart = new Date(Date.now() - 2000).toISOString();
      event('call.started', { callId, ...callInfo(), startedAt: realStart });

      const call = await waitFor(async () => {
        const c = await callOf(callId);
        return c && c.startedAt.toISOString() === realStart ? c : null;
      }, 'startedAt del evento');
      expect(await t.prisma.conversation.count({ where: { externalId: callId } })).toBe(1);
      expect(call.conversationId).toBeTruthy();
    });

    it('BE-VOZ-03: call.started antes del start: el start usa la misma llamada', async () => {
      const callId = uid();
      event('call.started', { callId, ...callInfo(), startedAt: new Date().toISOString() });
      await waitFor(() => callOf(callId), 'llamada abierta por call.started');

      const r = await start(callId);
      expect(r.error).toBeNull();
      expect(literals(r)[0]).toBe('Hola, habla el asistente.');
      expect(await t.prisma.conversation.count({ where: { externalId: callId } })).toBe(1);
    });

    it('BE-VOZ-04: interno inexistente o deshabilitado → error, sin acciones; turno de una llamada desconocida → unknown_call', async () => {
      const missing = await start(uid(), '000000');
      expect(missing).toMatchObject({ error: 'unknown_extension', actions: [], awaitInput: true, committed: false });

      const disabled = extNumber();
      await t.prisma.extension.create({ data: { number: disabled, name: 'apagado', tenantId, enabled: false } });
      expect((await start(uid(), disabled)).error).toBe('unknown_extension');

      const orphan = await turn({ callId: uid(), turnId: uid(), kind: 'user', text: 'hola' });
      expect(orphan.error).toBe('unknown_call');
    });
  });

  describe('Turnos [§5.3]', () => {
    it('BE-VOZ-05: recorre el flujo literal hasta end: hangup y committed', async () => {
      const callId = uid();
      await start(callId);
      expect(literals(await say(callId, 'Ana'))).toEqual(['¿Y tu apellido?']);
      const last = await say(callId, 'Pérez');

      expect(literals(last)).toEqual(['Gracias Ana Pérez.', 'Chau.']);
      expect(last.actions.at(-1)).toEqual({ type: 'hangup' });
      expect(last).toMatchObject({ committed: true, awaitInput: false, error: null });
      expect(llm.calls).toHaveLength(0);
    });

    it('BE-VOZ-06: un turnId repetido devuelve la misma respuesta sin volver a correr el flujo [C27]', async () => {
      const callId = uid();
      await start(callId);
      const turnId = uid();
      const first = await turn({ callId, turnId, kind: 'user', text: 'Ana', call: callInfo() });
      const conv = (await callOf(callId))!.conversation;
      const messages = await t.prisma.message.count({ where: { conversationId: conv.id } });

      const again = await turn({ callId, turnId, kind: 'user', text: 'Ana', call: callInfo() });
      expect(again).toEqual(first);
      expect(await t.prisma.message.count({ where: { conversationId: conv.id } })).toBe(messages);
      expect((await callOf(callId))!.conversation.currentNodeId).toBe('apellido');
    });

    it('BE-VOZ-07: previous y call.ended guardan lo que se oyó; call.ended cierra la conversación', async () => {
      const callId = uid();
      const startTurn = uid();
      await turn({ callId, turnId: startTurn, kind: 'start', call: callInfo() });
      const userTurn = uid();
      await turn({
        callId,
        turnId: userTurn,
        kind: 'user',
        text: 'Ana',
        call: callInfo(),
        previous: { turnId: startTurn, heardText: 'Hola, habla el', interrupted: true },
      });
      const startBot = await t.prisma.voiceTurn.findUnique({ where: { id: startTurn } });
      expect((await t.prisma.message.findUnique({ where: { id: startBot!.botMessageId! } }))!.content).toBe('Hola, habla el');

      event('call.ended', {
        callId,
        reason: 'hangup',
        endedAt: new Date().toISOString(),
        lastSpoken: { turnId: userTurn, heardText: '¿Y tu ape', interrupted: true },
      });
      const call = await waitFor(async () => {
        const c = await callOf(callId);
        return c?.endedAt ? c : null;
      }, 'call.ended');
      expect(call).toMatchObject({ endReason: 'hangup' });
      expect(call.conversation.status).toBe('closed');
      const userBot = await t.prisma.voiceTurn.findUnique({ where: { id: userTurn } });
      expect((await t.prisma.message.findUnique({ where: { id: userBot!.botMessageId! } }))!.content).toBe('¿Y tu ape');
    });

    it('BE-VOZ-08: supersedes de un turno sin efectos restaura el snapshot y procesa el texto completo [DA1]', async () => {
      const callId = uid();
      await start(callId);
      const aborted = uid();
      await turn({ callId, turnId: aborted, kind: 'user', text: 'An', call: callInfo() });
      const abortedRow = await t.prisma.voiceTurn.findUnique({ where: { id: aborted } });

      const redo = await say(callId, 'Ana María', { supersedes: aborted });
      expect(redo).toMatchObject({ superseded: true, error: null });
      expect(literals(redo)).toEqual(['¿Y tu apellido?']);

      const conv = (await callOf(callId))!.conversation;
      expect((conv.flowState as Record<string, unknown>).nombre).toBe('Ana María');
      expect(await t.prisma.message.count({ where: { id: { in: [abortedRow!.userMessageId!, abortedRow!.botMessageId!] } } })).toBe(0);
      expect((await t.prisma.voiceTurn.findUnique({ where: { id: aborted } }))!.superseded).toBe(true);
    });

    it('BE-VOZ-09: supersedes de un turno committed se ignora: superseded false', async () => {
      const callId = uid();
      await start(callId);
      await say(callId, 'Ana');
      const committedTurn = uid();
      const done = await turn({ callId, turnId: committedTurn, kind: 'user', text: 'Pérez', call: callInfo() });
      expect(done.committed).toBe(true);

      const redo = await say(callId, 'Pérez García', { supersedes: committedTurn });
      expect(redo).toMatchObject({ superseded: false, error: null });
      expect((await t.prisma.voiceTurn.findUnique({ where: { id: committedTurn } }))!.superseded).toBe(false);
    });

    it('BE-VOZ-10: dos turnos concurrentes de la misma llamada se procesan de a uno [C4]', async () => {
      const callId = uid();
      await start(callId);
      const [a, b] = await Promise.all([say(callId, 'Ana'), say(callId, 'Pérez')]);
      expect(a.error).toBeNull();
      expect(b.error).toBeNull();
      // Uno contestó el nombre (pide el apellido) y el otro el apellido (cierra): nunca los dos
      // sobre el mismo estado.
      const texts = [literals(a), literals(b)].map((l) => l.join(' ')).sort();
      expect(texts[0]).toMatch(/^Gracias /);
      expect(texts[1]).toBe('¿Y tu apellido?');
      const turns = await t.prisma.voiceTurn.findMany({ where: { callId, kind: 'user' } });
      expect(turns).toHaveLength(2);
    });
  });

  describe('Flujo de la llamada [DA8+DA15]', () => {
    it('BE-VOZ-11: Extension.flowId (de voz y del tenant) gana sobre el flujo de voz de inicio', async () => {
      const own = await createFlow(t.prisma, {
        name: 'voz del interno',
        channel: 'voice',
        nodes: [startNode('start', { text: 'Flujo del interno.' })],
        assign: [{ tenantId }],
      });
      const ext = extNumber();
      await t.prisma.extension.create({ data: { number: ext, name: 'propio', tenantId, flowId: own.id } });
      expect(literals(await start(uid(), ext))).toEqual(['Flujo del interno.']);
    });

    it('BE-VOZ-12: un Extension.flowId de otro tenant o de texto se ignora: cae al flujo de voz de inicio', async () => {
      const other = await createTenant(t.prisma, { slug: uniqueSlug('voz-otro') });
      const foreign = await createFlow(t.prisma, {
        name: 'voz ajena',
        channel: 'voice',
        nodes: [startNode('start', { text: 'Flujo ajeno.' })],
        assign: [{ tenantId: other.id, isStart: true }],
      });
      const textFlow = await createFlow(t.prisma, {
        name: 'texto del tenant',
        nodes: [startNode('start', { text: 'Flujo de texto.' })],
        assign: [{ tenantId }],
      });
      for (const flowId of [foreign.id, textFlow.id]) {
        const ext = extNumber();
        await t.prisma.extension.create({ data: { number: ext, name: 'raro', tenantId, flowId } });
        expect(literals(await start(uid(), ext))[0]).toBe('Hola, habla el asistente.');
      }
    });

    it('BE-VOZ-13: sin flujo de voz → charla libre delegate con el prompt global, sin LLM de pci ni isDefault global', async () => {
      const lonely = await createTenant(t.prisma, { slug: uniqueSlug('voz-sin-flujo') });
      // Un default global de texto y un flujo de texto de inicio del tenant: ninguno aplica a voz.
      const globalDefault = await createFlow(t.prisma, {
        name: 'default texto',
        isDefault: true,
        nodes: [startNode('start', { text: 'Default global.' })],
      });
      await createFlow(t.prisma, {
        name: 'inicio texto',
        nodes: [startNode('start', { text: 'Inicio de texto.' })],
        assign: [{ tenantId: lonely.id, isStart: true }],
      });
      const ext = extNumber();
      await t.prisma.extension.create({ data: { number: ext, name: 'libre', tenantId: lonely.id } });

      const callId = uid();
      const r = await start(callId, ext);
      // Prompt de voz de pci con la empresa [C50]: nunca el del chat (menú, "cerrar la conversación").
      const prompt = VOICEBOT_FREE_CHAT_PROMPT_DEFAULT.replaceAll('{{empresa}}', lonely.name);
      expect(r.actions).toEqual([{ type: 'say', mode: 'delegate', systemPrompt: prompt }]);
      expect(prompt).toContain(`llamó a ${lonely.name}.`);
      expect(prompt).toContain('No podés registrar reclamos');
      expect(r).toMatchObject({ awaitInput: true, committed: false, error: null });

      const next = await turn({ callId, turnId: uid(), kind: 'user', text: 'tengo un problema', call: callInfo(ext) });
      expect(next.actions[0]).toMatchObject({ mode: 'delegate' });
      expect(llm.calls).toHaveLength(0);
      // `isDefault` es global: no dejarlo prendido para los demás specs (ver flow-builder.ts).
      await t.prisma.flow.update({ where: { id: globalDefault.id }, data: { isDefault: false } });
    });
  });

  describe('Capacidades del canal', () => {
    it('BE-VOZ-14: el menú se verbaliza y llm_query en modo charla delega con el prompt del nodo, sin LLM de pci', async () => {
      const tenant = await createTenant(t.prisma, { slug: uniqueSlug('voz-menu') });
      await createFlow(t.prisma, {
        name: 'voz menú',
        channel: 'voice',
        nodes: [
          startNode('start', { noGreeting: true }),
          menuNode('menu', { text: '¿Qué necesitás?', options: [{ value: 'a', label: 'Soporte' }, { value: 'b', label: 'Ventas' }] }),
          llmQueryNode('charla', { systemPrompt: 'Sos el asistente de soporte.' }),
        ],
        edges: [edge('start', 'menu'), edge('menu', 'charla', 'a')],
        assign: [{ tenantId: tenant.id, isStart: true }],
      });
      const ext = extNumber();
      await t.prisma.extension.create({ data: { number: ext, name: 'menú', tenantId: tenant.id } });

      const callId = uid();
      const first = await start(callId, ext);
      expect(literals(first)).toEqual(['¿Qué necesitás?\n1. Soporte\n2. Ventas']);

      const chosen = await turn({ callId, turnId: uid(), kind: 'user', text: '1', call: callInfo(ext) });
      expect(chosen.actions).toEqual([{ type: 'say', mode: 'delegate', systemPrompt: 'Sos el asistente de soporte.' }]);
      expect(llm.calls).toHaveLength(0);
    });

    it('BE-VOZ-15: ticket_create sin usuario identificado avisa y la llamada sigue, sin committed', async () => {
      const tenant = await createTenant(t.prisma, { slug: uniqueSlug('voz-ticket') });
      await createFlow(t.prisma, {
        name: 'voz ticket',
        channel: 'voice',
        nodes: [
          startNode('start', { noGreeting: true }),
          ticketCreateNode('ticket', { text: 'Ticket {{lastTicketId}} creado.' }),
          inputNode('otra', { text: '¿Algo más?', variableName: 'otra' }),
        ],
        edges: [edge('start', 'ticket'), edge('ticket', 'otra')],
        assign: [{ tenantId: tenant.id, isStart: true }],
      });
      const ext = extNumber();
      await t.prisma.extension.create({ data: { number: ext, name: 'ticket', tenantId: tenant.id } });

      const r = await start(uid(), ext);
      expect(literals(r)[0]).toMatch(/primero tengo que identificarte/);
      expect(literals(r)[1]).toBe('¿Algo más?');
      expect(r).toMatchObject({ committed: false, awaitInput: true, error: null });
      expect(await t.prisma.ticket.count({ where: { tenantId: tenant.id } })).toBe(0);
    });
  });

  describe('Prompt de la charla por voz [C50]', () => {
    it('BE-VOZ-18: llm_query de un flujo de voz parte del prompt de voz (+ Skill + nodo en append), no del del chat', async () => {
      const tenant = await createTenant(t.prisma, { slug: uniqueSlug('voz-prompt') });
      const skill = await createSkill(t.prisma, { tenantId: tenant.id, name: 'impresoras', promptText: 'Glosario de impresoras.' });
      await createFlow(t.prisma, {
        name: 'voz charla',
        channel: 'voice',
        skillId: skill.id,
        nodes: [
          startNode('start', { noGreeting: true }),
          llmQueryNode('charla', { systemPrompt: 'Hablá de impresoras.', systemPromptMode: 'append' }),
        ],
        edges: [edge('start', 'charla')],
        assign: [{ tenantId: tenant.id, isStart: true }],
      });
      const ext = extNumber();
      await t.prisma.extension.create({ data: { number: ext, name: 'prompt', tenantId: tenant.id } });

      const r = await start(uid(), ext);
      expect(r.actions).toEqual([
        {
          type: 'say',
          mode: 'delegate',
          systemPrompt: [
            VOICEBOT_FREE_CHAT_PROMPT_DEFAULT.replaceAll('{{empresa}}', tenant.name),
            'Glosario de impresoras.',
            'Hablá de impresoras.',
          ].join('\n\n'),
        },
      ]);
      expect(llm.calls).toHaveLength(0);
    });

    it('BE-VOZ-19: VOICEBOT_FREE_CHAT_PROMPT configurado reemplaza al default, con {{empresa}}; no viaja en la config del voicebot', async () => {
      await setSetting(t.prisma, 'VOICEBOT_FREE_CHAT_PROMPT', 'Sos la línea de {{empresa}}. Solo conversás.');
      try {
        const tenant = await createTenant(t.prisma, { slug: uniqueSlug('voz-config') });
        const ext = extNumber();
        await t.prisma.extension.create({ data: { number: ext, name: 'config', tenantId: tenant.id } });
        const r = await start(uid(), ext);
        expect(r.actions).toEqual([
          { type: 'say', mode: 'delegate', systemPrompt: `Sos la línea de ${tenant.name}. Solo conversás.` },
        ]);

        const config = await t.moduleRef.get(IntegrationsConfigService).voicebotConfig();
        expect(Object.keys(config.settings)).not.toContain('VOICEBOT_FREE_CHAT_PROMPT');
        expect(Object.keys(config.settings)).not.toContain('FREE_CHAT_PROMPT');
      } finally {
        await deleteSetting(t.prisma, 'VOICEBOT_FREE_CHAT_PROMPT');
      }
    });
  });

  describe('Flujos por canal', () => {
    it('BE-VOZ-16: el texto nunca toma un flujo de voz, y el inicio de voz es uno por tenant sin destronar al de texto', async () => {
      const flows = t.moduleRef.get(FlowService);
      // La asignación real, sin el corte de pertenencia de `assignTenants` (eso ya lo cubren los
      // specs de flujos): acá interesa solo la invariante del inicio por canal.
      const assign = (flowId: string, tenant: string) =>
        (flows as unknown as {
          applyTenantAssignment: (f: string, a: { tenantId: string; roleIds: string[] }[], s: boolean) => Promise<void>;
        }).applyTenantAssignment(flowId, [{ tenantId: tenant, roleIds: [] }], true);
      const tenant = await createTenant(t.prisma, { slug: uniqueSlug('voz-canal') });
      const role = await t.prisma.role.create({ data: { name: `r-${uid()}`, tenantId: tenant.id } });
      const text = await createFlow(t.prisma, {
        name: 'texto inicio',
        nodes: [startNode()],
        assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
      });
      const voiceA = await createFlow(t.prisma, { name: 'voz A', channel: 'voice', nodes: [startNode()] });
      const voiceB = await createFlow(t.prisma, { name: 'voz B', channel: 'voice', nodes: [startNode()] });

      await assign(voiceA.id, tenant.id);
      expect((await flows.findActiveFlowForTenant(tenant.id, role.id))?.id).toBe(text.id);

      await assign(voiceB.id, tenant.id);
      const starts = await t.prisma.tenantFlow.findMany({ where: { tenantId: tenant.id, isStart: true } });
      expect(starts.map((s) => s.flowId).sort()).toEqual([text.id, voiceB.id].sort());
      expect((await flows.findVoiceFlowForExtension({ tenantId: tenant.id, flowId: null }))?.id).toBe(voiceB.id);
    });
  });

  describe('Presupuesto [§5.5]', () => {
    it('BE-VOZ-17: p95 < 300 ms en turnos literales, medido desde que se manda voice.turn', async () => {
      const samples: number[] = [];
      for (let i = 0; i < 10; i++) {
        const callId = uid();
        for (const step of [() => start(callId), () => say(callId, 'Ana'), () => say(callId, 'Pérez')]) {
          const t0 = Date.now();
          const r = await step();
          samples.push(Date.now() - t0);
          expect(r.error).toBeNull();
        }
      }
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
      // eslint-disable-next-line no-console
      console.log(`[BE-VOZ-17] ${samples.length} turnos · p50 ${samples[Math.floor(samples.length / 2)]} ms · p95 ${p95} ms`);
      expect(p95).toBeLessThan(300);
    });
  });
});
