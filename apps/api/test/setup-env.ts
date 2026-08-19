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

const HANDOFF_FILE = path.join(os.tmpdir(), 'pci-e2e-db.json');

if (fs.existsSync(HANDOFF_FILE)) {
  const { dbUrl, rabbitUrl } = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
  if (dbUrl) process.env.DATABASE_URL = dbUrl;
  // Ausente si el vhost efímero no se pudo crear: en ese caso se conserva el del `.env`.
  if (rabbitUrl) process.env.RABBITMQ_URL = rabbitUrl;
}
