/**
 * setupFiles de los tests e2e: corre en cada worker ANTES de cargar los módulos del test, y
 * apunta `DATABASE_URL` a la base efímera y `RABBITMQ_URL` al vhost efímero que dejó
 * `global-setup.ts`. Así el `PrismaService` se conecta a la BD de test (nunca a la real) y el
 * `BrokerService` al vhost aislado (nunca compite por las colas del vhost `/` con otra
 * instancia de la API). Se setea antes de cargar `AppModule`, así que gana sobre el `.env`
 * (dotenv no pisa variables ya presentes en `process.env`).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Resuelve el archivo de handoff que dejó global-setup, nombrado con el PID del proceso raíz de
 * jest. Con `maxWorkers: 1` los tests corren in-band, así que este setupFile corre en ESE mismo
 * proceso y el PID coincide. Si algún día corriera en un worker aparte, su proceso padre es el
 * raíz: por eso probamos primero el PID propio y, si no está, el del padre.
 */
function resolveHandoffFile(): string | undefined {
  const candidates = [
    path.join(os.tmpdir(), `pci-e2e-db.${process.pid}.json`),
    path.join(os.tmpdir(), `pci-e2e-db.${process.ppid}.json`),
  ];
  return candidates.find((file) => fs.existsSync(file));
}

const handoffFile = resolveHandoffFile();
if (handoffFile) {
  const { dbUrl, rabbitUrl } = JSON.parse(fs.readFileSync(handoffFile, 'utf8'));
  if (dbUrl) process.env.DATABASE_URL = dbUrl;
  // Ausente si el vhost efímero no se pudo crear: en ese caso se conserva el del `.env`.
  if (rabbitUrl) process.env.RABBITMQ_URL = rabbitUrl;
}

/**
 * Credenciales reales que algunos `.env` locales tienen cargadas para probar a mano contra el
 * número de WhatsApp Business real del desarrollador (ver `chat.mjs`/`/settings`). Varios specs
 * de BE-WAO-* asumen como precondición "nada configurado" (así prueban el camino sin
 * credenciales) — sin este borrado, esos specs son no-deterministas: pasan en un ambiente sin
 * `.env` cargado y fallan en la máquina de quien sí lo tiene, porque `AppConfigService.get()` cae
 * a estas env vars cuando no hay `Setting` en la base efímera. `installFetchMock` mockea el
 * `fetch` global igual (nunca sale tráfico real), pero la aserción de "no llamó a fetch" depende
 * de que el conector ni siquiera intente armar el request.
 *
 * Se pisan con string vacío, no se borran: `dotenv` (que carga el `.env` recién al levantar
 * `AppModule`, después de este setupFile) NO sobreescribe una variable que YA está presente en
 * `process.env` — pero si estuviera ausente (`delete`), la volvería a poner desde el `.env` al
 * cargar, dejando este borrado sin efecto. Vacío sigue siendo "sin configurar" para
 * `AppConfigService.get()` (falsy) y para el resto de la cascada BD → env → default.
 */
for (const key of [
  'WHATSAPP_API_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_SANDBOX_RECIPIENT_OVERRIDES',
]) {
  process.env[key] = '';
}
