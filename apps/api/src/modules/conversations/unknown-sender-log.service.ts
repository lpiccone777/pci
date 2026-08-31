import { Injectable, Logger } from '@nestjs/common';
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

const LOG_DIR = join(process.cwd(), 'logs', 'unknown-senders');
/** Vida útil pedida: "un mes" — 4 semanas calendario, mismo criterio de redondeo que GupshupFileLoggerService. */
const RETENTION_WEEKS = 4;

/**
 * Registro en disco de los mensajes rechazados por venir de un número no registrado en el
 * tenant (ver `ConversationsService.handleMessage`, paso 1). No vamos a hablar con
 * desconocidos: no se crea `User`, no se abre `Conversation`, no se gasta LLM — así que no
 * queda ningún rastro en la base. Esto es el único registro del intento, y a propósito no
 * vive en la BD: cuando se implemente rate limiting por número sí va a hacer falta un conteo
 * persistente, pero hoy es solo para poder mirar "quién nos escribió sin estar registrado".
 *
 * Mismo esquema que `GupshupFileLoggerService`: un archivo por semana ISO (JSON Lines),
 * rotación automática, y los de más de `RETENTION_WEEKS` se borran solos en cada escritura.
 */
@Injectable()
export class UnknownSenderLogService {
  private readonly logger = new Logger(UnknownSenderLogService.name);

  /**
   * `tenantId` es opcional: el ruteo por membresía (`InboundTenantRoutingService`) puede
   * rechazar un teléfono ANTES de saber a qué empresa hubiera ido — no pertenece a ninguna,
   * así que no hay tenant que loguear. El rechazo dentro de una empresa ya resuelta (mensaje
   * `/simulate` contra un `tenantId` puntual) sí lo trae.
   */
  log(data: { tenantId?: string; channel: string; from: string; bodyPreview: string }): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...data });
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(this.currentFilePath(), line + '\n', 'utf8');
    } catch (err) {
      // No tirar el manejo del mensaje entrante porque falló escribir a disco.
      this.logger.warn(`No se pudo escribir el log de remitentes desconocidos: ${(err as Error).message}`);
    }
    this.cleanupOldFiles();
  }

  private currentFilePath(): string {
    return join(LOG_DIR, `unknown-${this.isoWeekLabel(new Date())}.log`);
  }

  /** Etiqueta semana-ISO (`YYYY-Www`) del `date` dado, para que el nombre de archivo agrupe por semana calendario. */
  private isoWeekLabel(date: Date): string {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  }

  private cleanupOldFiles(): void {
    const cutoff = Date.now() - RETENTION_WEEKS * 7 * 24 * 60 * 60 * 1000;
    try {
      for (const file of readdirSync(LOG_DIR)) {
        if (!file.startsWith('unknown-') || !file.endsWith('.log')) continue;
        const full = join(LOG_DIR, file);
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      }
    } catch {
      // Best-effort — un fallo acá no debe afectar el mensaje en curso.
    }
  }
}
