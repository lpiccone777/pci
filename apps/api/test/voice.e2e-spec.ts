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
  createRole,
  createUser,
  uniqueEmail,
  installFetchMock,
  node,
  createContextSource,
  weatherToolScript,
} from './support';
import { FAKE_MCP_API_KEY, startFakeMcp } from './support/fake-mcp-server';
import { SecretsCipher } from '../src/config/secrets.cipher';
import { BrokerService, BrokerMessage } from '../src/modules/broker/broker.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { FlowService } from '../src/modules/flow/flow.service';
import { IntegrationsConfigService } from '../src/modules/integrations/integrations-config.service';
import { ContextSourcesService } from '../src/modules/context-sources/context-sources.service';
import { VOICEBOT_FREE_CHAT_PROMPT_DEFAULT } from '../src/modules/settings/voicebot-settings.catalog';

type Reply = {
  v: number;
  turnId: string;
  actions: Array<{
    type: string;
    mode?: string;
    text?: string;
    systemPrompt?: string;
    instruction?: string;
    facts?: Record<string, string>;
    context?: string;
    extension?: string;
  }>;
  awaitInput: boolean;
  noInputMs?: number;
  committed: boolean;
  superseded: boolean;
  error: string | null;
};

type Progress = { v: number; kind: 'progress'; turnId: string; reason: string; label?: string; expectedMs: number };

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

  const progressByCorrelation = new Map<string, Progress[]>();

  /** Un `voice.turn` como lo manda el voicebot, esperando la respuesta correlacionada. */
  const turn = (data: Record<string, unknown>, timeoutMs = 10_000, correlationId = `c-${uid()}`): Promise<Reply> => {
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
  /** Un turno con `progress: true` [C65]: la respuesta y los avisos que llegaron antes que ella. */
  const turnWithProgress = async (data: Record<string, unknown>) => {
    const correlationId = `c-${uid()}`;
    const reply = await turn({ progress: true, ...data }, 10_000, correlationId);
    return { reply, progress: progressByCorrelation.get(correlationId) ?? [] };
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
      // Avisos de progreso [C65]: van antes de la respuesta, por el mismo replyTo y correlationId.
      if ((body.data as { kind?: string }).kind === 'progress') {
        const list = progressByCorrelation.get(body.correlationId!) ?? [];
        list.push(body.data as Progress);
        progressByCorrelation.set(body.correlationId!, list);
        return;
      }
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

    it('BE-VOZ-32: un start repetido de la misma llamada no es entrada del usuario: responde lo mismo que el primero [C59]', async () => {
      const callId = uid();
      const first = await start(callId);
      // Parada en el input del nombre: un segundo start no tiene que tomarse como respuesta.
      const again = await start(callId);
      expect(again.actions).toEqual(first.actions);
      expect(again.turnId).not.toBe(first.turnId);
      const conv = (await callOf(callId))!.conversation;
      expect(conv.currentNodeId).toBe('nombre');
      expect((conv.flowState as Record<string, unknown>).nombre).toBeUndefined();
      expect(literals(await say(callId, 'Ana'))).toEqual(['¿Y tu apellido?']);
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

  describe('Identificar por voz [C52]', () => {
    const INVGATE = 'https://invgate.voz.e2e.test';
    let identTenant: { id: string; name: string };
    let identExt: string;
    let fetchMock: ReturnType<typeof installFetchMock>;
    const people: Record<string, { id: number; name: string; lastname: string; email: string }> = {
      '32456789': { id: 3649, name: 'Ana María', lastname: 'Pérez', email: '' },
      '20111222': { id: 4000, name: 'Solo', lastname: 'Externo', email: 'solo.externo@e2e.test' },
    };

    beforeAll(async () => {
      identTenant = await createTenant(t.prisma, { slug: uniqueSlug('voz-ident') });
      const role = await createRole(t.prisma, { tenantId: identTenant.id, name: 'Empleado' });
      const email = uniqueEmail('ana');
      people['32456789'].email = email.toUpperCase(); // el cruce por email no distingue mayúsculas
      await createUser(t.prisma, {
        email,
        firstName: 'Ana',
        lastName: 'Pérez',
        memberships: [{ tenantId: identTenant.id, roleId: role.id }],
      });
      await createFlow(t.prisma, {
        name: 'voz identificación',
        channel: 'voice',
        nodes: [
          startNode('start', { noGreeting: true }),
          node('ident', 'voice_identify', { idLabel: 'legajo' }),
          messageNode('ok', 'Hola {{userFirstName}}, sos {{userRole}}.'),
          inputNode('sigue', { text: '¿En qué te ayudo?', variableName: 'pedido' }),
          messageNode('no', 'No te pude identificar.'),
          inputNode('igual', { text: '¿Te ayudo igual?', variableName: 'igual' }),
        ],
        edges: [
          edge('start', 'ident'),
          edge('ident', 'ok', 'recognized'),
          edge('ok', 'sigue'),
          edge('ident', 'no', 'unrecognized'),
          edge('no', 'igual'),
        ],
        assign: [{ tenantId: identTenant.id, isStart: true }],
      });
      identExt = extNumber();
      await t.prisma.extension.create({ data: { number: identExt, name: 'identificación', tenantId: identTenant.id } });

      fetchMock = installFetchMock((url) => {
        const u = new URL(url);
        if (!url.startsWith(INVGATE) || !u.pathname.endsWith('/api/v1/users.by')) return { status: 404, body: {} };
        const person = people[u.searchParams.get('employee_number') ?? ''];
        return { body: { data: person ? { [person.id]: { ...person, is_disabled: false, is_deleted: false } } : {} } };
      });
    });
    afterAll(async () => {
      fetchMock.restore();
      for (const key of ['INVGATE_API_URL', 'INVGATE_API_USER', 'INVGATE_API_KEY']) await deleteSetting(t.prisma, key);
    });
    beforeEach(async () => {
      await setSetting(t.prisma, 'INVGATE_API_URL', INVGATE);
      await setSetting(t.prisma, 'INVGATE_API_USER', 'tecnico');
      await setSetting(t.prisma, 'INVGATE_API_KEY', 'key-e2e');
    });
    const sayTo = (callId: string, text: string) =>
      turn({ callId, turnId: uid(), kind: 'user', text, call: callInfo(identExt) });

    it('BE-VOZ-20: reconocido: legajo dictado con puntos + nombre aproximado → completa Conversation.userId y sigue con su rol', async () => {
      const callId = uid();
      expect(literals(await start(callId, identExt))).toEqual(['Para identificarte, decime tu número de legajo.']);
      expect(literals(await sayTo(callId, 'es el 32.456.789'))).toEqual(['Gracias. Ahora decime tu nombre y apellido.']);
      const r = await sayTo(callId, 'ana peres');
      expect(literals(r)).toEqual(['Hola Ana, sos Empleado.', '¿En qué te ayudo?']);

      const conv = (await callOf(callId))!.conversation;
      const user = await t.prisma.user.findFirstOrThrow({ where: { email: { equals: people['32456789'].email, mode: 'insensitive' } } });
      expect(conv.userId).toBe(user.id);
      const lookups = fetchMock.requests.filter((q) => q.url.includes('users.by'));
      expect(new URL(lookups.at(-1)!.url).searchParams.get('employee_number')).toBe('32456789');
      expect(llm.calls).toHaveLength(0);
    });

    it('BE-VOZ-38: con progress:true avisa "identify" justo al buscar en InvGate, no antes [C65]', async () => {
      const callId = uid();
      const first = await turnWithProgress({ callId, turnId: uid(), kind: 'start', call: callInfo(identExt) });
      expect(first.progress).toEqual([]); // pedir el legajo no consulta nada
      const { reply, progress } = await turnWithProgress({ callId, turnId: uid(), kind: 'user', text: '32456789', call: callInfo(identExt) });
      expect(literals(reply)).toEqual(['Gracias. Ahora decime tu nombre y apellido.']);
      expect(progress).toEqual([{ v: 1, kind: 'progress', turnId: expect.any(String), reason: 'identify', expectedMs: 15000 }]);
    });

    it('BE-VOZ-21: dos intentos fallidos (documento inexistente, después nombre que no coincide) → no reconocido', async () => {
      const callId = uid();
      await start(callId, identExt);
      expect(literals(await sayTo(callId, '11111111'))[0]).toMatch(/^No pude encontrarte con esos datos/);
      await sayTo(callId, '32456789');
      const last = await sayTo(callId, 'Juan Gómez');
      expect(literals(last)).toEqual(['No te pude identificar.', '¿Te ayudo igual?']);
      expect((await callOf(callId))!.conversation.userId).toBeNull();
    });

    it('BE-VOZ-22: está en InvGate pero no en pci → no reconocido, con identifiedExternal y sin crear el User', async () => {
      const callId = uid();
      await start(callId, identExt);
      await sayTo(callId, '20111222');
      const last = await sayTo(callId, 'Solo Externo');
      expect(literals(last)).toEqual(['No te pude identificar.', '¿Te ayudo igual?']);
      const conv = (await callOf(callId))!.conversation;
      expect(conv.userId).toBeNull();
      expect((conv.flowState as Record<string, unknown>).identifiedExternal).toEqual({
        nombre: 'Solo',
        apellido: 'Externo',
        email: 'solo.externo@e2e.test',
        invgateId: 4000,
      });
      expect(await t.prisma.user.count({ where: { email: 'solo.externo@e2e.test' } })).toBe(0);
    });

    it('BE-VOZ-23: InvGate sin configurar (C55): no pide documento; nombre y apellido contra los usuarios de la empresa → reconocido', async () => {
      await setSetting(t.prisma, 'INVGATE_API_URL', '');
      // Otra "Ana Pérez" en otra empresa no cuenta: se busca solo en la empresa de la llamada.
      const otherTenant = await createTenant(t.prisma, { slug: uniqueSlug('voz-ident-otra') });
      const otherRole = await createRole(t.prisma, { tenantId: otherTenant.id, name: 'Otro' });
      await createUser(t.prisma, {
        email: uniqueEmail('ana-otra'),
        firstName: 'Ana',
        lastName: 'Pérez',
        memberships: [{ tenantId: otherTenant.id, roleId: otherRole.id }],
      });
      const before = fetchMock.requests.length;
      const callId = uid();
      expect(literals(await start(callId, identExt))).toEqual(['Para identificarte, decime tu nombre y apellido.']);
      const r = await sayTo(callId, 'ana peres');
      expect(literals(r)).toEqual(['Hola Ana, sos Empleado.', '¿En qué te ayudo?']);
      const user = await t.prisma.user.findFirstOrThrow({ where: { email: { equals: people['32456789'].email, mode: 'insensitive' } } });
      expect((await callOf(callId))!.conversation.userId).toBe(user.id);
      expect(fetchMock.requests.length).toBe(before);
    });

    it('BE-VOZ-29: InvGate sin configurar (C55): un nombre que no coincide pide de nuevo; a la segunda, no reconocido', async () => {
      await setSetting(t.prisma, 'INVGATE_API_URL', '');
      const callId = uid();
      await start(callId, identExt);
      expect(literals(await sayTo(callId, 'Juan Gómez'))).toEqual([
        'No te encontré con ese nombre. Decime de nuevo tu nombre y apellido, por favor.',
      ]);
      expect(literals(await sayTo(callId, 'Pedro Ruiz'))).toEqual(['No te pude identificar.', '¿Te ayudo igual?']);
      expect((await callOf(callId))!.conversation.userId).toBeNull();
    });
  });

  describe('Cómo habla cada nodo (H4b)', () => {
    /** Tenant + interno + flujo de voz de inicio con `nodes`/`edges`; devuelve el interno. */
    const voiceSetup = async (label: string, nodes: unknown[], edges: unknown[]) => {
      const tenant = await createTenant(t.prisma, { slug: uniqueSlug(label) });
      await createFlow(t.prisma, { name: label, channel: 'voice', nodes, edges, assign: [{ tenantId: tenant.id, isStart: true }] });
      const ext = extNumber();
      await t.prisma.extension.create({ data: { number: ext, name: label, tenantId: tenant.id } });
      return { tenant, ext };
    };
    const sayOn = (callId: string, ext: string, text: string) => turn({ callId, turnId: uid(), kind: 'user', text, call: callInfo(ext) });

    it('BE-VOZ-24: un nodo en modo guided manda la instrucción y sus {{variables}} como facts', async () => {
      const { ext } = await voiceSetup(
        'voz-guided',
        [
          startNode('start', { noGreeting: true }),
          inputNode('nombre', { text: '¿Cómo te llamás?', variableName: 'nombre' }),
          node('m', 'message', { text: 'Saludá a {{nombre}} y contale que la línea es de soporte.', speechMode: 'guided' }),
          inputNode('pedido', { text: '¿Qué necesitás?', variableName: 'pedido' }),
        ],
        [edge('start', 'nombre'), edge('nombre', 'm'), edge('m', 'pedido')],
      );
      const callId = uid();
      await start(callId, ext);
      const r = await sayOn(callId, ext, 'Ana');
      expect(r.actions).toEqual([
        { type: 'say', mode: 'guided', instruction: 'Saludá a Ana y contale que la línea es de soporte.', facts: { nombre: 'Ana' } },
        { type: 'say', mode: 'literal', text: '¿Qué necesitás?' },
      ]);
      expect(llm.calls).toHaveLength(0);
    });

    it('BE-VOZ-25: menú por voz sin LLM: elige por etiqueta, repite guiado (ofreciendo hacer una consulta) si no entiende y a la segunda delega', async () => {
      const { ext } = await voiceSetup(
        'voz-menu2',
        [
          startNode('start', { noGreeting: true }),
          menuNode('menu', { text: '¿Con qué área?', options: [{ value: 's', label: 'Soporte técnico' }, { value: 'v', label: 'Ventas' }] }),
          messageNode('ventas', 'Te paso con ventas.'),
          inputNode('fin', { text: '¿Algo más?', variableName: 'x' }),
        ],
        [edge('start', 'menu'), edge('menu', 'ventas', 'v'), edge('ventas', 'fin')],
      );
      const callId = uid();
      await start(callId, ext);
      expect(literals(await sayOn(callId, ext, 'quiero bentas'))).toEqual(['Te paso con ventas.', '¿Algo más?']);

      const other = uid();
      await start(other, ext);
      const again = await sayOn(other, ext, 'no sé qué decirte');
      expect(again.actions).toHaveLength(1);
      expect(again.actions[0]).toMatchObject({ type: 'say', mode: 'guided' });
      expect(again.actions[0].instruction).toContain('1. Soporte técnico; 2. Ventas');
      expect(again.actions[0].instruction).toContain('preguntale si prefiere hacer una consulta');
      const delegated = await sayOn(other, ext, 'tampoco');
      expect(delegated.actions[0]).toMatchObject({ type: 'say', mode: 'delegate' });
      expect(llm.calls).toHaveLength(0);
    });

    it('BE-VOZ-30: menú por voz, opción sin salida conectada → avisa que no está disponible y repite el menú (no cae en otra)', async () => {
      const { ext } = await voiceSetup(
        'voz-menu-sin-salida',
        [
          startNode('start', { noGreeting: true }),
          menuNode('menu', { text: 'Elegí una opción:', options: [{ value: '1', label: 'Opción 1' }, { value: '2', label: 'Opción 2' }] }),
          messageNode('uno', 'Elegiste la opción 1.'),
          inputNode('fin', { text: '¿Algo más?', variableName: 'x' }),
        ],
        [edge('start', 'menu'), edge('menu', 'uno', '1'), edge('uno', 'fin')],
      );
      const callId = uid();
      await start(callId, ext);
      const r = await sayOn(callId, ext, '¿Me escuchás? Opción 2.');
      expect(literals(r)).toEqual(['La opción "Opción 2" no está disponible.\n\nElegí una opción:\n1. Opción 1\n2. Opción 2']);
      expect(literals(await sayOn(callId, ext, 'la uno'))).toEqual(['Elegiste la opción 1.', '¿Algo más?']);
    });

    it('BE-VOZ-31: DTMF [C57]: en el menú elige por número antes que el texto; en otro nodo cuenta como el dígito; queda como "[tecla N]"', async () => {
      const { ext } = await voiceSetup(
        'voz-dtmf',
        [
          startNode('start', { noGreeting: true }),
          menuNode('menu', { text: 'Elegí:', options: [{ value: 's', label: 'Soporte' }, { value: 'v', label: 'Ventas' }] }),
          inputNode('nro', { text: 'Marcá tu número de sucursal.', variableName: 'sucursal' }),
          messageNode('ok', 'Sucursal {{sucursal}} anotada.'),
          inputNode('fin', { text: '¿Algo más?', variableName: 'x' }),
        ],
        [edge('start', 'menu'), edge('menu', 'nro', 'v'), edge('nro', 'ok'), edge('ok', 'fin')],
      );
      const callId = uid();
      await start(callId, ext);
      // Dice "soporte" pero marca 2: gana la tecla (Ventas).
      const keyed = await turn({ callId, turnId: uid(), kind: 'user', text: 'quiero soporte', dtmf: '2', call: callInfo(ext) });
      expect(literals(keyed)).toEqual(['Marcá tu número de sucursal.']);

      const turnId = uid();
      const onlyKey = await turn({ callId, turnId, kind: 'user', dtmf: '7', call: callInfo(ext) });
      expect(literals(onlyKey)).toEqual(['Sucursal 7 anotada.', '¿Algo más?']);
      const row = await t.prisma.voiceTurn.findUniqueOrThrow({ where: { id: turnId } });
      expect(row.text).toBe('[tecla 7]');
      expect((await t.prisma.message.findUniqueOrThrow({ where: { id: row.userMessageId! } })).content).toBe('[tecla 7]');

      const bad = await turn({ callId, turnId: uid(), kind: 'user', dtmf: '22', call: callInfo(ext) });
      expect(bad.error).toBe('invalid_request');
      expect(llm.calls).toHaveLength(0);
    });

    it('BE-VOZ-33: una tecla que no corresponde a ninguna opción avisa en literal y repite el menú (nunca guided ni delegate)', async () => {
      const { ext } = await voiceSetup(
        'voz-tecla-mal',
        [
          startNode('start', { noGreeting: true }),
          menuNode('menu', { text: 'Elegí:', options: [{ value: 'a', label: 'Uno' }, { value: 'b', label: 'Dos' }] }),
          messageNode('fin', 'Listo.'),
        ],
        [edge('start', 'menu'), edge('menu', 'fin', 'a')],
      );
      const callId = uid();
      await start(callId, ext);
      for (const [key, notice] of [
        ['3', 'La opción 3 no existe.'],
        ['#', 'Esa tecla no corresponde a ninguna opción.'],
      ]) {
        const r = await turn({ callId, turnId: uid(), kind: 'user', dtmf: key, call: callInfo(ext) });
        expect(r.actions).toEqual([{ type: 'say', mode: 'literal', text: `${notice}\n\nElegí:\n1. Uno\n2. Dos` }]);
      }
      // Sigue en el menú: la tecla 1 elige.
      expect(literals(await turn({ callId, turnId: uid(), kind: 'user', dtmf: '1', call: callInfo(ext) }))).toEqual(['Listo.']);
      // Y esos avisos son literales fijos: viajan en voiceLiterals.
      const lits = (await t.moduleRef.get(IntegrationsConfigService).voicebotConfig()).voiceLiterals;
      expect(lits).toContain('La opción 3 no existe.\n\nElegí:\n1. Uno\n2. Dos');
      expect(lits).toContain('Esa tecla no corresponde a ninguna opción.\n\nElegí:\n1. Uno\n2. Dos');
    });

    it('BE-VOZ-26: llm_query en extracción por voz: la pregunta va guided (sin generarla con el LLM de pci); solo extrae', async () => {
      llm.setReply('sede: NONE');
      try {
        const { ext } = await voiceSetup(
          'voz-extract',
          [
            startNode('start', { noGreeting: true }),
            llmQueryNode('datos', { extractVariables: [{ variable: 'sede', label: 'Sede', allowedValues: ['Centro', 'Norte'] }] }),
          ],
          [edge('start', 'datos')],
        );
        const r = await start(uid(), ext);
        expect(r.actions).toHaveLength(1);
        expect(r.actions[0]).toMatchObject({ type: 'say', mode: 'guided' });
        expect(r.actions[0].instruction).toContain('Sede (Centro, Norte)');
        expect(llm.calls).toHaveLength(1); // solo el extractor
      } finally {
        llm.setReply('respuesta simulada del modelo');
      }
    });

    it('BE-VOZ-27: delegate con context de la fuente de verdad: recortado al tope; si la fuente tarda más que la espera, va sin context', async () => {
      const contexts = t.moduleRef.get(ContextSourcesService);
      const tenant = await createTenant(t.prisma, { slug: uniqueSlug('voz-ctx') });
      const source = await createContextSource(t.prisma, { tenantId: tenant.id, name: 'kb', type: 'broker' });
      await createFlow(t.prisma, {
        name: 'voz ctx',
        channel: 'voice',
        contextSourceId: source.id,
        nodes: [startNode('start', { noGreeting: true }), inputNode('q', { text: 'Contame.', variableName: 'q' }), llmQueryNode('charla', { systemPrompt: 'Soporte.' })],
        edges: [edge('start', 'q'), edge('q', 'charla')],
        assign: [{ tenantId: tenant.id, isStart: true }],
      });
      const ext = extNumber();
      await t.prisma.extension.create({ data: { number: ext, name: 'ctx', tenantId: tenant.id } });

      const spy = jest.spyOn(contexts, 'queryKnowledge').mockResolvedValue({ ok: true, answer: 'x'.repeat(20000) } as never);
      try {
        const callId = uid();
        await start(callId, ext);
        const r = await turn({ callId, turnId: uid(), kind: 'user', text: 'se rompió la impresora', call: callInfo(ext) });
        expect(r.actions[0]).toMatchObject({ type: 'say', mode: 'delegate', systemPrompt: 'Soporte.' });
        expect(r.actions[0].context).toHaveLength(16000);
        expect(spy).toHaveBeenCalledWith(tenant.id, source.id, 'se rompió la impresora');

        await setSetting(t.prisma, 'VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS', '100');
        spy.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true, answer: 'tarde' } as never), 600)));
        const slow = uid();
        await start(slow, ext);
        const r2 = await turn({ callId: slow, turnId: uid(), kind: 'user', text: 'hola', call: callInfo(ext) });
        expect(r2.actions[0]).toEqual({ type: 'say', mode: 'delegate', systemPrompt: 'Soporte.' });
      } finally {
        spy.mockRestore();
        await deleteSetting(t.prisma, 'VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS');
      }
    });

    it('BE-VOZ-39: progress "source" con el nombre para voz y la espera vigente; sin progress:true no hay avisos; un replay no los repite [C65]', async () => {
      const contexts = t.moduleRef.get(ContextSourcesService);
      const tenant = await createTenant(t.prisma, { slug: uniqueSlug('voz-progress') });
      const source = await createContextSource(t.prisma, { tenantId: tenant.id, name: 'kb', type: 'broker' });
      await t.prisma.contextSource.update({ where: { id: source.id }, data: { voiceName: 'la base de conocimiento' } });
      await createFlow(t.prisma, {
        name: 'voz progress',
        channel: 'voice',
        contextSourceId: source.id,
        nodes: [startNode('start', { noGreeting: true }), inputNode('q', { text: 'Contame.', variableName: 'q' }), llmQueryNode('charla', { systemPrompt: 'Soporte.' })],
        edges: [edge('start', 'q'), edge('q', 'charla')],
        assign: [{ tenantId: tenant.id, isStart: true }],
      });
      const ext = extNumber();
      await t.prisma.extension.create({ data: { number: ext, name: 'progress', tenantId: tenant.id } });

      const spy = jest.spyOn(contexts, 'queryKnowledge').mockResolvedValue({ ok: true, answer: 'dato' } as never);
      try {
        const callId = uid();
        await start(callId, ext);
        const turnId = uid();
        const data = { callId, turnId, kind: 'user', text: 'se rompió la impresora', call: callInfo(ext) };
        const { reply, progress } = await turnWithProgress(data);
        expect(reply.actions[0]).toMatchObject({ mode: 'delegate', context: expect.stringContaining('dato') });
        expect(progress).toEqual([
          { v: 1, kind: 'progress', turnId, reason: 'source', label: 'la base de conocimiento', expectedMs: 12000 },
        ]);

        // Mismo turnId [C27]: la misma respuesta, sin volver a avisar.
        const again = await turnWithProgress(data);
        expect(again.reply).toEqual(reply);
        expect(again.progress).toEqual([]);

        // Sin nombre para voz: avisa sin label. Sin progress:true: nada, y la espera vuelve a 7000.
        await t.prisma.contextSource.update({ where: { id: source.id }, data: { voiceName: null } });
        const second = await turnWithProgress({ callId, turnId: uid(), kind: 'user', text: 'otra cosa', call: callInfo(ext) });
        expect(second.progress.map(({ reason, label }) => ({ reason, label }))).toEqual([{ reason: 'source', label: undefined }]);
        const correlationId = `c-${uid()}`;
        await turn({ callId, turnId: uid(), kind: 'user', text: 'y otra', call: callInfo(ext) }, 10_000, correlationId);
        expect(progressByCorrelation.get(correlationId)).toBeUndefined();

        await setSetting(t.prisma, 'VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS', '9000');
        const custom = await turnWithProgress({ callId, turnId: uid(), kind: 'user', text: 'más', call: callInfo(ext) });
        expect(custom.progress[0].expectedMs).toBe(9000);
      } finally {
        spy.mockRestore();
        await deleteSetting(t.prisma, 'VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS');
      }
    });

    // `delay` y `ticket_query` no existen por voz (VOICE_UNSUPPORTED_NODES): sus avisos no salen hoy.
    it('BE-VOZ-40: varios pasos lentos en un turno: un progress por paso, en orden y antes de la respuesta [C65]', async () => {
      const fetchMock = installFetchMock(() => ({ body: { ok: true } }));
      try {
        const { ext } = await voiceSetup(
          'voz-progress-pasos',
          [
            startNode('start', { noGreeting: true }),
            inputNode('q', { text: '¿Qué necesitás?', variableName: 'q' }),
            node('aviso', 'webhook', { url: 'https://hooks.voz.e2e.test/aviso', method: 'POST', body: '{"q":"{{q}}"}' }),
            node('registro', 'webhook', { url: 'https://hooks.voz.e2e.test/registro', method: 'POST' }),
            inputNode('fin', { text: 'Listo, ¿algo más?', variableName: 'mas' }),
          ],
          [edge('start', 'q'), edge('q', 'aviso'), edge('aviso', 'registro'), edge('registro', 'fin')],
        );
        const callId = uid();
        await start(callId, ext);
        const { reply, progress } = await turnWithProgress({ callId, turnId: uid(), kind: 'user', text: 'reset de clave', call: callInfo(ext) });
        expect(literals(reply)).toEqual(['Listo, ¿algo más?']);
        expect(reply.committed).toBe(true); // el webhook es un efecto [DA1]
        expect(progress.map(({ reason, expectedMs }) => ({ reason, expectedMs }))).toEqual([
          { reason: 'webhook', expectedMs: 10000 },
          { reason: 'webhook', expectedMs: 10000 },
        ]);
        expect(fetchMock.requests.map((r) => r.url)).toEqual(['https://hooks.voz.e2e.test/aviso', 'https://hooks.voz.e2e.test/registro']);
      } finally {
        fetchMock.restore();
      }
    });

    it('BE-VOZ-34: fuente MCP con tools [C61]: el LLM de pci encadena geocoding → forecast y el resultado va como context; con la espera vencida, sin context', async () => {
      const fake = await startFakeMcp({ weather: true });
      const cipher = t.moduleRef.get(SecretsCipher, { strict: false });
      const tenant = await createTenant(t.prisma, { slug: uniqueSlug('voz-tools') });
      const source = await createContextSource(t.prisma, {
        tenantId: tenant.id,
        name: 'clima',
        type: 'mcp',
        config: {
          serverUrl: `${fake.baseUrl}/mcp`,
          transport: 'http',
          authType: 'bearer',
          apiKey: cipher.encrypt(FAKE_MCP_API_KEY),
          tools: [
            { name: 'geocoding', arguments: { name: '{{pregunta}}', count: 1, language: 'es' } },
            { name: 'weather_forecast', arguments: { latitude: 0, longitude: 0, temperature_unit: 'celsius', forecast_days: 2 } },
          ],
        },
      });
      await createFlow(t.prisma, {
        name: 'voz tools',
        channel: 'voice',
        contextSourceId: source.id,
        nodes: [startNode('start', { noGreeting: true }), inputNode('q', { text: 'Contame.', variableName: 'q' }), llmQueryNode('charla', { systemPrompt: 'Soporte.' })],
        edges: [edge('start', 'q'), edge('q', 'charla')],
        assign: [{ tenantId: tenant.id, isStart: true }],
      });
      const ext = extNumber();
      await t.prisma.extension.create({ data: { number: ext, name: 'tools', tenantId: tenant.id } });

      const script = weatherToolScript({ finalText: () => 'LISTO' });
      llm.setToolProvider(script.provider);
      try {
        const callId = uid();
        await start(callId, ext);
        const r = await turn({ callId, turnId: uid(), kind: 'user', text: '¿qué tiempo hace mañana en Merlo?', call: callInfo(ext) });
        expect(r.error).toBeNull();
        expect(r.actions).toHaveLength(1);
        expect(r.actions[0]).toMatchObject({ type: 'say', mode: 'delegate', systemPrompt: 'Soporte.' });
        expect(r.actions[0].context).toContain('Resultados de la fuente de verdad "clima"');
        expect(r.actions[0].context).toContain('### geocoding');
        expect(r.actions[0].context).toContain('Pronóstico en -34.66536,-58.72744 (celsius, 2 días)');
        expect(llm.calls).toHaveLength(0);
        expect(llm.toolChats.map((c) => c.voice)).toEqual([true]); // el LLM de voz, no el del chat
        // El LLM de pci vio la charla (el pedido de la persona) y no contestó: solo trajo datos.
        expect(script.steps).toHaveLength(3);
        expect(script.steps[0].messages.map((m) => m.content)).toContain('¿qué tiempo hace mañana en Merlo?');
        expect(script.steps[0].messages[0].content).toContain('Otro asistente le va a contestar');

        await setSetting(t.prisma, 'VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS', '150');
        llm.setToolProvider({
          generateWithTools: (messages, turns, tools) =>
            new Promise((resolve) => setTimeout(() => resolve(script.provider.generateWithTools(messages, turns, tools)), 400)),
        });
        const slow = uid();
        await start(slow, ext);
        const began = Date.now();
        const r2 = await turn({ callId: slow, turnId: uid(), kind: 'user', text: 'Merlo', call: callInfo(ext) });
        expect(r2.actions[0]).toEqual({ type: 'say', mode: 'delegate', systemPrompt: 'Soporte.' });
        expect(Date.now() - began).toBeLessThan(1500);
      } finally {
        llm.setToolProvider(null);
        await deleteSetting(t.prisma, 'VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS');
        await fake.close();
      }
    });

    /** Menú Consulta (input sin salida) / Reclamo (mensaje → end): la rama Consulta deja el flujo sin paso siguiente. */
    const deadEndFlow = (label: string) =>
      voiceSetup(
        label,
        [
          startNode('start', { noGreeting: true }),
          menuNode('menu', { text: 'Elegí:', options: [{ value: '1', label: 'Consulta' }, { value: '2', label: 'Reclamo' }] }),
          inputNode('consulta', { text: 'Decime:', variableName: 'consulta' }),
          messageNode('reclamo', 'Te tomo el reclamo.'),
          endNode('fin', 'Chau.'),
        ],
        [edge('start', 'menu'), edge('menu', 'consulta', '1'), edge('menu', 'reclamo', '2'), edge('reclamo', 'fin')],
      );
    const ASK = '¿Algo más en lo que te pueda ayudar?';
    const BYE = 'Gracias por comunicarte. ¡Hasta luego!';

    it('BE-VOZ-35: flujo sin paso siguiente [C64]: "¿Algo más…?" con noInputMs; no_input → despedida y hangup committed', async () => {
      const { ext } = await deadEndFlow('voz-c64-a');
      const callId = uid();
      await start(callId, ext);
      expect(literals(await sayOn(callId, ext, '1'))).toEqual(['Decime:']);

      const r = await sayOn(callId, ext, 'quería preguntar si mañana trabajamos');
      expect(r.error).toBeNull();
      expect(r.actions).toEqual([{ type: 'say', mode: 'literal', text: ASK }]);
      expect(r).toMatchObject({ awaitInput: true, noInputMs: 8000 });

      const bye = await turn({ callId, turnId: uid(), kind: 'no_input', call: callInfo(ext) });
      expect(bye.actions).toEqual([{ type: 'say', mode: 'literal', text: BYE }, { type: 'hangup' }]);
      expect(bye).toMatchObject({ awaitInput: false, committed: true, error: null });
      expect(bye.noInputMs).toBeUndefined();

      // Los dos textos van pre-sintetizados [C60].
      const config = await t.moduleRef.get(IntegrationsConfigService).voicebotConfig();
      expect(config.voiceLiterals).toEqual(expect.arrayContaining([ASK, BYE]));
    });

    it('BE-VOZ-36: después del "¿Algo más…?", una respuesta va al último menú; una negativa corta despide y corta', async () => {
      const { ext } = await deadEndFlow('voz-c64-b');
      const callId = uid();
      await start(callId, ext);
      await sayOn(callId, ext, '1');
      expect(literals(await sayOn(callId, ext, 'una consulta'))).toEqual([ASK]);
      expect(literals(await sayOn(callId, ext, 'sí, quiero hacer un reclamo'))).toEqual(['Te tomo el reclamo.', 'Chau.']);

      const other = uid();
      await start(other, ext);
      await sayOn(other, ext, '1');
      await sayOn(other, ext, 'otra cosa');
      const no = await sayOn(other, ext, 'No, gracias.');
      expect(no.actions).toEqual([{ type: 'say', mode: 'literal', text: BYE }, { type: 'hangup' }]);
      expect(no.committed).toBe(true);
    });

    it('BE-VOZ-37: sin menú previo, la respuesta rearranca el flujo sin el saludo; noInputMs se lleva al rango', async () => {
      const { ext } = await voiceSetup(
        'voz-c64-c',
        [startNode('start', { text: 'Hola, soy el bot.' }), inputNode('q', { text: '¿Qué necesitás?', variableName: 'q' })],
        [edge('start', 'q')],
      );
      await setSetting(t.prisma, 'VOICEBOT_END_FALLBACK_NO_INPUT_MS', '50000');
      try {
        const callId = uid();
        expect(literals(await start(callId, ext))).toEqual(['Hola, soy el bot.', '¿Qué necesitás?']);
        const r = await sayOn(callId, ext, 'algo');
        expect(literals(r)).toEqual([ASK]);
        expect(r.noInputMs).toBe(30000);
        expect(literals(await sayOn(callId, ext, 'sí, otra cosa'))).toEqual(['¿Qué necesitás?']);
      } finally {
        await deleteSetting(t.prisma, 'VOICEBOT_END_FALLBACK_NO_INPUT_MS');
      }
    });

    it('BE-VOZ-28: Transferir a interno: fijo o de una persona → transfer, committed, sin hangup; sin interno válido avisa y sigue', async () => {
      const tenant = await createTenant(t.prisma, { slug: uniqueSlug('voz-transfer') });
      const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Agente' });
      const agent = await createUser(t.prisma, {
        email: uniqueEmail('agente'),
        internalPhone: `5${Date.now() % 100000}`,
        memberships: [{ tenantId: tenant.id, roleId: role.id }],
      });
      const mk = async (name: string, data: Record<string, unknown>) => {
        const flow = await createFlow(t.prisma, {
          name,
          channel: 'voice',
          nodes: [
            startNode('start', { noGreeting: true }),
            node('tr', 'transfer_extension', data),
            inputNode('sigue', { text: '¿Te ayudo en otra cosa?', variableName: 'x' }),
          ],
          edges: [edge('start', 'tr'), edge('tr', 'sigue')],
          assign: [{ tenantId: tenant.id }],
        });
        const ext = extNumber();
        await t.prisma.extension.create({ data: { number: ext, name, tenantId: tenant.id, flowId: flow.id } });
        return ext;
      };

      const fixed = await start(uid(), await mk('fijo', { extension: '305', text: 'Te paso con la mesa.' }));
      expect(fixed.actions).toEqual([
        { type: 'say', mode: 'literal', text: 'Te paso con la mesa.' },
        { type: 'transfer', extension: '305' },
      ]);
      expect(fixed).toMatchObject({ committed: true, awaitInput: false });

      const person = await start(uid(), await mk('persona', { targetUserId: agent.id }));
      expect(person.actions).toEqual([{ type: 'transfer', extension: agent.internalPhone }]);

      const broken = await start(uid(), await mk('roto', { extension: '' }));
      expect(literals(broken)).toEqual(['No pude transferirte en este momento.', '¿Te ayudo en otra cosa?']);
      expect(broken).toMatchObject({ awaitInput: true });
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
