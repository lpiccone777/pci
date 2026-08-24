/**
 * Orquesta el stack AISLADO de los tests e2e de Playwright: una base de datos efímera, un vhost
 * de RabbitMQ efímero, y una API + un web propios apuntados a ellos. Todo se crea al empezar
 * (`prepareStack`) y se destruye al terminar (`teardownStack`), sin tocar la base, el broker ni
 * los servidores de desarrollo.
 *
 * Por qué manejamos los procesos acá y no con la opción `webServer` de Playwright: el runner
 * arranca los plugins (incluido `webServer`) ANTES del `globalSetup`, así que un `webServer`
 * levantaría la API antes de que exista la base efímera. Al arrancarlos nosotros dentro del
 * setup, ya tenemos la URL de la base y del vhost calculadas.
 *
 * Espejo del setup e2e del backend (`apps/api/test/global-setup.ts`), del que se reusa el
 * patrón (no el código, para no acoplar los dos paquetes).
 */
import { spawn, execSync, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { API_PORT, WEB_PORT, API_URL, WEB_URL } from './ports';

const SUPPORT_DIR = __dirname;
// apps/web/e2e/support -> repo root (cuatro niveles arriba).
const REPO_ROOT = path.resolve(SUPPORT_DIR, '..', '..', '..', '..');
const API_DIR = path.join(REPO_ROOT, 'apps', 'api');
const IS_WINDOWS = process.platform === 'win32';

function log(msg: string): void {
  console.log(`[e2e] ${msg}`);
}

/** Lee una variable primero del entorno y, si no está, del `.env` de apps/api (parseo mínimo). */
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

// ---------------------------------------------------------------------------
// Base de datos efímera
// ---------------------------------------------------------------------------

interface DbInfo {
  dbName: string;
  dbUrl: string;
  maintenanceUrl: string;
  suffix: string;
}

function runDbAdmin(action: 'create' | 'drop', maintenanceUrl: string, dbName: string): void {
  const clientPath = path.join(API_DIR, 'node_modules', '@prisma', 'client');
  execFileSync(process.execPath, [path.join(SUPPORT_DIR, 'db-admin.cjs'), action], {
    env: {
      ...process.env,
      PCI_PRISMA_CLIENT_PATH: clientPath,
      PCI_MAINT_URL: maintenanceUrl,
      PCI_DB_NAME: dbName,
    },
    stdio: 'inherit',
  });
}

function createDatabase(): DbInfo {
  const baseUrl = readEnvVar('DATABASE_URL');
  if (!baseUrl) {
    throw new Error('[e2e] No se encontró DATABASE_URL (ni en el entorno ni en apps/api/.env).');
  }

  const suffix = `${Date.now()}_${process.pid}`;
  const dbName = `pci_e2e_${suffix}`;

  const maintenanceUrl = new URL(baseUrl);
  maintenanceUrl.pathname = '/postgres';
  const dbUrl = new URL(baseUrl);
  dbUrl.pathname = `/${dbName}`;

  runDbAdmin('create', maintenanceUrl.toString(), dbName);
  log(`Base de datos efímera creada: ${dbName}`);

  return {
    dbName,
    dbUrl: dbUrl.toString(),
    maintenanceUrl: maintenanceUrl.toString(),
    suffix,
  };
}

function migrateAndSeed(dbUrl: string): void {
  const env = { ...process.env, DATABASE_URL: dbUrl };
  execSync('npx prisma migrate deploy', { cwd: API_DIR, env, stdio: 'inherit' });
  execSync('npx prisma db seed', { cwd: API_DIR, env, stdio: 'inherit' });
  log('Migraciones y seed aplicados sobre la base efímera.');
}

function dropDatabaseQuietly(maintenanceUrl: string, dbName: string): void {
  try {
    runDbAdmin('drop', maintenanceUrl, dbName);
    log(`Base de datos efímera eliminada: ${dbName}`);
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    console.warn(`[e2e] No se pudo eliminar la base efímera ${dbName} (${motivo}).`);
  }
}

// ---------------------------------------------------------------------------
// Vhost de RabbitMQ efímero
// ---------------------------------------------------------------------------

interface RabbitInfo {
  vhost: string;
  rabbitUrl: string;
  rabbitMgmt: { baseUrl: string; user: string; pass: string };
}

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
 * Crea un vhost de RabbitMQ efímero y le da permisos totales al usuario.
 *
 * Fail-closed: si HAY un broker configurado (`RABBITMQ_URL`) pero no se puede aislar (URL inválida
 * o falla el management, p. ej. sin el plugin), TIRA un error y corta la corrida. Nunca cae al
 * vhost compartido del `.env`: hacerlo pondría a la API de test y a la de desarrollo a competir por
 * las mismas colas, y un mensaje entrante podría procesarlo el proceso equivocado. Devuelve `null`
 * solo cuando no hay `RABBITMQ_URL` (no hay nada que aislar ni que compartir).
 */
async function createVhost(suffix: string): Promise<RabbitInfo | null> {
  const baseRabbitUrl = readEnvVar('RABBITMQ_URL');
  if (!baseRabbitUrl) {
    console.warn('[e2e] RABBITMQ_URL no encontrada; la API corre sobre el broker por defecto.');
    return null;
  }

  let amqpUrl: URL;
  try {
    amqpUrl = new URL(baseRabbitUrl);
  } catch {
    throw new Error(
      '[e2e] RABBITMQ_URL no es una URL válida: no se puede aislar el broker y no se cae al ' +
        'vhost compartido para no interferir con la API de desarrollo. Corregí RABBITMQ_URL.',
    );
  }

  const user = amqpUrl.username ? decodeURIComponent(amqpUrl.username) : 'guest';
  const pass = amqpUrl.password ? decodeURIComponent(amqpUrl.password) : 'guest';
  const baseUrl = process.env.RABBITMQ_MANAGEMENT_URL || `http://${amqpUrl.hostname}:15672`;
  const vhost = `pci_e2e_${suffix}`;
  const rabbitMgmt = { baseUrl, user, pass };

  try {
    await rabbitMgmtRequest(rabbitMgmt, 'PUT', `/api/vhosts/${encodeURIComponent(vhost)}`);
    await rabbitMgmtRequest(
      rabbitMgmt,
      'PUT',
      `/api/permissions/${encodeURIComponent(vhost)}/${encodeURIComponent(user)}`,
      { configure: '.*', write: '.*', read: '.*' },
    );
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[e2e] No se pudo crear el vhost de RabbitMQ efímero (${motivo}).\n` +
        '      No se cae al vhost compartido del .env para no interferir con la API de desarrollo\n' +
        '      (compartir colas haría que un mensaje entrante lo procese el proceso equivocado).\n' +
        '      Verificá que el plugin de management del broker esté habilitado y accesible.',
    );
  }

  const ephemeral = new URL(baseRabbitUrl);
  ephemeral.pathname = `/${vhost}`;
  log(`Vhost de RabbitMQ efímero creado: ${vhost}`);
  return { vhost, rabbitUrl: ephemeral.toString(), rabbitMgmt };
}

async function deleteVhostQuietly(rabbit: RabbitInfo): Promise<void> {
  try {
    await rabbitMgmtRequest(rabbit.rabbitMgmt, 'DELETE', `/api/vhosts/${encodeURIComponent(rabbit.vhost)}`);
    log(`Vhost de RabbitMQ efímero eliminado: ${rabbit.vhost}`);
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    console.warn(`[e2e] No se pudo eliminar el vhost efímero ${rabbit.vhost} (${motivo}).`);
  }
}

// ---------------------------------------------------------------------------
// Procesos (API + web) y espera de disponibilidad
// ---------------------------------------------------------------------------

function startProcess(name: string, command: string, env: NodeJS.ProcessEnv): ChildProcess {
  // El comando va como un único string (no como arreglo de args) para evitar el
  // DeprecationWarning de Node al combinar args con `shell: true`. El shell es necesario para
  // resolver `pnpm` (en Windows es `pnpm.cmd`); los comandos son literales fijos, sin datos
  // externos, así que la concatenación es segura.
  const child = spawn(command, {
    cwd: REPO_ROOT,
    env,
    shell: true,
    stdio: 'inherit',
  });
  child.on('error', (err) => {
    console.error(`[e2e] Falló el arranque de ${name}: ${err.message}`);
  });
  return child;
}

function stopProcess(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined || child.killed) return;
  try {
    if (IS_WINDOWS) {
      // `shell: true` hace que child.pid sea el del shell; `/T` mata todo el árbol (incluido node).
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* best-effort: si ya murió, no importa */
  }
}

/** Espera hasta que `url` responda. `until: 'ok'` exige 2xx; `'reachable'` acepta cualquier respuesta. */
async function waitForHttp(
  url: string,
  opts: { timeoutMs: number; until: 'ok' | 'reachable'; label: string },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastError = 'sin respuesta';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (opts.until === 'reachable' || res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`[e2e] ${opts.label} no respondió en ${opts.timeoutMs}ms (${lastError}).`);
}

// ---------------------------------------------------------------------------
// API pública: prepareStack / teardownStack
// ---------------------------------------------------------------------------

export interface Stack {
  db: DbInfo;
  rabbit: RabbitInfo | null;
  apiProc?: ChildProcess;
  webProc?: ChildProcess;
}

export async function prepareStack(): Promise<Stack> {
  const db = createDatabase();
  // A partir de acá la base YA existe: si algo falla, hay que limpiarla antes de propagar.
  const stack: Stack = { db, rabbit: null };
  try {
    migrateAndSeed(db.dbUrl);
    stack.rabbit = await createVhost(db.suffix);

    // Solo el vhost efímero. Si `createVhost` no pudo aislar, ya tiró error arriba; si devolvió
    // `null` es porque no hay RABBITMQ_URL configurada (nada que aislar), y entonces la API arranca
    // con su broker por defecto. Nunca se comparte el vhost del .env con la API de desarrollo.
    const rabbitUrl = stack.rabbit?.rabbitUrl;

    log(`Levantando API aislada en el puerto ${API_PORT}...`);
    // `start:e2e` (no `start`) compila la API en un `dist` propio (`dist-e2e`) en vez del `dist`
    // que usa el dev server (`start:dev`, en watch). Con `deleteOutDir`, un `nest start` común
    // borraría ese `dist` compartido y tiraría abajo la API de desarrollo que corre en paralelo.
    stack.apiProc = startProcess('api', 'pnpm --filter api run start:e2e', {
      ...process.env,
      PORT: String(API_PORT),
      DATABASE_URL: db.dbUrl,
      ...(rabbitUrl ? { RABBITMQ_URL: rabbitUrl } : {}),
    });

    // Next 16 (Turbopack) no deja correr un segundo `next dev` para el mismo proyecto cuando ya
    // hay uno (el dev server local en el 3000). Por eso el web aislado se COMPILA y se sirve en
    // modo producción (`build` + `start`), en un `distDir` propio para no pisar el `.next` del dev.
    // `NEXT_PUBLIC_API_URL` se hornea en el build, así que el bundle del cliente ya apunta a la
    // API aislada.
    const webEnv = { NEXT_DIST_DIR: '.next-e2e', NEXT_PUBLIC_API_URL: API_URL };
    // tsconfig descartable para el build e2e: Next le agrega sus tipos a ESTE (gitignoreado) en
    // vez de reescribir el `tsconfig.json` versionado de la app. Solo extiende al real.
    fs.writeFileSync(
      path.join(REPO_ROOT, 'apps', 'web', 'tsconfig.e2e.json'),
      JSON.stringify({ extends: './tsconfig.json' }, null, 2) + '\n',
    );
    log('Compilando el web aislado (build de producción)...');
    execSync('pnpm --filter web run build', {
      cwd: REPO_ROOT,
      env: { ...process.env, ...webEnv },
      stdio: 'inherit',
    });

    log(`Levantando web aislado en el puerto ${WEB_PORT}...`);
    stack.webProc = startProcess('web', 'pnpm --filter web run start', {
      ...process.env,
      ...webEnv,
      PORT: String(WEB_PORT),
    });

    // La API primero: el web la necesita. Nest compila y arranca; damos margen amplio.
    await waitForHttp(API_URL, { timeoutMs: 120_000, until: 'reachable', label: 'La API aislada' });
    log('API aislada lista.');
    // El web ya viene compilado (build de producción); esperar un 200 en /login solo confirma que
    // el server terminó de levantar y está listo para atender (no compila nada en esa request).
    await waitForHttp(`${WEB_URL}/login`, { timeoutMs: 120_000, until: 'ok', label: 'El web aislado' });
    log('Web aislado listo.');

    return stack;
  } catch (err) {
    // Limpieza best-effort de todo lo que se haya creado, sin tapar el error real.
    await teardownStack(stack);
    throw err;
  }
}

export async function teardownStack(stack: Stack): Promise<void> {
  stopProcess(stack.webProc);
  stopProcess(stack.apiProc);
  if (stack.rabbit) await deleteVhostQuietly(stack.rabbit);
  dropDatabaseQuietly(stack.db.maintenanceUrl, stack.db.dbName);
}
