/**
 * Crea o dropea la base de datos EFÍMERA de los tests e2e. Se invoca como subproceso desde
 * `ephemeral-stack.ts` (`node db-admin.cjs create|drop`) en vez de importar Prisma dentro del
 * paquete `web`: `@prisma/client` vive en `apps/api`, así que lo cargamos por ruta ABSOLUTA
 * (`PCI_PRISMA_CLIENT_PATH`). Ejecutarlo como subproceso, además, aísla la conexión de
 * mantenimiento del proceso de Playwright.
 *
 * Parámetros por entorno (para no meter datos dinámicos en la línea de comando):
 *   - PCI_PRISMA_CLIENT_PATH: ruta a `apps/api/node_modules/@prisma/client`.
 *   - PCI_MAINT_URL: URL a la base de mantenimiento `postgres` (para poder crear/dropear otra).
 *   - PCI_DB_NAME: nombre de la base efímera.
 * Y el primer argumento: `create` | `drop`.
 */
const clientPath = process.env.PCI_PRISMA_CLIENT_PATH;
const maintUrl = process.env.PCI_MAINT_URL;
const dbName = process.env.PCI_DB_NAME;
const action = process.argv[2];

if (!clientPath || !maintUrl || !dbName || !action) {
  console.error('[e2e] db-admin.cjs: faltan PCI_PRISMA_CLIENT_PATH, PCI_MAINT_URL, PCI_DB_NAME o la acción.');
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require(clientPath);

(async () => {
  const admin = new PrismaClient({ datasources: { db: { url: maintUrl } } });
  try {
    if (action === 'create') {
      // CREATE DATABASE no puede ir dentro de una transacción.
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    } else if (action === 'drop') {
      // Postgres no borra una base en uso: cortar conexiones colgadas antes del DROP.
      await admin.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
      );
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
    } else {
      throw new Error(`Acción desconocida: ${action}`);
    }
  } finally {
    await admin.$disconnect();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
