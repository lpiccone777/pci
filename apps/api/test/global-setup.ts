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
const HANDOFF_FILE = path.join(os.tmpdir(), 'pci-e2e-db.json');

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

export default async function globalSetup(): Promise<void> {
  const baseUrl = readEnvVar('DATABASE_URL');
  if (!baseUrl) {
    throw new Error(
      '[e2e] No se encontró DATABASE_URL (ni en el entorno ni en apps/api/.env). Es necesaria para crear la BD de test.',
    );
  }

  const dbName = `pci_test_${Date.now()}_${process.pid}`;

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

  // 2. Migraciones + seed base contra la efímera (Prisma CLI, ya presente en el proyecto).
  const childEnv = { ...process.env, DATABASE_URL: ephemeralUrl.toString() };
  execSync('npx prisma migrate deploy', { cwd: API_DIR, env: childEnv, stdio: 'inherit' });
  execSync('npx prisma db seed', { cwd: API_DIR, env: childEnv, stdio: 'inherit' });

  // 3. Handoff para los workers (setup-env.ts) y el teardown.
  fs.writeFileSync(
    HANDOFF_FILE,
    JSON.stringify({
      dbName,
      dbUrl: ephemeralUrl.toString(),
      maintenanceUrl: maintenanceUrl.toString(),
    }),
    'utf8',
  );
  process.env.DATABASE_URL = ephemeralUrl.toString();

  console.log(`\n[e2e] Base de datos efímera creada: ${dbName}`);
}
