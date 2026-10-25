import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService } from '../broker/broker.service';
import { FlowService } from '../flow/flow.service';
import { CreateVoiceOutboundDto } from './dto/voice-outbound.dto';
import {
  CallOutboundCommand,
  CallOutboundResult,
  OUTBOUND_CALL_ID_PREFIX,
  VOICEBOT_COMMANDS_QUEUE,
} from './voice-outbound.types';

/** Espera de la respuesta RPC de `call.outbound` / `call.hangup`: sale antes de discar. */
const COMMAND_TIMEOUT_MS = 10_000;
/** Lease de una saliente mientras se publica su intento (dos instancias no publican el mismo). */
const DISPATCH_LEASE_MS = 30_000;
/** Un intento sin `call.outbound.result` después de esto se da por perdido y se reintenta. */
const ATTEMPT_STALE_MS = 10 * 60_000;
/** Tope de reintentos sin ronda (`busy` o el voicebot sin responder): después, `failed`. */
const MAX_UNCOUNTED_RETRIES = 20;
/** Salientes que publica cada barrido. */
const SWEEP_BATCH = 20;

/** Lo que se muestra de una saliente: sin datos de otras empresas, con sus intentos. */
const OUTBOUND_INCLUDE = {
  attempts: { orderBy: { createdAt: 'desc' as const } },
  flow: { select: { id: true, name: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
};

/**
 * Salientes desde pci (H5, contrato §6, C34, C63). Una `VoiceOutbound` es la saliente lógica con
 * su lista de números; cada `call.outbound` publicado en `voicebot.commands` es un
 * `VoiceOutboundAttempt` (`callId` = `out-<uuid>`, generado acá). Un intento por vez: el siguiente
 * sale recién con el `call.outbound.result` del anterior, después de `retryDelayMs`. El barrido
 * (cada 10 s) publica los vencidos, así un reinicio de pci no pierde reintentos.
 */
@Injectable()
export class VoiceOutboundService {
  private readonly logger = new Logger(VoiceOutboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly broker: BrokerService,
    private readonly flows: FlowService,
  ) {}

  async create(tenantId: string, userId: string, dto: CreateVoiceOutboundDto) {
    if (!dto.flowId && !dto.audioUrl) {
      throw new BadRequestException('Indicá un flujo de voz (flowId) o un audio (audioUrl).');
    }
    if (dto.flowId && (dto.audioUrl || dto.digits)) {
      throw new BadRequestException('Con un flujo de voz no van audioUrl ni digits.');
    }
    const to = await this.allowedNumbers(dto.to);

    if (dto.flowId) {
      // Solo un flujo de voz activo y asignado a la empresa activa: nunca uno de otra.
      const flow = await this.flows.findVoiceFlowForExtension({ tenantId, flowId: dto.flowId });
      if (!flow || (flow.id !== dto.flowId && !(await this.isVariantOf(flow.id, dto.flowId)))) {
        throw new BadRequestException('El flujo no es un flujo de voz activo de esta empresa.');
      }
    }

    const [retryDelayMs, defaultRounds] = await Promise.all([
      this.appConfig.getNumber('VOICEBOT_OUTBOUND_RETRY_DELAY_MS', 60_000),
      this.appConfig.getNumber('VOICEBOT_CALL_MAX_ROUNDS', 3),
    ]);
    const outbound = await this.prisma.voiceOutbound.create({
      data: {
        tenantId,
        createdById: userId,
        mode: dto.flowId ? 'flow' : 'audio',
        flowId: dto.flowId ?? null,
        to,
        audioUrl: dto.audioUrl ?? null,
        digits: dto.digits ?? null,
        maxRounds: dto.maxRounds ?? defaultRounds,
        retryDelayMs,
        status: 'pending',
        nextAttemptAt: new Date(),
      },
    });
    this.logger.log(
      `[saliente] ${outbound.id} creada por ${userId} en ${tenantId}: ${to.length} número(s), modo ${outbound.mode}.`,
    );
    await this.dispatch(outbound.id);
    return this.findOne(tenantId, outbound.id);
  }

  findAll(tenantId: string) {
    return this.prisma.voiceOutbound.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: OUTBOUND_INCLUDE,
    });
  }

  flowOptions(tenantId: string) {
    return this.prisma.flow.findMany({
      where: { channel: 'voice', isActive: true, tenantFlows: { some: { tenantId } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(tenantId: string, id: string) {
    const outbound = await this.prisma.voiceOutbound.findFirst({ where: { id, tenantId }, include: OUTBOUND_INCLUDE });
    if (!outbound) throw new NotFoundException('La saliente no existe en esta empresa.');
    return outbound;
  }

  /** Cancela los reintentos; si hay un intento en curso, le pide al voicebot que corte. */
  async cancel(tenantId: string, id: string) {
    const outbound = await this.findOne(tenantId, id);
    if (['done', 'failed', 'cancelled'].includes(outbound.status)) return outbound;
    await this.prisma.voiceOutbound.update({ where: { id }, data: { status: 'cancelled', nextAttemptAt: null } });
    const pending = outbound.attempts.find((a) => !a.resultAt);
    if (pending) {
      const reply = await this.broker
        .request(
          VOICEBOT_COMMANDS_QUEUE,
          { pattern: 'call.hangup', data: { v: 1, callId: pending.id, resetRotation: true }, tenantId },
          { timeoutMs: COMMAND_TIMEOUT_MS },
        )
        .catch((err) => {
          this.logger.warn(`[saliente] ${id}: call.hangup de ${pending.id} sin respuesta (${err instanceof Error ? err.message : err}).`);
          return null;
        });
      if (reply) this.logger.log(`[saliente] ${id} cancelada; call.hangup de ${pending.id}: ${JSON.stringify(reply.data)}`);
    } else {
      this.logger.log(`[saliente] ${id} cancelada.`);
    }
    return this.findOne(tenantId, id);
  }

  /**
   * `call.outbound.result` [§6]: cierra el intento y decide si la saliente sigue.
   * - Con flujo: `answered` termina bien. Sin flujo: `digit`.
   * - `exhausted` termina sin éxito. `busy` reintenta sin contar ronda.
   * - El resto (`no-answer`, `no-digit`, `hangup`) reintenta hasta `lastAttempt`.
   */
  async handleResult(result: CallOutboundResult) {
    const attempt = await this.prisma.voiceOutboundAttempt.findUnique({
      where: { id: result.callId },
      include: { outbound: true },
    });
    if (!attempt) {
      this.logger.warn(`[saliente] call.outbound.result de ${result.callId}: no es una saliente de pci, se ignora.`);
      return;
    }
    if (attempt.resultAt) {
      this.logger.debug(`[saliente] call.outbound.result repetido de ${result.callId}, se ignora.`);
      return;
    }
    await this.prisma.voiceOutboundAttempt.update({
      where: { id: attempt.id },
      data: {
        outcome: result.outcome,
        answered: !!result.answered,
        digit: result.digit ?? null,
        to: result.to ?? attempt.to,
        round: result.round ?? null,
        lastAttempt: !!result.lastAttempt,
        resultAt: new Date(),
      },
    });

    const outbound = attempt.outbound;
    const where = `[saliente] ${outbound.id} (${attempt.id})`;
    if (outbound.status === 'cancelled') {
      this.logger.log(`${where}: ${result.outcome} con la saliente ya cancelada.`);
      return;
    }
    const succeeded = outbound.mode === 'flow' ? result.outcome === 'answered' || !!result.answered : result.outcome === 'digit';
    if (succeeded) {
      await this.finish(outbound.id, 'done', result.outcome);
      this.logger.log(`${where}: ${result.outcome}${result.digit ? ` (${result.digit})` : ''} → terminada.`);
      return;
    }
    if (result.outcome === 'exhausted') {
      await this.finish(outbound.id, 'failed', result.outcome);
      this.logger.log(`${where}: exhausted → sin más intentos.`);
      return;
    }
    if (result.outcome === 'busy') {
      await this.retryUncounted(outbound.id, outbound.busyCount, outbound.retryDelayMs, 'busy', where);
      return;
    }
    if (result.lastAttempt) {
      await this.finish(outbound.id, 'failed', result.outcome);
      this.logger.log(`${where}: ${result.outcome} en el último intento → sin éxito.`);
      return;
    }
    await this.prisma.voiceOutbound.update({
      where: { id: outbound.id },
      data: { outcome: result.outcome, nextAttemptAt: new Date(Date.now() + outbound.retryDelayMs) },
    });
    this.logger.log(`${where}: ${result.outcome} → reintenta en ${outbound.retryDelayMs} ms.`);
  }

  /** Publica los reintentos vencidos y rescata intentos que nunca tuvieron resultado. */
  @Cron('*/10 * * * * *')
  async sweep() {
    const staleBefore = new Date(Date.now() - ATTEMPT_STALE_MS);
    const stale = await this.prisma.voiceOutboundAttempt.findMany({
      where: { resultAt: null, createdAt: { lt: staleBefore }, outbound: { status: 'calling' } },
      take: SWEEP_BATCH,
      include: { outbound: true },
    });
    for (const attempt of stale) {
      await this.prisma.voiceOutboundAttempt.update({
        where: { id: attempt.id },
        data: { outcome: 'error', resultAt: new Date() },
      });
      await this.retryUncounted(attempt.outbound.id, attempt.outbound.busyCount, attempt.outbound.retryDelayMs, 'sin resultado', `[saliente] ${attempt.outbound.id} (${attempt.id})`);
    }

    const due = await this.prisma.voiceOutbound.findMany({
      where: { status: { in: ['pending', 'calling'] }, nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: SWEEP_BATCH,
      select: { id: true },
    });
    for (const { id } of due) await this.dispatch(id);
  }

  /**
   * Publica el próximo intento de una saliente si le toca. El lease (UPDATE condicionado) evita
   * que dos barridos o instancias publiquen el mismo. Nunca tira: un error se reintenta.
   */
  async dispatch(id: string): Promise<void> {
    const now = new Date();
    const taken = await this.prisma.voiceOutbound.updateMany({
      where: {
        id,
        status: { in: ['pending', 'calling'] },
        nextAttemptAt: { lte: now },
        OR: [{ lockUntil: null }, { lockUntil: { lt: now } }],
      },
      data: { lockUntil: new Date(now.getTime() + DISPATCH_LEASE_MS) },
    });
    if (taken.count === 0) return;

    const outbound = await this.prisma.voiceOutbound.findUniqueOrThrow({ where: { id }, include: { attempts: { where: { resultAt: null } } } });
    const where = `[saliente] ${id}`;
    try {
      // Un intento a la vez: si hay uno sin resultado, se espera su `call.outbound.result`.
      if (outbound.attempts.length) {
        await this.prisma.voiceOutbound.update({ where: { id }, data: { nextAttemptAt: null, lockUntil: null } });
        return;
      }
      const callId = `${OUTBOUND_CALL_ID_PREFIX}${randomUUID()}`;
      await this.prisma.voiceOutboundAttempt.create({ data: { id: callId, outboundId: id } });
      const command: CallOutboundCommand = {
        v: 1,
        callId,
        to: outbound.to,
        ...(outbound.flowId ? { flowId: outbound.flowId } : {}),
        ...(outbound.audioUrl ? { audioUrl: outbound.audioUrl } : {}),
        ...(outbound.digits ? { digits: outbound.digits } : {}),
        maxRounds: outbound.maxRounds,
        rotationKey: outbound.id,
        resetRotation: outbound.attemptsCount === 0,
      };
      await this.prisma.voiceOutbound.update({
        where: { id },
        data: { status: 'calling', attemptsCount: { increment: 1 }, nextAttemptAt: null },
      });
      const reply = await this.broker
        .request(VOICEBOT_COMMANDS_QUEUE, { pattern: 'call.outbound', data: command, tenantId: outbound.tenantId }, { timeoutMs: COMMAND_TIMEOUT_MS })
        .catch((err) => ({ data: { error: err instanceof Error ? err.message : String(err) } }));
      const data = (reply.data ?? {}) as { callId?: string; error?: unknown };
      if (data.error || data.callId !== callId) {
        const why = data.error ? String(typeof data.error === 'object' ? JSON.stringify(data.error) : data.error) : `callId ${data.callId}`;
        await this.prisma.voiceOutboundAttempt.update({ where: { id: callId }, data: { outcome: 'error', resultAt: new Date() } });
        this.logger.warn(`${where}: call.outbound ${callId} no se aceptó (${why}).`);
        await this.retryUncounted(id, outbound.busyCount, outbound.retryDelayMs, 'error del voicebot', where);
        return;
      }
      this.logger.log(`${where}: call.outbound ${callId} publicado (intento ${outbound.attemptsCount + 1}).`);
    } catch (err) {
      this.logger.error(`${where}: no se pudo publicar el intento — ${err instanceof Error ? err.message : err}`);
      await this.retryUncounted(id, outbound.busyCount, outbound.retryDelayMs, 'error interno', where);
    } finally {
      await this.prisma.voiceOutbound.update({ where: { id }, data: { lockUntil: null } }).catch(() => undefined);
    }
  }

  /** Reintento que no cuenta ronda (`busy`, voicebot sin responder): con tope, después `failed`. */
  private async retryUncounted(id: string, busyCount: number, retryDelayMs: number, why: string, where: string) {
    if (busyCount + 1 > MAX_UNCOUNTED_RETRIES) {
      await this.finish(id, 'failed', why === 'busy' ? 'busy' : 'error');
      this.logger.warn(`${where}: ${why} por ${MAX_UNCOUNTED_RETRIES}ª vez → sin más intentos.`);
      return;
    }
    await this.prisma.voiceOutbound.update({
      where: { id },
      data: {
        busyCount: { increment: 1 },
        outcome: why === 'busy' ? 'busy' : 'error',
        nextAttemptAt: new Date(Date.now() + retryDelayMs),
      },
    });
    this.logger.log(`${where}: ${why} → reintenta en ${retryDelayMs} ms sin contar ronda.`);
  }

  private finish(id: string, status: 'done' | 'failed', outcome: string) {
    return this.prisma.voiceOutbound.update({ where: { id }, data: { status, outcome, nextAttemptAt: null } });
  }

  /** Un flujo con variante por feriado/guardia: `findVoiceFlowForExtension` devuelve la variante. */
  private async isVariantOf(variantId: string, baseId: string): Promise<boolean> {
    return !!(await this.prisma.flowAlternative.findFirst({ where: { baseFlowId: baseId, variantFlowId: variantId } }));
  }

  /**
   * Números limpios y permitidos por `VOICEBOT_OUTBOUND_ALLOWED_PREFIXES` (C63): vacía = cerrado.
   * Un número se acepta si empieza con alguno de los prefijos.
   */
  private async allowedNumbers(raw: string[]): Promise<string[]> {
    const prefixes = ((await this.appConfig.get('VOICEBOT_OUTBOUND_ALLOWED_PREFIXES', '')) ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!prefixes.length) {
      throw new ForbiddenException(
        'Las llamadas salientes están cerradas: no hay números permitidos (VOICEBOT_OUTBOUND_ALLOWED_PREFIXES).',
      );
    }
    const numbers = raw.map((n) => String(n).replace(/[\s\-().]/g, ''));
    const invalid = numbers.filter((n) => !/^\+?[0-9*#]{2,32}$/.test(n));
    if (invalid.length) throw new BadRequestException(`Números inválidos: ${invalid.join(', ')}`);
    const blocked = numbers.filter((n) => !prefixes.some((p) => n.startsWith(p)));
    if (blocked.length) {
      throw new ForbiddenException(`Números no permitidos para salientes: ${blocked.join(', ')}`);
    }
    return [...new Set(numbers)];
  }
}
