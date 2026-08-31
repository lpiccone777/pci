import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { WhatsAppInteractive } from '../whatsapp/whatsapp-interactive.types';
import { StoredAttachment } from '../../common/twilio-media.service';

/**
 * Ventana de validez del estado pendiente de selección de empresa: 12hs, igual que
 * RESUME_WINDOW_MS en ConversationsService. Pasada la ventana, el pendiente se descarta y
 * el próximo mensaje resuelve de cero (y vuelve a preguntar si sigue habiendo varias empresas).
 */
const SELECTION_TTL_MS = 12 * 60 * 60 * 1000;

/** Opción ofrecida en el selector de empresa, guardada en `PendingTenantSelection.options`. */
interface TenantOption {
  index: number;
  tenantId: string;
  name: string;
}

/**
 * Resultado del ruteo: o se resolvió el tenant (con `replayBody` = el mensaje a reprocesar,
 * si venía de responder el selector), o hay que preguntarle al usuario con qué empresa quiere
 * hablar (`body` + `interactive` opcional para WhatsApp).
 */
export type InboundRoutingResult =
  | { status: 'resolved'; tenantId: string; replayBody?: string; replayAttachments?: StoredAttachment[] }
  | { status: 'ask'; body: string; interactive?: WhatsAppInteractive }
  /** Aviso al usuario (cambio administrativo que altera el ruteo): se manda `body` y se corta. */
  | { status: 'notice'; body: string }
  /** No hay empresa que pueda atender el mensaje: se descarta en silencio (solo log de operador). */
  | { status: 'ignored' };

/**
 * Decide qué empresa (tenant) atiende un mensaje ENTRANTE de canal, a partir de la membresía
 * del teléfono. Orden de decisión:
 *   1. ¿Hay una selección pendiente para este teléfono+canal? → este mensaje es la respuesta.
 *   2. Sin ninguna membresía → no hablamos con desconocidos (pedido 2026-08-27): se ignora acá
 *      mismo, antes de tocar nada más.
 *   3. ¿Hay una conversación en curso todavía ruteable? → esa (si un cambio administrativo la
 *      dejó fuera del ruteo, se cierra y se avisa — status 'notice').
 *   4. Según cantidad de membresías: 1 → directo; ≥2 → preguntar.
 */
