/**
 * globalSetup de los tests e2e: crea una base de datos EFÍMERA por corrida, le aplica las
 * migraciones y el seed base, y deja su URL para los workers (setup-env.ts) y el teardown.
 *
 * La base real NUNCA se toca: los tests corren contra `pci_test_<timestamp>_<pid>`, que
 * `global-teardown.ts` dropea al terminar. Usa Prisma directo (sin dependencias nuevas): el
 * CREATE/DROP DATABASE va por `$executeRawUnsafe` contra la base de mantenimiento `postgres`,
 * y las migraciones + seed por el CLI de Prisma que ya está en el proyecto.
 *
 * Requisito: el usuario de `DATABASE_URL` debe poder crear y borrar bases (en un Postgres
 * local suele tenerlo). Sin ese permiso, el CREATE falla acá con un error claro.
 */
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const API_DIR = path.resolve(__dirname, '..');
// El handoff se nombra con el PID del proceso raíz de jest (este mismo). Con `maxWorkers: 1`
// los tests corren in-band, así que globalSetup, los setupFiles y el globalTeardown comparten
// este PID y llegan todos al mismo archivo. Meter el PID en el nombre evita que dos corridas
// simultáneas en la misma máquina (cada `pnpm test:e2e` es un proceso jest distinto) se pisen
// el archivo compartido.
const HANDOFF_FILE = path.join(os.tmpdir(), `pci-e2e-db.${process.pid}.json`);

/** Lee una variable primero del entorno y, si no está, del `.env` de apps/api (parseo mínimo,
 *  sin depender de dotenv). */
function readEnvVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const envPath = path.join(API_DIR, '.env');
  if (!fs.existsSync(envPath)) return undefined;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== name) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

/** Llama al management API de RabbitMQ con basic auth. Lanza si la respuesta no es 2xx. */
async function rabbitMgmtRequest(
  mgmt: { baseUrl: string; user: string; pass: string },
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<void> {
  const auth = Buffer.from(`${mgmt.user}:${mgmt.pass}`).toString('base64');
  const res = await fetch(`${mgmt.baseUrl}${apiPath}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${apiPath} → ${res.status} ${await res.text()}`);
  }
}

/**
 * Crea un vhost de RabbitMQ EFÍMERO para aislar el broker de los tests de cualquier otra
 * instancia de la API conectada al mismo servidor. La cola del simulate
 * (`whatsapp.simulate.incoming`) pasa a vivir dentro de ese vhost, así que un `dev:api`
 * corriendo en el vhost por defecto (`/`) ya no compite por sus mensajes: el problema de
 * "varias instancias contra el mismo broker" que documenta `BrokerService.request` queda
 * resuelto para la corrida de tests, sin tocar el código de producción (el nombre de la cola
 * no cambia; cambia el vhost donde vive, y eso viaja en `RABBITMQ_URL`).
 *
 * Es best-effort: si no se puede crear (p. ej. sin plugin de management), devuelve `null` y
 * los tests caen al comportamiento previo (vhost compartido `/`), sin romperse.
 */
async function setupEphemeralVhost(suffix: string): Promise<{
  vhost: string;
  rabbitUrl: string;
  rabbitMgmt: { baseUrl: string; user: string; pass: string };
} | null> {
  const baseRabbitUrl = readEnvVar('RABBITMQ_URL');
  if (!baseRabbitUrl) {
    console.warn(
      '[e2e] RABBITMQ_URL no encontrada; los tests que usan el broker corren sobre el vhost compartido.',
    );
    return null;
  }

  let amqpUrl: URL;
  try {
    amqpUrl = new URL(baseRabbitUrl);
  } catch {
    console.warn('[e2e] RABBITMQ_URL no es una URL válida; se omite el aislamiento del broker.');
    return null;
  }

  const user = amqpUrl.username ? decodeURIComponent(amqpUrl.username) : 'guest';
  const pass = amqpUrl.password ? decodeURIComponent(amqpUrl.password) : 'guest';
  const baseUrl = process.env.RABBITMQ_MANAGEMENT_URL || `http://${amqpUrl.hostname}:15672`;
  const vhost = `pci_test_${suffix}`;
  const rabbitMgmt = { baseUrl, user, pass };

  try {
    // Crear el vhost y darle permisos totales al usuario: un vhost recién creado no tiene
    // permisos para nadie, así que sin esto el BrokerService no podría declarar colas.
    await rabbitMgmtRequest(rabbitMgmt, 'PUT', `/api/vhosts/${encodeURIComponent(vhost)}`);
    await rabbitMgmtRequest(
      rabbitMgmt,
      'PUT',
      `/api/permissions/${encodeURIComponent(vhost)}/${encodeURIComponent(user)}`,
      { configure: '.*', write: '.*', read: '.*' },
    );
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    console.warn(
      `[e2e] No se pudo crear el vhost de RabbitMQ efímero (${motivo}).\n` +
        '      Los tests que usan el broker corren sobre el vhost compartido: si hay otra\n' +
        '      instancia de la API conectada al mismo RabbitMQ, los casos CHAT-* pueden fallar\n' +
        '      por competencia de consumidores (round-robin sobre la cola del simulate).',
    );
    return null;
  }

  // Misma URL del broker, pero apuntando al vhost efímero (viaja en el path del amqp://).
  const ephemeralRabbit = new URL(baseRabbitUrl);
  ephemeralRabbit.pathname = `/${vhost}`;

  return { vhost, rabbitUrl: ephemeralRabbit.toString(), rabbitMgmt };
}

