import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../config/app-config.service';
import { EXTENSION_BY_CONTENT_TYPE, StoredAttachment, resizeIfNeeded, resolveStorageDir } from './media-storage.util';

export { StoredAttachment };

const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Vida máxima de un adjunto en disco sin usar (ver `cleanupExpired`): si en 10 minutos el
 * flujo no llegó a un `ticket_create`/`transfer_agent` que lo consuma, se borra solo —
 * pedido explícito 2026-08-20, para no acumular imágenes de charlas que nunca llegan a
 * generar un ticket.
 */
const RETENTION_MS = 10 * 60 * 1000;

/**
 * Descarga imágenes que el usuario manda por WhatsApp/SMS (vía Twilio) y las guarda
 * temporalmente en disco, para adjuntarlas después a un ticket de InvGate cuando el
 * flujo llegue al nodo `ticket_create` — puede ser varios mensajes más tarde (ver
 * `flowState.pendingAttachments` en `ConversationsService`). Un cron propio (ver
 * `cleanupExpired`) borra lo que quede sin usar pasados `RETENTION_MS`.
 *
 * Las URLs de media de Twilio (a diferencia de las de Gupshup/Meta, que son públicas con
 * expiración) no son públicas: hace falta autenticarse con las mismas credenciales
 * (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`) que ya usan `TwilioWhatsAppService`/
 * `TwilioSmsService` para mandar mensajes. Ver `GupshupMediaService` para el equivalente
 * de Gupshup (no necesita auth para descargar).
 *
 * Instancia única en toda la app (ver `MediaModule`) — importa para que el `@Cron` de
 * limpieza no corra una vez por cada módulo que lo consume.
 */
@Injectable()
export class TwilioMediaService {
  private readonly logger = new Logger(TwilioMediaService.name);

  constructor(private readonly appConfig: AppConfigService) {}

  private async credentials(): Promise<{ accountSid: string; authToken: string } | null> {
    const [accountSid, authToken] = await Promise.all([
      this.appConfig.get('TWILIO_ACCOUNT_SID'),
      this.appConfig.get('TWILIO_AUTH_TOKEN'),
    ]);
    if (!accountSid || !authToken) return null;
    return { accountSid, authToken };
  }

  /**
   * Descarga un único adjunto de Twilio, lo redimensiona si hace falta (ver
   * `resizeIfNeeded`) y lo guarda en disco. `null` ante cualquier falla (sin
   * credenciales, HTTP no-2xx, etc.) — mismo criterio best-effort que el resto de las
   * integraciones: nunca corta la charla por esto.
   */
  async downloadAndStore(mediaUrl: string, contentType: string | undefined): Promise<StoredAttachment | null> {
    const creds = await this.credentials();
    if (!creds) {
      this.logger.warn(
        `No se pudo descargar adjunto de Twilio (${mediaUrl}): falta TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN en /settings.`,
      );
      return null;
    }

    let res: Response;
    try {
      const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
      res = await fetch(mediaUrl, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`No se pudo descargar adjunto de Twilio (${mediaUrl}): ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`Twilio respondió ${res.status} al descargar el adjunto ${mediaUrl}.`);
      return null;
    }

    const resolvedType = contentType || res.headers.get('content-type') || 'application/octet-stream';
    const extension = EXTENSION_BY_CONTENT_TYPE[resolvedType] || 'bin';
    const filename = `${randomUUID()}.${extension}`;

    const dir = await resolveStorageDir(this.appConfig);
    try {
      await mkdir(dir, { recursive: true });
      const original = Buffer.from(await res.arrayBuffer());
      const buffer = await resizeIfNeeded(original, resolvedType, this.logger);
      const fullPath = path.join(dir, filename);
      await writeFile(fullPath, buffer);
      return { path: fullPath, filename, contentType: resolvedType };
    } catch (err) {
      this.logger.warn(`No se pudo guardar el adjunto ${filename} en disco: ${(err as Error).message}`);
      return null;
    }
  }

  /** Lee un adjunto ya guardado — usado al armar el multipart para InvGate. `null` si ya no está (limpieza, disco borrado a mano, etc.). */
  async read(stored: { path: string; filename: string; contentType: string }): Promise<Buffer | null> {
    try {
      return await readFile(stored.path);
    } catch (err) {
      this.logger.warn(`No se pudo leer el adjunto ${stored.filename} de disco: ${(err as Error).message}`);
      return null;
    }
  }

  /** Borra el archivo temporal una vez adjuntado a InvGate (o descartado) — no acumular para siempre en disco. */
  async delete(stored: { path: string }): Promise<void> {
    await unlink(stored.path).catch(() => {
      // No debería fallar; si el archivo ya no está (doble delete, limpieza externa), no hay nada que hacer.
    });
  }

  /**
   * Barrido cada 2 minutos: borra cualquier adjunto de más de `RETENTION_MS` (10min) que
   * nadie haya consumido todavía — una charla que nunca llega a `ticket_create`/
   * `transfer_agent` (se cierra, el usuario se cansa, cambia de tema) dejaría la imagen en
   * disco para siempre sin esto. Best-effort archivo por archivo: uno que falle (borrado
   * a mano entre el `readdir` y el `stat`, por ejemplo) no frena la limpieza del resto.
   */
  @Cron('*/2 * * * *')
  async cleanupExpired(): Promise<void> {
    const dir = await resolveStorageDir(this.appConfig);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // el directorio ni existe todavía (nada se descargó nunca) — nada que limpiar.
    }

    const cutoff = Date.now() - RETENTION_MS;
    let deleted = 0;
    for (const name of entries) {
      const fullPath = path.join(dir, name);
      try {
        const stats = await stat(fullPath);
        if (stats.mtimeMs < cutoff) {
          await unlink(fullPath);
          deleted++;
        }
      } catch {
        // Carrera con otro delete concurrente (ya consumido justo ahora) — no es un error real.
      }
    }

    if (deleted) {
      this.logger.log(`Limpieza de adjuntos temporales: ${deleted} archivo(s) de más de 10 minutos sin usar, borrados.`);
    }
  }
}
