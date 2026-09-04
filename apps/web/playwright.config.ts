import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from './e2e/support/ports';

/**
 * Config de Playwright para los tests e2e del backoffice.
 *
 * Aislamiento total: `global-setup.ts` levanta un stack propio (base de datos y vhost de RabbitMQ
 * efímeros + API y web en puertos dedicados, ver `e2e/support/ports.ts`) y lo destruye al
 * terminar. No hay que levantar nada a mano ni apunta a la base de desarrollo.
 */
export default defineConfig({
  testDir: './e2e',
  reporter: 'list',
  // Margen amplio: la primera navegación puede esperar la compilación on-demand de Next.
  timeout: 60_000,
  // Un reintento: todos los tests comparten un único server, así que las aserciones de
  // visibilidad (menús/botones por permiso) pueden perder la carrera del timeout bajo carga.
  // El reintento absorbe esa flakiness sin tapar una falla real (que falla también al reintentar).
  retries: 1,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: WEB_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
