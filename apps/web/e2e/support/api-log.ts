/**
 * Captura del stdout de la API aislada, para poder leer el código OTP que el sistema genera.
 *
 * Sin SMTP configurado, `SmtpEmailService` cae al modo "stub" y escribe el email —incluido el
 * código OTP— en la consola del proceso de la API (ver `apps/api/src/modules/auth/smtp-email.service.ts`).
 * El stack e2e (`ephemeral-stack.ts`) arranca la API con su stdout volcado a ESTE archivo además
 * de a la consola, así que un spec puede leer el código real y probar el flujo de 2FA de punta a
 * punta (FE-LOG-04) sin mockear la lógica bajo prueba.
 *
 * `global-setup.ts` (que escribe) y los specs (que leen) comparten la ruta desde acá: única
 * fuente de verdad del archivo de log. Vive en `e2e/.artifacts/` (gitignoreado).
 */
import * as fs from 'fs';
import * as path from 'path';

export const API_LOG_PATH = path.join(__dirname, '..', '.artifacts', 'api.log');

/** Asegura que exista el directorio del log y devuelve la ruta. Lo llama `ephemeral-stack`. */
export function ensureApiLogDir(): string {
  fs.mkdirSync(path.dirname(API_LOG_PATH), { recursive: true });
  return API_LOG_PATH;
}

/**
 * Marca la posición actual del log (en caracteres). Se toma ANTES de disparar el login que
 * manda el OTP, para después buscar solo los códigos generados a partir de ese punto y no
 * confundirse con uno viejo de otro test.
 */
export function apiLogMark(): number {
  try {
    return fs.readFileSync(API_LOG_PATH, 'utf8').length;
  } catch {
    return 0;
  }
}

/**
 * Espera a que aparezca un código OTP en el log a partir de `sinceMark` y devuelve el ÚLTIMO
 * (el más reciente). Reintenta porque el volcado del stdout de la API es asíncrono: el código
 * puede tardar unos milisegundos en llegar al archivo después de que el backend lo genere.
 */
export async function waitForOtpCode(sinceMark: number, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const pattern = /verificación es:\s*(\d{4,8})/g;
  while (Date.now() < deadline) {
    let content = '';
    try {
      content = fs.readFileSync(API_LOG_PATH, 'utf8');
    } catch {
      /* el archivo puede no existir todavía en el primer intento */
    }
    const slice = content.slice(sinceMark);
    let last: string | undefined;
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(slice)) !== null) last = m[1];
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `[e2e] No apareció un código OTP en el log de la API (${API_LOG_PATH}) dentro de ${timeoutMs}ms. ` +
      '¿El stack e2e está volcando el stdout de la API al archivo? Ver ephemeral-stack.ts.',
  );
}
