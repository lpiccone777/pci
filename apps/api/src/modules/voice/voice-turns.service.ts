import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { BrokerMessage, BrokerService } from '../broker/broker.service';
import { ConversationsService } from '../conversations/conversations.service';
import { FlowService } from '../flow/flow.service';
import {
  CallEndedEvent,
  CallStartedEvent,
  VOICE_EVENTS_QUEUE,
  VOICE_TURN_QUEUE,
  VOICE_TURN_REPLY_PATTERN,
  VoiceCallInfo,
  VoiceHeard,
  VoiceTurnError,
  VoiceTurnReply,
  VoiceTurnRequest,
} from './voice.types';
import { DELEGATED_PLACEHOLDER } from './voice-literals';
import { VoiceOutboundService } from './voice-outbound.service';
import { CallOutboundResult, OUTBOUND_CALL_ID_PREFIX } from './voice-outbound.types';
import { isShortNegative } from './voice-menu.util';
import { AppConfigService } from '../../config/app-config.service';
import type { VoiceAction } from '../conversations/conversations.service';

/** Vencimiento del lease del turno: si el proceso que lo tomó se cae, otro lo retoma. */
const TURN_LEASE_MS = 15_000;
/** Cuánto espera un turno a que se libere el de la misma llamada antes de responder `busy`. */
const TURN_LEASE_WAIT_MS = 10_000;
const TURN_LEASE_RETRY_MS = 25;


/** Estado de "después del ¿Algo más…?" [C64], en `flowState.__endFallback` con el flujo cerrado. */
interface EndFallbackState {
  menu: { flowId: string; nodeId: string } | null;
  state: Record<string, unknown>;
}

type VoiceCallWithConversation = Prisma.VoiceCallGetPayload<{ include: { conversation: true } }>;

/**
 * Canal de voz de pci (contrato de integración §5): consume `voice.events` y el RPC
 * `voice.turn` del voicebot y los corre contra el motor de flujos (`ConversationsService`,
 * canal `voice`).
 *
 * Lo que vive acá y no en el motor:
 * - **Una conversación por llamada** (`VoiceCall`, id = `callId`), abierta por lo primero que
 *   llegue (`call.started` o `kind: "start"`), sin usuario [DA5] y con el tenant del interno.
 * - **Serialización por llamada** [C4]: cola en memoria dentro del proceso + lease en
 *   `VoiceCall` entre instancias (un `UPDATE` condicionado a que esté vencido).
 * - **Idempotencia** [C27]: un `turnId` ya procesado devuelve la respuesta guardada.
 * - **`supersedes`** [DA1]: el snapshot de antes del turno se restaura si no fue `committed`.
 * - **`previous`/`lastSpoken`**: el mensaje del bot se reemplaza por lo que se oyó.
 * - **Siempre responde** [C7]: ante una falla, `error` con `actions: []`.
 */
