import { defineConfig, devices } from '@playwright/test';

/**
 * Config mínima de Playwright para los tests end-to-end del backoffice.
 * La app se levanta aparte (`pnpm dev:api` + `pnpm dev:web`); acá solo apuntamos
 * al front y corremos contra Chromium.
 */
export default defineConfig({
  testDir: './e2e',
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