@Injectable()
export class InboundTenantRoutingService {
  private readonly logger = new Logger(InboundTenantRoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  async resolve(
    from: string,
    channel: string,
    body: string,
    attachments: StoredAttachment[] = [],
  ): Promise<InboundRoutingResult> {
    // 1. Selección pendiente: este mensaje es la respuesta a "¿con qué empresa?".
    const pending = await this.prisma.pendingTenantSelection.findUnique({
      where: { phone_channel: { phone: from, channel } },
    });
    if (pending) {
      if (pending.expiresAt.getTime() < Date.now()) {
        // Expiró: se descarta y se resuelve de cero (más abajo). `deleteMany` en vez de
        // `delete`: si otro mensaje casi simultáneo ya borró la fila, no queremos que esto
        // tire `P2025` y termine descartando el mensaje en curso.
        await this.prisma.pendingTenantSelection.deleteMany({ where: { id: pending.id } });
      } else {
        const options = (pending.options as unknown as TenantOption[]) ?? [];
        const chosen = this.matchChoice(body, options);
        if (chosen) {
          await this.prisma.pendingTenantSelection.deleteMany({ where: { id: pending.id } });
          // Las opciones quedaron congeladas al crear el pendiente (TTL 12hs): la empresa
          // elegida pudo darse de baja en el medio. Sin este chequeo, el corte de baja lógica
          // de handleMessage descartaba el mensaje original (texto y adjuntos) en silencio
          // total. Se avisa y el próximo mensaje re-rutea de cero.
          const alive = await this.prisma.tenant.findFirst({
            where: { id: chosen.tenantId, deletedAt: null },
            select: { id: true },
          });
          if (!alive) {
            this.logger.warn(
              `[selector] ${from} (${channel}) eligió ${chosen.name} (${chosen.tenantId}), pero la empresa fue dada de baja: se avisa y se re-rutea con el próximo mensaje.`,
            );
            return {
              status: 'notice',
              body:
                `La empresa "${chosen.name}" ya no está disponible por un cambio administrativo. ` +
                'Escribinos de nuevo y te ayudamos desde tu empresa vigente.',
            };
          }
          this.logger.log(`[selector] ${from} (${channel}) eligió ${chosen.name} (${chosen.tenantId}).`);
          // Se reprocesa el mensaje ORIGINAL: su texto y también sus adjuntos (fotos), que
          // de otro modo se perderían — la respuesta al selector ("1", el id) no los trae.
          const replayAttachments = (pending.originalAttachments as unknown as StoredAttachment[]) ?? [];
          return {
            status: 'resolved',
            tenantId: chosen.tenantId,
            replayBody: pending.originalBody,
            replayAttachments,
          };
        }
        // Respuesta inválida: se re-muestra la lista y se refresca la expiración. `updateMany`
        // por el mismo motivo que el `deleteMany` de arriba: tolera que la fila ya no exista.
        await this.prisma.pendingTenantSelection.updateMany({
          where: { id: pending.id },
          data: { expiresAt: new Date(Date.now() + SELECTION_TTL_MS) },
        });
        return this.buildAsk(channel, options, true);
      }
    }

    // 2. Membresías del teléfono. Sin ninguna, no hay a quién rutear: no hablamos con
    // desconocidos (pedido 2026-08-27) — se ignora acá mismo, sin tocar `User`/`Conversation`
    // ni gastar LLM. El intento lo registra `ConversationsService.handleMessage` en el log de
    // archivo (`UnknownSenderLogService`) al recibir este `status: 'ignored'`.
    const memberships = await this.usersService.findMembershipsByPhone(from);
    if (memberships.length === 0) {
      return { status: 'ignored' };
    }
    const membershipTenantIds = memberships.map((m) => m.tenantId);

    // 3. Conversación ACTIVA → se continúa ahí, sin volver a preguntar ("la elección dura la
    // conversación"). Solo cuenta una charla activa: una cerrada significa que esa charla
    // terminó (nodo `end`, /reset, cancelación o timeout de inactividad), así que el próximo
    // mensaje es una charla nueva y se vuelve a preguntar. El resume dentro de la ventana lo
    // sigue haciendo handleMessage, pero acotado a la empresa YA elegida — no re-rutea por su
    // cuenta a la última empresa usada.
    const user = await this.prisma.user.findUnique({ where: { phone: from }, select: { id: true } });
    if (user) {
      // Tenants a los que HOY se puede rutear (ya excluyen dados de baja: `findMembershipsByPhone`
      // filtra `tenant.deletedAt: null`). Se busca PRIMERO acá — a nivel BD, no en memoria — para
      // no arriesgarse a levantar una conversación vieja y ajena en vez de la vigente: `findFirst`
      // sin este filtro tomaría la más RECIENTE creada entre TODAS las empresas del usuario, y si
      // esa resultara no ruteable, cerraría esa (con aviso) aunque hubiera otra más antigua pero
      // perfectamente válida y activa en una empresa ruteable.
      const ongoing = await this.prisma.conversation.findFirst({
        where: { userId: user.id, channel, status: 'active', tenantId: { in: membershipTenantIds } },
        orderBy: { createdAt: 'desc' },
        select: { tenantId: true },
      });
      if (ongoing) return { status: 'resolved', tenantId: ongoing.tenantId };

      // Ninguna activa entre las ruteables: ¿quedó una varada en OTRA empresa por un cambio
      // administrativo a mitad de charla (membresía revocada, empresa dada de baja)? Se cierra
      // y se AVISA — antes se abandonaba en silencio y la respuesta a medias se inyectaba como
      // apertura del flujo de la empresa nueva.
      const stranded = await this.prisma.conversation.findFirst({
        where: { userId: user.id, channel, status: 'active' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, tenantId: true, tenant: { select: { name: true } } },
      });
      if (stranded) {
        await this.prisma.conversation.update({
          where: { id: stranded.id },
          data: { status: 'closed', closedAt: new Date() },
        });
        this.logger.warn(
          `[${stranded.tenantId}] Conversación activa de ${from} (${channel}) cerrada: un cambio ` +
            `administrativo (membresía o baja de la empresa) la dejó fuera del ruteo. Se avisa al usuario.`,
        );
        return {
          status: 'notice',
          body:
            'Tu conversación anterior quedó interrumpida por un cambio administrativo ' +
            `${stranded.tenant?.name ? `en "${stranded.tenant.name}" ` : ''}(cambio de empresa o de acceso). ` +
            'Escribinos de nuevo y empezamos una gestión nueva.',
        };
      }
    }

    // 4. Según cantidad de empresas.
    if (memberships.length === 1) {
      return { status: 'resolved', tenantId: memberships[0].tenantId };
    }

    // ≥2 empresas → guardar el pendiente y preguntar.
    const options: TenantOption[] = memberships.map((m, i) => ({
      index: i + 1,
      tenantId: m.tenant.id,
      name: m.tenant.name,
    }));
    const optionsJson = options as unknown as Prisma.InputJsonValue;
    const attachmentsJson = attachments as unknown as Prisma.InputJsonValue;
    const expiresAt = new Date(Date.now() + SELECTION_TTL_MS);
    // Alta idempotente del pendiente. Si dos mensajes casi simultáneos de un teléfono nuevo
    // llegan a la vez, el segundo NO debe pisar el pendiente del primero (que guarda su
    // `originalBody`/`options`). `skipDuplicates` resuelve el choque contra la unique
    // `[phone, channel]` salteando la fila duplicada, sin lanzar: gana el primero y su mensaje
    // original se conserva. Antes esto era una transacción Serializable que, ante ese mismo
    // choque, tiraba (serialization_failure / unique_violation) sin reintentar, y la excepción
    // subía hasta `handleMessage` y descartaba el mensaje. `skipDuplicates` logra el mismo
    // objetivo (no clobber) sin esa arista.
    await this.prisma.pendingTenantSelection.createMany({
      data: [
        {
          phone: from,
          channel,
          originalBody: body,
          originalAttachments: attachmentsJson,
          options: optionsJson,
          expiresAt,
        },
      ],
      skipDuplicates: true,
    });
    this.logger.log(`[selector] ${from} (${channel}) pertenece a ${options.length} empresas: se pregunta.`);
    return this.buildAsk(channel, options, false);
  }

  /**
   * Matchea la respuesta: por número (1..N), por id de fila interactiva (que es el tenantId)
   * o por el NOMBRE de la empresa — incluido el título truncado que muestran los botones
   * (20 chars) y las listas (24 chars). Sin el matcheo por nombre, tocar un botón en el canal
   * de Twilio entraba en loop: su webhook entrega el TÍTULO visible como `Body` (no el id,
   * como Meta/Gupshup), mismo criterio que ya usa el nodo `menu` al matchear `opt.label`.
   */
  private matchChoice(body: string, options: TenantOption[]): TenantOption | null {
    const trimmed = (body ?? '').trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      const byIndex = options.find((o) => o.index === n);
      if (byIndex) return byIndex;
    }
    const byId = options.find((o) => o.tenantId === trimmed);
    if (byId) return byId;

    const normalized = trimmed.toLowerCase();
    return (
      options.find((o) => {
        const name = o.name.trim().toLowerCase();
        return (
          name === normalized ||
          // Títulos truncados de botón (slice 20) y de fila de lista (slice 24), ver buildTenantInteractive.
          o.name.slice(0, 20).trim().toLowerCase() === normalized ||
          o.name.slice(0, 24).trim().toLowerCase() === normalized
        );
      }) ?? null
    );
  }