@Injectable()
export class VoiceTurnsService implements OnModuleInit {
  private readonly logger = new Logger(VoiceTurnsService.name);
  /** Último trabajo encolado por llamada (serialización dentro del proceso). */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly broker: BrokerService,
    private readonly conversations: ConversationsService,
    private readonly flows: FlowService,
    private readonly outbound: VoiceOutboundService,
    private readonly appConfig: AppConfigService,
  ) {}

  async onModuleInit() {
    await this.broker.subscribe(VOICE_TURN_QUEUE, (msg) => this.handleTurnMessage(msg));
    await this.broker.subscribe(VOICE_EVENTS_QUEUE, (msg) => this.handleEventMessage(msg));
    this.logger.log(`Subscribed to ${VOICE_TURN_QUEUE} and ${VOICE_EVENTS_QUEUE}`);
  }

  // --- RPC voice.turn ---

  private async handleTurnMessage(msg: BrokerMessage) {
    const startedAt = Date.now();
    const req = (msg.data ?? {}) as VoiceTurnRequest;
    const turnId = typeof req.turnId === 'string' ? req.turnId : '';
    let reply: VoiceTurnReply;
    try {
      this.assertValidTurn(req);
      reply = await this.serialize(req.callId, () => this.processTurn(req, startedAt));
    } catch (err) {
      const code = err instanceof VoiceTurnError ? err.code : 'internal';
      const level = err instanceof VoiceTurnError ? 'warn' : 'error';
      this.logger[level](
        `[voz] turno ${turnId || '?'} de ${req.callId ?? '?'}: ${code} (${err instanceof Error ? err.message : err})`,
      );
      reply = { v: 1, turnId, actions: [], awaitInput: true, committed: false, superseded: false, error: code };
    }

    this.logger.log(
      `[voz] turno ${turnId} (${req.kind}) de ${req.callId}: ${Date.now() - startedAt} ms` +
        (reply.error ? ` · error ${reply.error}` : ''),
    );
    if (!msg.replyTo) {
      this.logger.warn(`[voz] voice.turn ${turnId} sin replyTo: no hay a dónde responder.`);
      return;
    }
    // La cola de respuesta es del voicebot y exclusiva: no se reafirma [C35].
    await this.broker.publish(
      msg.replyTo,
      {
        pattern: VOICE_TURN_REPLY_PATTERN,
        data: reply,
        correlationId: msg.correlationId,
        timestamp: new Date().toISOString(),
      },
      { assert: false },
    );
  }

  private assertValidTurn(req: VoiceTurnRequest) {
    const ok =
      typeof req.callId === 'string' &&
      !!req.callId &&
      typeof req.turnId === 'string' &&
      !!req.turnId &&
      ['start', 'user', 'continue', 'no_input'].includes(req.kind);
    if (!ok) throw new VoiceTurnError('invalid_request', 'faltan callId, turnId o un kind válido');
    // Una saliente de pci (`out-*`) llega con `extension: null` [C63]: la resuelve su intento.
    if (req.kind === 'start' && !req.call?.extension && !req.callId.startsWith(OUTBOUND_CALL_ID_PREFIX)) {
      throw new VoiceTurnError('invalid_request', 'kind "start" sin call.extension');
    }
    if (req.dtmf != null && req.dtmf !== '' && !/^[0-9*#]$/.test(req.dtmf)) {
      throw new VoiceTurnError('invalid_request', 'dtmf tiene que ser una tecla: 0-9, * o #');
    }
  }

  private async processTurn(req: VoiceTurnRequest, startedAt: number): Promise<VoiceTurnReply> {
    const call = await this.ensureCall(req.callId, req.call);
    return this.withLease(call.id, async () => {
      // Idempotencia [C27]: mismo turnId → misma respuesta, sin volver a correr el flujo.
      const done = await this.prisma.voiceTurn.findUnique({ where: { id: req.turnId } });
      if (done?.response) return done.response as unknown as VoiceTurnReply;

      // Un `start` repetido para una llamada que ya tuvo start [C59] no es entrada del usuario:
      // se ignora, se responde lo mismo que al primero (con el turnId nuevo) y se loguea. Pasó con
      // un voicebot reiniciado a mitad de llamada que reatendió el mismo room.
      if (req.kind === 'start') {
        const first = await this.prisma.voiceTurn.findFirst({
          where: { callId: call.id, kind: 'start', superseded: false },
          orderBy: { createdAt: 'asc' },
        });
        if (first?.response) {
          this.logger.warn(
            `[voz] llamada ${call.id}: start repetido (turno ${req.turnId}, el primero fue ${first.id}); se ignora y se repite la respuesta del primero.`,
          );
          const reply = { ...(first.response as unknown as VoiceTurnReply), turnId: req.turnId, superseded: false };
          await this.prisma.voiceTurn.create({
            data: {
              id: req.turnId,
              callId: call.id,
              kind: 'start',
              response: reply as unknown as Prisma.InputJsonValue,
              committed: false,
              durationMs: Date.now() - startedAt,
            },
          });
          return reply;
        }
      }

      if (req.previous?.turnId) await this.applyHeard(req.previous);

      let superseded = false;
      if (req.supersedes) superseded = await this.restoreSuperseded(call.id, req.supersedes);

      let conversation = await this.prisma.conversation.findUniqueOrThrow({ where: { id: call.conversationId } });
      if (conversation.status !== 'active') {
        // El flujo terminó a mitad de llamada (fin de flujo sin `end`): la llamada sigue, así
        // que la conversación se reabre y el próximo tramo arranca de nuevo por el interno.
        conversation = await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { status: 'active', closedAt: null },
        });
      }
      // Copia profunda YA: el motor muta `flowState` en el lugar mientras corre el tramo.
      const snapshot = JSON.parse(
        JSON.stringify({
          currentFlowId: conversation.currentFlowId,
          currentNodeId: conversation.currentNodeId,
          flowState: conversation.flowState,
        }),
      ) as Prisma.InputJsonValue;

      const text = req.kind === 'user' ? (req.text ?? '').trim() : '';
      // Tecla [C57]: cuenta como si la persona hubiera dicho ese dígito (se suma al texto) y el
      // menú la usa antes que el reconocimiento por voz. En la conversación queda legible.
      const dtmf = req.kind === 'user' && req.dtmf ? req.dtmf : null;
      const heardInput = [text, dtmf].filter(Boolean).join(' ');
      const userContent = [text, dtmf ? `[tecla ${dtmf}]` : ''].filter(Boolean).join(' ');
      const userMessage = userContent
        ? await this.prisma.message.create({
            data: { conversationId: conversation.id, senderType: 'user', content: userContent },
          })
        : null;

      // Después del "¿Algo más…?" [C64]: silencio o negativa → despedida y corte; otra respuesta →
      // el último menú mostrado o el flujo de nuevo sin el saludo.
      const fallback = (conversation.flowState as { __endFallback?: EndFallbackState } | null)?.__endFallback;
      // Un `no_input` solo llega después del fallback (es el único que manda `noInputMs`); si llegara
      // otro, se despide igual: no hay nada que responderle.
      if (req.kind === 'no_input' || (fallback && !conversation.currentFlowId && isShortNegative(heardInput))) {
        return this.finishTurn(call, req, startedAt, conversation.id, snapshot, userMessage?.id ?? null, superseded, {
          actions: [{ type: 'say', mode: 'literal', text: await this.fallbackText('goodbye') }, { type: 'hangup' }],
          committed: true,
          ended: true,
        });
      }
      let resumeFlow: { id: string; nodes: unknown } | null = null; // rearranque sin saludo [C64]
      if (fallback && !conversation.currentFlowId && req.kind === 'user') {
        if (fallback.menu) {
          conversation = await this.prisma.conversation.update({
            where: { id: conversation.id },
            data: {
              currentFlowId: fallback.menu.flowId,
              currentNodeId: fallback.menu.nodeId,
              flowState: { ...(fallback.state ?? {}), __awaiting: fallback.menu.nodeId } as Prisma.InputJsonValue,
            },
          });
        } else {
          const flow = await this.resolveCallFlow(call);
          resumeFlow = flow;
        }
      }

      // Sin posición: flujo de la llamada por el interno [DA8]. Sin flujo → charla libre.
      const startFlow =
        resumeFlow ??
        (conversation.currentFlowId || req.kind === 'continue' ? null : await this.resolveCallFlow(call));
      const output = await this.conversations.runVoiceFlow(
        conversation,
        call.tenantId,
        heardInput,
        // El número del otro lado: en una saliente es el marcado [C63].
        call.direction === 'outbound' ? call.calledNumber : call.callerNumber,
        startFlow ?? undefined,
        dtmf,
        { skipGreeting: !!resumeFlow },
      );
      let flowOutput: { actions: VoiceAction[]; committed: boolean; ended: boolean } = output ?? {
        actions: [{ type: 'say' as const, mode: 'delegate' as const, systemPrompt: await this.conversations.voiceFreeChatPrompt(call.tenantId) }],
        committed: false,
        ended: false,
      };

      // Siempre algo para decir [C64]: un flujo que terminó sin `end` (o cualquier tramo que no
      // dejó ningún `say`) no puede dejar al voicebot callado esperando.
      let noInputMs: number | undefined;
      if (!flowOutput.ended && !flowOutput.actions.some((a) => a.type === 'say')) {
        const before = snapshot as { currentFlowId?: string | null; currentNodeId?: string | null; flowState?: Record<string, unknown> | null };
        this.logger.warn(
          `[voz] ${call.id}: el tramo quedó sin nada para decir (flujo ${before.currentFlowId ?? '—'}, nodo ` +
            `${before.currentNodeId ?? '—'}): un nodo sin salida. Va "¿Algo más…?" [C64].`,
        );
        flowOutput = { ...flowOutput, actions: [...flowOutput.actions, { type: 'say', mode: 'literal', text: await this.fallbackText('ask') }] };
        noInputMs = await this.fallbackNoInputMs();
        await this.markEndFallback(conversation.id, before.flowState ?? null);
      }

      const literal = flowOutput.actions.flatMap((a) => (a.type === 'say' && a.mode === 'literal' ? [a.text] : []));
      const delegated = flowOutput.actions.some((a) => a.type === 'say' && a.mode !== 'literal');
      const botContent = literal.join('\n\n') || (delegated ? DELEGATED_PLACEHOLDER : '');
      const botMessage = botContent
        ? await this.prisma.message.create({
            data: { conversationId: conversation.id, senderType: 'assistant', content: botContent },
          })
        : null;

      const reply: VoiceTurnReply = {
        v: 1,
        turnId: req.turnId,
        actions: flowOutput.actions,
        awaitInput: !flowOutput.ended,
        ...(noInputMs && !flowOutput.ended ? { noInputMs } : {}),
        committed: flowOutput.committed,
        superseded,
        error: null,
      };
      await this.prisma.voiceTurn.create({
        data: {
          id: req.turnId,
          callId: call.id,
          kind: req.kind,
          text: userContent || null,
          response: reply as unknown as Prisma.InputJsonValue,
          committed: flowOutput.committed,
          snapshot,
          userMessageId: userMessage?.id ?? null,
          botMessageId: botMessage?.id ?? null,
          durationMs: Date.now() - startedAt,
        },
      });
      return reply;
    });
  }

  /** Responde un turno sin correr el flujo (despedida del fallback, C64): mensaje del bot y fila del turno. */
  private async finishTurn(
    call: { id: string },
    req: VoiceTurnRequest,
    startedAt: number,
    conversationId: string,
    snapshot: Prisma.InputJsonValue,
    userMessageId: string | null,
    superseded: boolean,
    output: { actions: VoiceAction[]; committed: boolean; ended: boolean },
  ): Promise<VoiceTurnReply> {
    const text = output.actions.flatMap((a) => (a.type === 'say' && a.mode === 'literal' ? [a.text] : [])).join('\n\n');
    const botMessage = text
      ? await this.prisma.message.create({ data: { conversationId, senderType: 'assistant', content: text } })
      : null;
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { flowState: Prisma.JsonNull } });
    const reply: VoiceTurnReply = {
      v: 1,
      turnId: req.turnId,
      actions: output.actions,
      awaitInput: !output.ended,
      committed: output.committed,
      superseded,
      error: null,
    };
    await this.prisma.voiceTurn.create({
      data: {
        id: req.turnId,
        callId: call.id,
        kind: req.kind,
        text: req.kind === 'user' ? (req.text ?? '').trim() || null : null,
        response: reply as unknown as Prisma.InputJsonValue,
        committed: output.committed,
        snapshot,
        userMessageId,
        botMessageId: botMessage?.id ?? null,
        durationMs: Date.now() - startedAt,
      },
    });
    this.logger.log(`[voz] ${call.id}: ${req.kind === 'no_input' ? 'sin respuesta' : 'negativa'} al "¿Algo más…?" → despedida y corte [C64].`);
    return reply;
  }

  /**
   * Marca la conversación como "después del ¿Algo más…?" [C64]: guarda el último menú mostrado
   * (el tope de `__menuStack` antes del tramo) y el estado del flujo, para volver ahí si contesta.
   */
  private async markEndFallback(conversationId: string, flowState: Record<string, unknown> | null) {
    const stack = Array.isArray(flowState?.__menuStack) ? (flowState!.__menuStack as Array<{ flowId: string; nodeId: string }>) : [];
    const last = stack[stack.length - 1];
    const state = flowState ? { ...flowState } : {};
    delete state.__awaiting;
    if (last) state.__menuStack = stack.slice(0, -1);
    const fallback: EndFallbackState = { menu: last ? { flowId: last.flowId, nodeId: last.nodeId } : null, state };
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { currentFlowId: null, currentNodeId: null, flowState: { __endFallback: fallback } as unknown as Prisma.InputJsonValue },
    });
  }

  private async fallbackText(which: 'ask' | 'goodbye'): Promise<string> {
    return which === 'ask'
      ? ((await this.appConfig.get('VOICEBOT_END_FALLBACK_TEXT', '¿Algo más en lo que te pueda ayudar?')) || '¿Algo más en lo que te pueda ayudar?')
      : ((await this.appConfig.get('VOICEBOT_END_FALLBACK_GOODBYE_TEXT', 'Gracias por comunicarte. ¡Hasta luego!')) ||
          'Gracias por comunicarte. ¡Hasta luego!');
  }

  /** 3000–30000 [C64]; fuera de rango, al borde. */
  private async fallbackNoInputMs(): Promise<number> {
    const ms = await this.appConfig.getNumber('VOICEBOT_END_FALLBACK_NO_INPUT_MS', 8000);
    return Math.min(30_000, Math.max(3_000, Number.isFinite(ms) ? ms : 8000));
  }

  /**
   * Flujo de la llamada por su interno [DA8+DA15]. `null` = charla libre. Loguea por qué paso
   * se resolvió (flujo del interno, flujo de voz de inicio de la empresa o charla libre): un flujo
   * asignado a otra empresa que la del interno no se toma nunca, y sin este log no se ve.
   */
  private async resolveCallFlow(call: {
    id: string;
    extensionId: string | null;
    extensionNumber: string | null;
    tenantId: string;
    outboundAttemptId?: string | null;
  }) {
    if (call.outboundAttemptId) return this.resolveOutboundFlow(call.id, call.tenantId, call.outboundAttemptId);
    const extension = call.extensionId
      ? await this.prisma.extension.findUnique({ where: { id: call.extensionId }, select: { tenantId: true, flowId: true } })
      : null;
    const flow = await this.flows.findVoiceFlowForExtension(extension ?? { tenantId: call.tenantId, flowId: null });
    const where = `[voz] llamada ${call.id} (interno ${call.extensionNumber}, empresa ${call.tenantId})`;
    const ignoredOwn = extension?.flowId && extension.flowId !== flow?.id
      ? ` El flujo del interno (${extension.flowId}) se ignoró: no es de voz, no está activo o no está asignado a esta empresa.`
      : '';
    if (!flow) {
      this.logger.log(`${where}: la empresa no tiene flujo de voz de inicio → charla libre (delegate).${ignoredOwn}`);
    } else {
      const why = extension?.flowId === flow.id ? 'el flujo del interno' : 'el flujo de voz de inicio de la empresa (o su variante)';
      this.logger.log(`${where}: flujo "${flow.name}" (${flow.id}) por ${why}.${ignoredOwn}`);
    }
    return flow;
  }

  /**
   * Saliente de pci [C63]: el flujo de la saliente, si sigue siendo un flujo de voz activo de la
   * empresa (o su variante por feriado/guardia). Si se borró o se desasignó, charla libre de esa
   * empresa, como DA8 (3). Nunca el flujo de inicio ni uno de otra empresa.
   */
  private async resolveOutboundFlow(callId: string, tenantId: string, attemptId: string) {
    const attempt = await this.prisma.voiceOutboundAttempt.findUnique({
      where: { id: attemptId },
      select: { outbound: { select: { id: true, flowId: true } } },
    });
    const flowId = attempt?.outbound.flowId ?? null;
    const where = `[voz] saliente ${callId} (${attempt?.outbound.id ?? '?'}, empresa ${tenantId})`;
    if (!flowId) {
      this.logger.log(`${where}: sin flujo → charla libre (delegate).`);
      return null;
    }
    const flow = await this.flows.findVoiceFlowForExtension({ tenantId, flowId });
    const ok =
      !!flow &&
      (flow.id === flowId ||
        !!(await this.prisma.flowAlternative.findFirst({ where: { baseFlowId: flowId, variantFlowId: flow.id } })));
    if (!ok) {
      this.logger.warn(`${where}: el flujo ${flowId} ya no es un flujo de voz activo de la empresa → charla libre (delegate).`);
      return null;
    }
    this.logger.log(`${where}: flujo "${flow!.name}" (${flow!.id}) de la saliente.`);
    return flow;
  }

  /**
   * `supersedes` [DA1]: si el turno reemplazado no tuvo efectos, se vuelve al estado de antes de
   * él y se borran sus mensajes (nunca se dijo). Si los tuvo, se ignora y se procesa encima.
   */
  private async restoreSuperseded(callId: string, supersededTurnId: string): Promise<boolean> {
    const old = await this.prisma.voiceTurn.findUnique({ where: { id: supersededTurnId } });
    if (!old || old.callId !== callId || old.committed || old.superseded) return false;

    const snapshot = (old.snapshot ?? {}) as {
      currentFlowId?: string | null;
      currentNodeId?: string | null;
      flowState?: Prisma.InputJsonValue | null;
    };
    const call = await this.prisma.voiceCall.findUniqueOrThrow({ where: { id: callId } });
    const messageIds = [old.userMessageId, old.botMessageId].filter((id): id is string => !!id);
    await this.prisma.$transaction([
      this.prisma.conversation.update({
        where: { id: call.conversationId },
        data: {
          status: 'active',
          closedAt: null,
          currentFlowId: snapshot.currentFlowId ?? null,
          currentNodeId: snapshot.currentNodeId ?? null,
          flowState: snapshot.flowState ?? Prisma.JsonNull,
        },
      }),
      this.prisma.message.deleteMany({ where: { id: { in: messageIds } } }),
      this.prisma.voiceTurn.update({ where: { id: old.id }, data: { superseded: true } }),
    ]);
    return true;
  }

  /** El mensaje del bot de ese turno pasa a ser lo que el usuario oyó (o se borra si nada). */
  private async applyHeard(heard: VoiceHeard) {
    const turn = await this.prisma.voiceTurn.findUnique({ where: { id: heard.turnId }, select: { botMessageId: true } });
    if (!turn?.botMessageId) return;
    const heardText = (heard.heardText ?? '').trim();
    if (heardText) {
      await this.prisma.message.updateMany({ where: { id: turn.botMessageId }, data: { content: heardText } });
    } else {
      await this.prisma.message.deleteMany({ where: { id: turn.botMessageId } });
    }
  }

  // --- voice.events ---

  private async handleEventMessage(msg: BrokerMessage) {
    try {
      if (msg.pattern === 'call.started') {
        const event = (msg.data ?? {}) as CallStartedEvent;
        if (!event.callId) throw new VoiceTurnError('invalid_request', 'call.started sin callId');
        await this.serialize(event.callId, () => this.onCallStarted(event));
      } else if (msg.pattern === 'call.ended') {
        const event = (msg.data ?? {}) as CallEndedEvent;
        if (!event.callId) throw new VoiceTurnError('invalid_request', 'call.ended sin callId');
        await this.serialize(event.callId, () => this.onCallEnded(event));
      } else if (msg.pattern === 'call.outbound.result') {
        const event = (msg.data ?? {}) as CallOutboundResult;
        if (!event.callId) throw new VoiceTurnError('invalid_request', 'call.outbound.result sin callId');
        await this.outbound.handleResult(event);
      } else {
        this.logger.debug(`[voz] evento ${msg.pattern} sin consumidor`);
      }
    } catch (err) {
      // Un evento que no se puede procesar no se reintenta: se loguea y se descarta.
      this.logger.warn(`[voz] evento ${msg.pattern} descartado: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Abre la llamada si no existe y registra la entrada real (`startedAt`) [C48]. */
  private async onCallStarted(event: CallStartedEvent) {
    const call = await this.ensureCall(event.callId, event, event.startedAt);
    const startedAt = event.startedAt ? new Date(event.startedAt) : null;
    await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: {
        ...(startedAt && !Number.isNaN(startedAt.getTime()) && { startedAt }),
        calledNumber: call.calledNumber ?? event.calledNumber ?? null,
        callerNumber: call.callerNumber ?? event.callerNumber ?? null,
        ...(event.direction && { direction: event.direction }),
      },
    });
  }

  private async onCallEnded(event: CallEndedEvent) {
    const call = await this.prisma.voiceCall.findUnique({ where: { id: event.callId } });
    if (!call) {
      this.logger.warn(`[voz] call.ended de ${event.callId}: la llamada no se abrió en pci, se ignora.`);
      return;
    }
    await this.withLease(call.id, async () => {
      if (event.lastSpoken?.turnId) await this.applyHeard(event.lastSpoken);
      const endedAt = event.endedAt ? new Date(event.endedAt) : new Date();
      await this.prisma.$transaction([
        this.prisma.voiceCall.update({
          where: { id: call.id },
          data: {
            endedAt: Number.isNaN(endedAt.getTime()) ? new Date() : endedAt,
            endReason: event.reason ?? null,
            lastSpoken: event.lastSpoken ? (event.lastSpoken as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          },
        }),
        // Una conversación de voz no se retoma: la próxima llamada abre otra.
        this.prisma.conversation.update({
          where: { id: call.conversationId },
          data: {
            status: 'closed',
            closedAt: new Date(),
            currentFlowId: null,
            currentNodeId: null,
            flowState: Prisma.JsonNull,
          },
        }),
      ]);
    });
  }

  // --- llamada, serialización y lease ---

  /**
   * Saliente de pci [C63]: `extension` null; la empresa sale de la saliente (la activa de quien la
   * lanzó), no de un interno. Arranca sin usuario, como una entrante [DA5]. Un `out-*` que pci no
   * lanzó no abre nada (`unknown_call`): el voicebot corta.
   */
  private async openOutboundCall(
    callId: string,
    info: VoiceCallInfo | undefined,
    startedAt?: string,
  ): Promise<VoiceCallWithConversation> {
    const attempt = await this.prisma.voiceOutboundAttempt.findUnique({
      where: { id: callId },
      include: { outbound: { include: { tenant: { select: { deletedAt: true } } } } },
    });
    if (!attempt) throw new VoiceTurnError('unknown_call', `la saliente ${callId} no la lanzó pci`);
    const { outbound } = attempt;
    if (outbound.tenant.deletedAt) {
      throw new VoiceTurnError('tenant_unavailable', `la empresa de la saliente ${callId} está dada de baja`);
    }
    const start = startedAt ? new Date(startedAt) : new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.create({
          data: { userId: null, tenantId: outbound.tenantId, channel: 'voice', externalId: callId, sessionStartedAt: new Date() },
        });
        return tx.voiceCall.create({
          data: {
            id: callId,
            conversationId: conversation.id,
            tenantId: outbound.tenantId,
            extensionId: null,
            extensionNumber: null,
            // En una saliente el remoto es `calledNumber` [C63]; `callerNumber`, el del trunk.
            calledNumber: info?.calledNumber ?? attempt.to ?? null,
            callerNumber: info?.callerNumber || null,
            direction: 'outbound',
            outboundAttemptId: attempt.id,
            startedAt: Number.isNaN(start.getTime()) ? new Date() : start,
          },
          include: { conversation: true },
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.voiceCall.findUniqueOrThrow({ where: { id: callId }, include: { conversation: true } });
      }
      throw err;
    }
  }

  /**
   * La llamada y su conversación, creadas por lo primero que llegue (`call.started` o el turno
   * `start`), sin depender del orden [§5.2]. El tenant sale del interno [DA5]; sin interno
   * habilitado no hay llamada [C45].
   */
  private async ensureCall(
    callId: string,
    info: VoiceCallInfo | undefined,
    startedAt?: string,
  ): Promise<VoiceCallWithConversation> {
    const found = await this.prisma.voiceCall.findUnique({ where: { id: callId }, include: { conversation: true } });
    if (found) return found;
    if (callId.startsWith(OUTBOUND_CALL_ID_PREFIX)) return this.openOutboundCall(callId, info, startedAt);
    if (!info?.extension) throw new VoiceTurnError('unknown_call', `la llamada ${callId} no se abrió en pci`);

    const extension = await this.prisma.extension.findUnique({
      where: { number: String(info.extension).trim() },
      include: { tenant: { select: { deletedAt: true } } },
    });
    if (!extension || !extension.enabled) {
      throw new VoiceTurnError('unknown_extension', `el interno ${info.extension} no existe o está deshabilitado`);
    }
    if (extension.tenant.deletedAt) {
      throw new VoiceTurnError('tenant_unavailable', `la empresa del interno ${info.extension} está dada de baja`);
    }

    const start = startedAt ? new Date(startedAt) : new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.create({
          data: {
            userId: null,
            tenantId: extension.tenantId,
            channel: 'voice',
            externalId: callId,
            sessionStartedAt: new Date(),
          },
        });
        return tx.voiceCall.create({
          data: {
            id: callId,
            conversationId: conversation.id,
            tenantId: extension.tenantId,
            extensionId: extension.id,
            extensionNumber: extension.number,
            calledNumber: info.calledNumber ?? null,
            callerNumber: info.callerNumber ?? null,
            direction: info.direction ?? 'inbound',
            startedAt: Number.isNaN(start.getTime()) ? new Date() : start,
          },
          include: { conversation: true },
        });
      });
    } catch (err) {
      // Otra instancia la abrió entre el findUnique y el create: se usa esa.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.voiceCall.findUniqueOrThrow({ where: { id: callId }, include: { conversation: true } });
      }
      throw err;
    }
  }

  /** De a uno por llamada dentro de este proceso. */
  private serialize<T>(callId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(callId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.chains.set(callId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.chains.get(callId) === next) this.chains.delete(callId);
      });
    return next;
  }

  /**
   * De a uno por llamada entre instancias [C4]: lease en `VoiceCall`, tomado con un UPDATE
   * atómico condicionado a que esté libre o vencido. Se libera solo si sigue siendo propio.
   */
  private async withLease<T>(callId: string, work: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + TURN_LEASE_WAIT_MS;
    for (;;) {
      const now = new Date();
      const { count } = await this.prisma.voiceCall.updateMany({
        where: { id: callId, OR: [{ turnLockUntil: null }, { turnLockUntil: { lt: now } }] },
        data: { turnLockToken: token, turnLockUntil: new Date(now.getTime() + TURN_LEASE_MS) },
      });
      if (count) break;
      if (Date.now() > deadline) throw new VoiceTurnError('busy', `la llamada ${callId} tiene otro turno en curso`);
      await new Promise((r) => setTimeout(r, TURN_LEASE_RETRY_MS));
    }
    try {
      return await work();
    } finally {
      await this.prisma.voiceCall
        .updateMany({ where: { id: callId, turnLockToken: token }, data: { turnLockToken: null, turnLockUntil: null } })
        .catch((err) => this.logger.error(`[voz] no se pudo liberar el lease de ${callId}: ${err}`));
    }
  }
}