/**
 * Fail-fast del MODO DEGRADADO: cuando no se pudo aislar el broker en un vhost efímero, los
 * tests caen al vhost compartido (`/`). Si en ese vhost ya hay otra instancia de la API
 * consumiendo la cola del simulate, los casos CHAT-* se colgarían hasta el timeout de
 * `simulateIncomingMessage` (300s) antes de fallar sin decir por qué. Este chequeo lo detecta
 * y aborta la corrida de una, con un mensaje accionable, en vez de dejar que se cuelgue.
 *
 * Solo tiene sentido en modo degradado: con vhost efímero, su cola nace vacía y no puede haber
 * competidor. La verificación en sí es best-effort — si el management API no se puede consultar,
 * avisa y sigue, para no convertir un problema de diagnóstico en un falso impedimento.
 */
async function assertNoCompetingSimulateConsumer(): Promise<void> {
  // Nombre de la cola del simulate en producción (ConversationsService.SIMULATE_QUEUE). Es un
  // literal estable; no se importa para no acoplar el setup de test al código de producción.
  const SIMULATE_QUEUE_NAME = 'whatsapp.simulate.incoming';

  const baseRabbitUrl = readEnvVar('RABBITMQ_URL');
  if (!baseRabbitUrl) return;

  let amqpUrl: URL;
  try {
    amqpUrl = new URL(baseRabbitUrl);
  } catch {
    return;
  }

  const user = amqpUrl.username ? decodeURIComponent(amqpUrl.username) : 'guest';
  const pass = amqpUrl.password ? decodeURIComponent(amqpUrl.password) : 'guest';
  const baseUrl = process.env.RABBITMQ_MANAGEMENT_URL || `http://${amqpUrl.hostname}:15672`;
  // El vhost donde correrían los tests en modo degradado: el del `.env` (por defecto, `/`).
  const vhost =
    amqpUrl.pathname && amqpUrl.pathname !== '/' ? decodeURIComponent(amqpUrl.pathname.slice(1)) : '/';

  let consumers: number;
  try {
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const res = await fetch(
      `${baseUrl}/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(SIMULATE_QUEUE_NAME)}`,
      { headers: { Authorization: `Basic ${auth}` } },
    );
    // 404 = la cola todavía no existe en ese vhost → no hay competidor posible.
    if (res.status === 404) return;
    if (!res.ok) {
      console.warn(
        `[e2e] No pude verificar consumidores de ${SIMULATE_QUEUE_NAME} (HTTP ${res.status}); sigo sin chequear.`,
      );
      return;
    }
    const body = (await res.json()) as { consumers?: number };
    consumers = body.consumers ?? 0;
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    console.warn(
      `[e2e] No pude verificar consumidores de ${SIMULATE_QUEUE_NAME} (${motivo}); sigo sin chequear.`,
    );
    return;
  }

  if (consumers > 0) {
    throw new Error(
      `[e2e] El broker no se pudo aislar en un vhost efímero y la cola ${SIMULATE_QUEUE_NAME} del ` +
        `vhost "${vhost}" ya tiene ${consumers} consumidor(es) — probablemente otra instancia de la ` +
        `API (p. ej. un dev:api). Los casos CHAT-* se colgarían hasta 300s antes de fallar.\n` +
        `      Solución: frená esa instancia, o habilitá el plugin de management de RabbitMQ para ` +
        `que los tests se aíslen solos en un vhost propio.`,
    );
  }
}

/**
 * Dropea (best-effort) la base efímera. Se usa cuando la preparación falla DESPUÉS de haber
 * creado la base: como Jest no corre el globalTeardown si el globalSetup tira, la limpieza tiene
 * que pasar acá mismo o la base queda huérfana. Nunca lanza: un fallo de limpieza no debe tapar
 * el error real que llevó hasta acá.
 */
