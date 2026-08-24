import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { AppConfigService } from '../config/app-config.service';

const DOWNLOAD_TIMEOUT_MS = 20_000;

/** "HD1080": tope de 1920x1080, nunca se agranda una imagen más chica — ver `resizeIfNeeded`. */
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;

/** Content-types que sharp puede redimensionar. GIF queda afuera (multi-frame, riesgo de perder la animación) y PDF no es una imagen. */
const RESIZABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Vida máxima de un adjunto en disco sin usar (ver `cleanupExpired`): si en 10 minutos el
 * flujo no llegó a un `ticket_create`/`transfer_agent` que lo consuma, se borra solo —
 * pedido explícito 2026-08-20, para no acumular imágenes de charlas que nunca llegan a
 * generar un ticket.
 */
const RETENTION_MS = 10 * 60 * 1000;

/** Media descargada y guardada en disco, referenciable después por `path` (ver `flowState.pendingAttachments`). */
export interface StoredAttachment {
  path: string;
  filename: string;
  contentType: string;
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * Descarga imágenes que el usuario manda por WhatsApp/SMS (vía Twilio) y las guarda
 * temporalmente en disco, para adjuntarlas después a un ticket de InvGate cuando el
 * flujo llegue al nodo `ticket_create` — puede ser varios mensajes más tarde (ver
 * `flowState.pendingAttachments` en `ConversationsService`). Un cron propio (ver
 * `cleanupExpired`) borra lo que quede sin usar pasados `RETENTION_MS`.
 *
 * Solo Twilio por ahora (WhatsApp Business API directa y Gupshup no están cableados
 * todavía — ver AGENTS.md/plan de trabajo). Las URLs de media de Twilio (a diferencia
 * de las de Meta, que expiran en minutos) no son públicas: hace falta autenticarse con
 * las mismas credenciales (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`) que ya usan
 * `TwilioWhatsAppService`/`TwilioSmsService` para mandar mensajes.
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

  /** Directorio de guardado — configurable, relativo al cwd del proceso si no es absoluto. */
  private async storageDir(): Promise<string> {
    const configured =
      (await this.appConfig.get('MEDIA_STORAGE_DIR', 'uploads/incoming-media')) ?? 'uploads/incoming-media';
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
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

    const dir = await this.storageDir();
    try {
      await mkdir(dir, { recursive: true });
      const original = Buffer.from(await res.arrayBuffer());
      const buffer = await this.resizeIfNeeded(original, resolvedType);
      const fullPath = path.join(dir, filename);
      await writeFile(fullPath, buffer);
      return { path: fullPath, filename, contentType: resolvedType };
    } catch (err) {
      this.logger.warn(`No se pudo guardar el adjunto ${filename} en disco: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Achica a un máximo de 1920x1080 ("HD1080") preservando el aspect ratio — pedido
   * explícito 2026-08-20, para no mandar a InvGate (ni ocupar disco con) fotos de celular
   * a resolución completa cuando ni siquiera se van a ver más grandes que eso. `fit:
   * 'inside'` + `withoutEnlargement` hacen que una imagen ya chica no se toque; `rotate()`
   * sin argumentos auto-orienta según el EXIF de la cámara ANTES de medir/redimensionar
   * (si no, una foto vertical tomada con el celular de costado sale rotada). Si sharp
   * falla por lo que sea (formato corrupto, etc.), se guarda el original tal cual — nunca
   * se pierde el adjunto por un error de redimensionado.
   */
  private async resizeIfNeeded(buffer: Buffer, contentType: string): Promise<Buffer> {
    if (!RESIZABLE_TYPES.has(contentType)) return buffer;

    try {
      const oriented = sharp(buffer, { failOn: 'none' }).rotate();
      const metadata = await oriented.metadata();
      if (!metadata.width || !metadata.height) return buffer;
      if (metadata.width <= MAX_WIDTH && metadata.height <= MAX_HEIGHT) return buffer;

      return await oriented.resize({ width: MAX_WIDTH, height: MAX_HEIGHT, fit: 'inside', withoutEnlargement: true }).toBuffer();
    } catch (err) {
      this.logger.warn(`No se pudo redimensionar la imagen, se guarda el original tal cual: ${(err as Error).message}`);
      return buffer;
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
    const dir = await this.storageDir();
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
