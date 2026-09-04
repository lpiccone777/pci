import path from 'path';
import sharp from 'sharp';
import { Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/** "HD1080": tope de 1920x1080, nunca se agranda una imagen más chica — ver `resizeIfNeeded`. */
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;

/** Content-types que sharp puede redimensionar. GIF queda afuera (multi-frame, riesgo de perder la animación) y PDF no es una imagen. */
const RESIZABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** Media descargada y guardada en disco, referenciable después por `path` (ver `flowState.pendingAttachments`). */
export interface StoredAttachment {
  path: string;
  filename: string;
  contentType: string;
}

/**
 * Directorio compartido donde `TwilioMediaService` y `GupshupMediaService` guardan los
 * adjuntos descargados — mismo `MEDIA_STORAGE_DIR`, para que el `@Cron` de limpieza de
 * `TwilioMediaService` (barre el directorio entero por antigüedad de archivo, sin
 * importar qué proveedor lo bajó) también limpie los de Gupshup sin necesitar un segundo
 * cron redundante.
 */
export async function resolveStorageDir(appConfig: AppConfigService): Promise<string> {
  const configured = (await appConfig.get('MEDIA_STORAGE_DIR', 'uploads/incoming-media')) ?? 'uploads/incoming-media';
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

/**
 * Achica a un máximo de 1920x1080 ("HD1080") preservando el aspect ratio, igual criterio en
 * ambos proveedores. `fit: 'inside'` + `withoutEnlargement` hacen que una imagen ya chica no
 * se toque; `rotate()` sin argumentos auto-orienta según el EXIF de la cámara ANTES de medir/
 * redimensionar. Si sharp falla por lo que sea (formato corrupto, etc.), se guarda el
 * original tal cual — nunca se pierde el adjunto por un error de redimensionado.
 */
export async function resizeIfNeeded(buffer: Buffer, contentType: string, logger: Logger): Promise<Buffer> {
  if (!RESIZABLE_TYPES.has(contentType)) return buffer;

  try {
    const oriented = sharp(buffer, { failOn: 'none' }).rotate();
    const metadata = await oriented.metadata();
    if (!metadata.width || !metadata.height) return buffer;
    if (metadata.width <= MAX_WIDTH && metadata.height <= MAX_HEIGHT) return buffer;

    return await oriented.resize({ width: MAX_WIDTH, height: MAX_HEIGHT, fit: 'inside', withoutEnlargement: true }).toBuffer();
  } catch (err) {
    logger.warn(`No se pudo redimensionar la imagen, se guarda el original tal cual: ${(err as Error).message}`);
    return buffer;
  }
}