async function dropEphemeralDatabaseQuietly(maintenanceUrl: string, dbName: string): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: maintenanceUrl } } });
  try {
    await admin.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
    );
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    console.warn(
      `[e2e] No se pudo limpiar la base efímera ${dbName} tras un fallo de preparación (${motivo}).`,
    );
  } finally {
    await admin.$disconnect();
  }
}

export default async function globalSetup(): Promise<void> {
  const baseUrl = readEnvVar('DATABASE_URL');
  if (!baseUrl) {
    throw new Error(
      '[e2e] No se encontró DATABASE_URL (ni en el entorno ni en apps/api/.env). Es necesaria para crear la BD de test.',
    );
  }

  const suffix = `${Date.now()}_${process.pid}`;
  const dbName = `pci_test_${suffix}`;

  // Mantenimiento: mismo servidor/credenciales, base `postgres` (para poder crear/dropear otra).
  const maintenanceUrl = new URL(baseUrl);
  maintenanceUrl.pathname = '/postgres';

  // BD efímera: mismo servidor, base nueva, conservando los query params (schema, etc.).
  const ephemeralUrl = new URL(baseUrl);
  ephemeralUrl.pathname = `/${dbName}`;

  // 1. Crear la base (CREATE DATABASE no puede ir en una transacción).
  const admin = new PrismaClient({ datasources: { db: { url: maintenanceUrl.toString() } } });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    console.error(
      '\n[e2e] No se pudo crear la base de datos descartable para los tests.\n' +
        `      Motivo: ${motivo}\n` +
        '      Revisá que:\n' +
        `        · Postgres esté corriendo y accesible en ${maintenanceUrl.host};\n` +
        '        · las credenciales de DATABASE_URL sean correctas;\n' +
        '        · el usuario de DATABASE_URL tenga permiso para crear bases (CREATEDB).\n' +
        '      Los tests e2e crean una base descartable por corrida; sin ese permiso no se pueden ejecutar.\n',
    );
    throw err;
  } finally {
    await admin.$disconnect();
  }

  // A partir de acá la base efímera YA existe. Si cualquier paso siguiente falla, hay que
  // dropearla ANTES de propagar el error: Jest no corre el globalTeardown cuando el globalSetup
  // falla, así que sin esta limpieza quedaría una base de prueba huérfana por cada corrida fallida.
  try {
    // 2. Migraciones + seed base contra la efímera (Prisma CLI, ya presente en el proyecto).
    const childEnv = { ...process.env, DATABASE_URL: ephemeralUrl.toString() };
    execSync('npx prisma migrate deploy', { cwd: API_DIR, env: childEnv, stdio: 'inherit' });
    execSync('npx prisma db seed', { cwd: API_DIR, env: childEnv, stdio: 'inherit' });

    // 2.5 Vhost de RabbitMQ efímero para aislar el broker (best-effort; ver la función).
    const rabbit = await setupEphemeralVhost(suffix);

    // 2.6 Si NO se pudo aislar, fallar rápido y claro ante un consumidor competidor (ver función),
    //     en vez de dejar que los CHAT-* se cuelguen hasta el timeout del simulate.
    if (!rabbit) {
      await assertNoCompetingSimulateConsumer();
    }

    // 3. Handoff para los workers (setup-env.ts) y el teardown.
    fs.writeFileSync(
      HANDOFF_FILE,
      JSON.stringify({
        dbName,
        dbUrl: ephemeralUrl.toString(),
        maintenanceUrl: maintenanceUrl.toString(),
        ...(rabbit ?? {}),
      }),
      'utf8',
    );
    process.env.DATABASE_URL = ephemeralUrl.toString();
    if (rabbit) process.env.RABBITMQ_URL = rabbit.rabbitUrl;

    console.log(`\n[e2e] Base de datos efímera creada: ${dbName}`);
    if (rabbit) console.log(`[e2e] Vhost de RabbitMQ efímero creado: ${rabbit.vhost}`);
  } catch (err) {
    // Limpieza best-effort: borrar el handoff (si se llegó a escribir) y dropear la base efímera,
    // para no dejar residuos de una preparación a medias. No enmascaramos el error original.
    try {
      if (fs.existsSync(HANDOFF_FILE)) fs.unlinkSync(HANDOFF_FILE);
    } catch {
      /* la limpieza del handoff no debe tapar el error real */
    }
    await dropEphemeralDatabaseQuietly(maintenanceUrl.toString(), dbName);
    throw err;
  }
}
