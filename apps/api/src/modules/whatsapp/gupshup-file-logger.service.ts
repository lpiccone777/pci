import { Injectable, Logger } from '@nestjs/common';
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

const LOG_DIR = join(process.cwd(), 'logs', 'gupshup');
/** Cuántas semanas de archivos viejos se conservan antes de borrarlos. */
const RETENTION_WEEKS = 8;

/**
 * Historial en disco de la actividad de Gupshup (webhooks entrantes, eventos de entrega,
 * envíos salientes) — el `Logger` de Nest solo va a stdout/la consola del proceso, así que se
 * pierde en cuanto se reinicia o se scrollea la terminal. Esto da un registro persistente para
 * no depender de estar mirando la consola en el momento exacto en que llega un mensaje.
 *
 * Un archivo por semana ISO (`gupshup-YYYY-Www.log`, JSON Lines) — rotación automática: al
 * cambiar de semana, el siguiente `log()` simplemente empieza a escribir en un archivo nuevo.
 * Los de más de `RETENTION_WEEKS` semanas se borran solos en cada escritura.
 */
@Injectable()
export class GupshupFileLoggerService {
  private readonly logger = new Logger(GupshupFileLoggerService.name);

  log(event: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(this.currentFilePath(), line + '\n', 'utf8');
    } catch (err) {
      // No tirar la request de un webhook/envío real porque falló escribir a disco.
      this.logger.warn(`No se pudo escribir el log de Gupshup a archivo: ${(err as Error).message}`);
    }
    this.cleanupOldFiles();
  }

  private currentFilePath(): string {
    return join(LOG_DIR, `gupshup-${this.isoWeekLabel(new Date())}.log`);
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
        if (!file.startsWith('gupshup-') || !file.endsWith('.log')) continue;
        const full = join(LOG_DIR, file);
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      }
    } catch {
      // Best-effort — un fallo acá no debe afectar el request en curso.
    }
  }
}