  /**
   * Arma la pregunta de empresa. En WhatsApp usa un mensaje interactivo (botones ≤3, lista
   * 4–10), mismo criterio que el nodo `menu`. En SMS —o con más de 10 empresas— cae a texto
   * numerado, porque SMS no tiene botones/listas (y el conector de Gupshup SMS descarta el
   * interactive por completo).
   */
  private buildAsk(channel: string, options: TenantOption[], retry: boolean): InboundRoutingResult {
    const header = retry
      ? 'No reconocí esa opción. ¿Con qué empresa querés operar ahora?'
      : 'Sos un usuario multiempresa. ¿Con qué empresa querés operar ahora?';

    if (channel === 'whatsapp' && options.length <= 10) {
      return { status: 'ask', body: header, interactive: this.buildTenantInteractive(header, options) };
    }

    const lines = options.map((o) => `${o.index}. ${o.name}`).join('\n');
    return { status: 'ask', body: `${header}\n\n${lines}\n\nRespondé con el número.` };
  }

  private buildTenantInteractive(header: string, options: TenantOption[]): WhatsAppInteractive {
    if (options.length <= 3) {
      return {
        type: 'button',
        body: header,
        buttons: options.map((o) => ({ id: o.tenantId, title: o.name.slice(0, 20) })),
      };
    }
    return {
      type: 'list',
      body: header,
      buttonText: 'Elegir empresa',
      rows: options.map((o) => ({ id: o.tenantId, title: o.name.slice(0, 24) })),
    };
  }
}
