/**
 * setupFiles de los tests e2e: corre en cada worker ANTES de cargar los módulos del test, y
 * apunta `DATABASE_URL` a la base efímera que dejó `global-setup.ts`. Así el `PrismaService`
 * de la app se conecta a la BD de test, nunca a la real.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HANDOFF_FILE = path.join(os.tmpdir(), 'pci-e2e-db.json');

if (fs.existsSync(HANDOFF_FILE)) {
  const { dbUrl } = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
  if (dbUrl) process.env.DATABASE_URL = dbUrl;
}
