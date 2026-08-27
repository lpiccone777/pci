import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { systemTenantSlug } from '../../common/system-tenant';
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
  | { status: 'ask'; body: string; interactive?: WhatsAppInteractive };

/**
 * Decide qué empresa (tenant) atiende un mensaje ENTRANTE de canal, a partir de la membresía
 * del teléfono (no de configuración). Orden de decisión:
 *   1. ¿Hay una selección pendiente para este teléfono+canal? → este mensaje es la respuesta.
 *   2. ¿Hay una conversación en curso (o reanudable) en alguna de sus empresas? → esa.
 *   3. Según cantidad de membresías: 1 → directo; ≥2 → preguntar; 0 → tenant de sistema.
 */
@Injectable()
export class InboundTenantRoutingService {
  private readonly logger = new Logger(InboundTenantRoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly config: ConfigService,
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

    // 2. Membresías del teléfono.
    const memberships = await this.usersService.findMembershipsByPhone(from);

    // 2b. Conversación ACTIVA en alguna de sus empresas → se continúa ahí, sin volver a
    // preguntar ("la elección dura la conversación"). Solo cuenta una charla activa: una
    // cerrada significa que esa charla terminó (nodo `end`, /reset, cancelación o timeout de
    // inactividad), así que el próximo mensaje es una charla nueva y se vuelve a preguntar. El
    // resume dentro de la ventana lo sigue haciendo handleMessage, pero acotado a la empresa
    // YA elegida — no re-rutea por su cuenta a la última empresa usada.
    if (memberships.length > 0) {
      const userId = memberships[0].userId;
      const tenantIds = memberships.map((m) => m.tenantId);
      const ongoing = await this.prisma.conversation.findFirst({
        where: { userId, channel, tenantId: { in: tenantIds }, status: 'active' },
        orderBy: { createdAt: 'desc' },
        select: { tenantId: true },
      });
      if (ongoing) return { status: 'resolved', tenantId: ongoing.tenantId };
    }

    // 3. Según cantidad de empresas.
    if (memberships.length === 1) {
      return { status: 'resolved', tenantId: memberships[0].tenantId };
    }
    if (memberships.length === 0) {
      return { status: 'resolved', tenantId: await this.resolveSystemTenantId() };
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
    // Se crea el pendiente dentro de una transacción serializable para que dos mensajes casi
    // simultáneos de un teléfono nuevo no se pisen el pendiente: el segundo ve el que dejó el
    // primero (re-lectura dentro de la tx) y no lo sobreescribe a ciegas. El `upsert` suelto
    // que había antes era atómico por la unique key, pero igual podía pisar originalBody/options.
    await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.pendingTenantSelection.findUnique({
          where: { phone_channel: { phone: from, channel } },
        });
        if (existing) return;
        await tx.pendingTenantSelection.create({
          data: {
            phone: from,
            channel,
            originalBody: body,
            originalAttachments: attachmentsJson,
            options: optionsJson,
            expiresAt,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    this.logger.log(`[selector] ${from} (${channel}) pertenece a ${options.length} empresas: se pregunta.`);
    return this.buildAsk(channel, options, false);
  }

  /** Matchea la respuesta: por número (1..N) o por id de fila interactiva (que es el tenantId). */
  private matchChoice(body: string, options: TenantOption[]): TenantOption | null {
    const trimmed = (body ?? '').trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      const byIndex = options.find((o) => o.index === n);
      if (byIndex) return byIndex;
    }
    return options.find((o) => o.tenantId === trimmed) ?? null;
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

  /** Tenant de sistema (para teléfonos que no pertenecen a ninguna empresa). Debe existir (sembrado y protegido). */
  private async resolveSystemTenantId(): Promise<string> {
    const slug = systemTenantSlug(this.config);
    const tenant = await this.prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
    if (!tenant) {
      throw new Error(
        `No existe el tenant de sistema (slug='${slug}'); no se puede atender a un usuario sin empresa.`,
      );
    }
    return tenant.id;
  }
}
