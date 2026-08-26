import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { EXTENSION_BY_CONTENT_TYPE, StoredAttachment, resizeIfNeeded, resolveStorageDir } from './media-storage.util';
import { AppConfigService } from '../config/app-config.service';

const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Descarga imágenes que el usuario manda por WhatsApp vía Gupshup y las guarda
 * temporalmente en disco — mismo contrato y mismo directorio (`MEDIA_STORAGE_DIR`) que
 * `TwilioMediaService`, para que un único `flowState.pendingAttachments` y un único
 * `ConversationsService` funcionen sin importar el proveedor.
 *
 * A diferencia de Twilio, la `url` que manda Gupshup (`docs.gupshup.io` — Media, verificado
 * 2026-08-26) ya es pública (con expiración vía `urlExpiry`, no vencida al momento de
 * procesar el webhook): no hace falta autenticarse con el API key para descargarla.
 * `read`/`delete`/la limpieza por antigüedad los sigue manejando `TwilioMediaService`
 * (barre el directorio entero, sin importar quién descargó cada archivo) — no hace falta
 * duplicarlos ni un segundo `@Cron`.
 */
@Injectable()
export class GupshupMediaService {
  private readonly logger = new Logger(GupshupMediaService.name);

  constructor(private readonly appConfig: AppConfigService) {}

  /**
   * Descarga un único adjunto de Gupshup, lo redimensiona si hace falta y lo guarda en
   * disco. `null` ante cualquier falla (URL vencida, HTTP no-2xx, etc.) — mismo criterio
   * best-effort que `TwilioMediaService.downloadAndStore`: nunca corta la charla por esto.
   */
  async downloadAndStore(mediaUrl: string, contentType: string | undefined): Promise<StoredAttachment | null> {
    let res: Response;
    try {
      res = await fetch(mediaUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      this.logger.warn(`No se pudo descargar adjunto de Gupshup (${mediaUrl}): ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`Gupshup respondió ${res.status} al descargar el adjunto ${mediaUrl} (¿URL vencida? ver 'urlExpiry').`);
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
}
