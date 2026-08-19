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
  const { dbName, maintenanceUrl, vhost, rabbitMgmt } = JSON.parse(
    fs.readFileSync(HANDOFF_FILE, 'utf8'),
  );

  // Borrar el vhost efímero de RabbitMQ (si se creó). El DELETE cierra de una las conexiones
  // que hubiera abiertas contra él. Best-effort: un fallo acá no debe tumbar el teardown de la
  // base; a lo sumo queda un vhost vacío huérfano, inocuo.
  if (vhost && rabbitMgmt) {
    try {
      const auth = Buffer.from(`${rabbitMgmt.user}:${rabbitMgmt.pass}`).toString('base64');
      const res = await fetch(
        `${rabbitMgmt.baseUrl}/api/vhosts/${encodeURIComponent(vhost)}`,
        { method: 'DELETE', headers: { Authorization: `Basic ${auth}` } },
      );
      if (res.ok) {
        console.log(`\n[e2e] Vhost de RabbitMQ efímero eliminado: ${vhost}`);
      } else {
        console.warn(`[e2e] No se pudo eliminar el vhost efímero ${vhost} (HTTP ${res.status}).`);
      }
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      console.warn(`[e2e] No se pudo eliminar el vhost efímero ${vhost} (${motivo}).`);
    }
  }

  if (!dbName || !maintenanceUrl) {
    fs.unlinkSync(HANDOFF_FILE);
    return;
  }

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
