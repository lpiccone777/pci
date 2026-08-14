#!/usr/bin/env node
/**
 * Chequeo de conectividad + catálogo de InvGate, por consola.
 *
 * Corre fuera de Nest (no arranca el backend) — solo lee `apps/api/.env` a mano y le
 * pega directo a `{INVGATE_API_URL}/api/v1`. Nota (2026-08-14): el backend real ya no lee
 * las credenciales de acá — viven en `/settings > Integración: InvGate` (BD). Este script
 * sigue leyendo `.env` a propósito, para poder probar conectividad sin depender de la BD ni
 * de un backend levantado; si querés probar los valores que están en BD, cargalos temporal
 * acá o consultalos con `SELECT * FROM "Setting" WHERE key LIKE 'INVGATE_%'`. Sirve para:
 *   1. Confirmar que INVGATE_API_URL/USER/KEY funcionan antes de prender el conector real.
 *   2. Listar los IDs de categoría/prioridad/tipo/fuente de ESTA instancia, para completar
 *      INVGATE_DEFAULT_CATEGORY_ID/PRIORITY_ID/TYPE_ID/SOURCE_ID en `/settings` — no hay un
 *      valor universal, son específicos de cada instalación de InvGate.
 *
 *   pnpm --filter api invgate:check
 *   pnpm --filter api invgate:check -- --find-user +5491100000001
 *   pnpm --filter api invgate:check -- --find-user chatbot_test --by username
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  head: (s) => `\x1b[1m${s}\x1b[0m`,
};

function loadEnv() {
  let text;
  try {
    text = readFileSync(ENV_PATH, 'utf8');
  } catch {
    console.error(c.err(`No se pudo leer ${ENV_PATH}`));
    process.exit(1);
  }
  const env = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();
const baseUrl = (env.INVGATE_API_URL || '').replace(/\/+$/, '');
const user = env.INVGATE_API_USER;
const token = env.INVGATE_API_KEY;

if (!baseUrl || !user || !token) {
  console.error(c.err('Faltan INVGATE_API_URL / INVGATE_API_USER / INVGATE_API_KEY en apps/api/.env'));
  process.exit(1);
}

const auth = Buffer.from(`${user}:${token}`).toString('base64');

async function get(endpoint, params = {}) {
  const url = new URL(`${baseUrl}/api/v1/${endpoint}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined; // 401/error devuelve el HTML de login, no JSON
  }
  if (!res.ok) {
    const message = body?.error || body?.info || `HTTP ${res.status} (respuesta no-JSON, ¿token inválido?)`;
    throw new Error(message);
  }
  return body;
}

function asList(value) {
  if (Array.isArray(value)) return value;
  const data = value?.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return Object.values(data);
  return [];
}

function printTable(title, entries) {
  console.log(c.head(`\n${title}`));
  if (!entries.length) {
    console.log(c.dim('  (vacío)'));
    return;
  }
  for (const e of entries) console.log(`  ${String(e.id).padStart(4)}  ${e.name ?? '(sin nombre)'}`);
}

async function main() {
  console.log(`Probando ${baseUrl}/api/v1 como '${user}'...`);
  try {
    await get('incident.attributes.priority');
  } catch (err) {
    console.error(c.err(`\nFalló la autenticación: ${err.message}`));
    console.error(
      c.dim(
        'Confirmá que INVGATE_API_KEY sea el token de API del usuario técnico (no la contraseña ' +
          'de portal) y que ese usuario tenga acceso a la API habilitado en InvGate.',
      ),
    );
    process.exit(1);
  }
  console.log(c.ok('Autenticación OK.\n'));

  const [priorities, statuses, types, sources] = await Promise.all([
    get('incident.attributes.priority').then(asList),
    get('incident.attributes.status').then(asList),
    get('incident.attributes.type').then(asList),
    get('incident.attributes.source').then(asList),
  ]);
  const categories = asList(await get('incident.attributes.category', { page_size: '20' }));

  printTable('Prioridades (INVGATE_DEFAULT_PRIORITY_ID)', priorities);
  printTable('Tipos (INVGATE_DEFAULT_TYPE_ID)', types);
  printTable('Fuentes (INVGATE_DEFAULT_SOURCE_ID, opcional)', sources);
  printTable('Categorías — primeras 20 (INVGATE_DEFAULT_CATEGORY_ID)', categories);
  console.log(c.dim('\nEstados (referencia, no hace falta cargarlo en .env):'));
  printTable('Estados', statuses);

  const findQuery = arg('find-user');
  if (findQuery) {
    const by = arg('by', 'phone'); // phone | username | email
    const paramKey = by === 'phone' ? 'phones' : by;
    console.log(c.head(`\nBuscando usuario por ${by}='${findQuery}'...`));
    const result = await get('users.by', { [paramKey]: findQuery, exact_match: 'true' });
    const found = Object.values(result?.data ?? {});
    if (!found.length) {
      console.log(c.dim('  Sin resultados.'));
    } else {
      for (const u of found) console.log(`  id=${u.id}  ${u.username ?? ''}  ${u.email ?? ''}`);
    }
  }
}

main().catch((err) => {
  console.error(c.err(`\nError: ${err.message}`));
  process.exit(1);
});
