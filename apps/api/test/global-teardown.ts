/**
 * globalTeardown de los tests e2e: dropea la base de datos efímera que creó `global-setup.ts`.
 *
 * Corta las conexiones colgadas antes del DROP (Postgres no borra una base en uso) y usa la
 * base de mantenimiento `postgres` para poder dropear la efímera. No deja rastro en el servidor.
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HANDOFF_FILE = path.join(os.tmpdir(), 'pci-e2e-db.json');

export default async function globalTeardown(): Promise<void> {
  if (!fs.existsSync(HANDOFF_FILE)) return;
  const { dbName, maintenanceUrl } = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
  if (!dbName || !maintenanceUrl) return;

  const admin = new PrismaClient({ datasources: { db: { url: maintenanceUrl } } });
  try {
    // Cortar conexiones a la efímera antes de dropearla.
    await admin.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
    );
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.$disconnect();
  }

  fs.unlinkSync(HANDOFF_FILE);
  console.log(`\n[e2e] Base de datos efímera eliminada: ${dbName}`);
}
