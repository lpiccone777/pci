/**
 * Bloque 3.2 del plan de pruebas — Login y OTP (2FA).
 *
 * Casos FE-LOG-01..07. Corren contra el web aislado (`localhost:3100`) que levanta el
 * `global-setup`; la siembra de datos y el toggle de OTP van por la API real (`localhost:3101`)
 * como el SuperAdmin del seed (ver `support/seed.ts`).
 *
 * Serial a propósito: `OTP_ENABLED` es un setting GLOBAL (una sola base por corrida), así que los
 * tests que lo prenden/apagan no pueden pisarse entre sí. Cada test fija el estado que necesita.
 */
import { test, expect } from '@playwright/test';
import {
  adminContext,
  apiLogin,
  createUser,
  createRole,
  setSetting,
  deleteSetting,
  SEED_ADMIN,
  SEED_USER_AGENT,
  type AdminCtx,
} from './support/seed';
import { apiLogMark, waitForOtpCode } from './support/api-log';

test.describe.configure({ mode: 'serial' });

let admin: AdminCtx;

test.beforeAll(async () => {
  admin = await adminContext();
});

test.afterAll(async () => {
  // Dejar el setting global como estaba (resuelve por env/default). Best-effort.
  try {
    await deleteSetting(admin, 'OTP_ENABLED');
  } catch {
    /* si nunca se fijó, no importa */
  }
});

/**
 * Crea un usuario de sistema y le PRE-REGISTRA un dispositivo con el User-Agent de siembra,
 * distinto del Chromium del navegador. Con OTP prendido, su login por la UI queda con un
 * fingerprint que no matchea → el backend responde `otp_required` (única vía para llegar a la
 * vista OTP). Devuelve las credenciales del usuario.
 */
async function userWithForeignDevice() {
  const role = await createRole(admin, { permissions: ['users:read'] });
  const user = await createUser(admin, {
    memberships: [{ tenantId: admin.systemTenantId, roleId: role.id }],
  });
  // Primer login (sin devices) con OTP prendido: registra el device para ESTE UA y devuelve
  // token, sin pedir OTP. Deja al usuario con un dispositivo "ajeno" al del navegador.
  const res = await apiLogin(user.email, user.password, { userAgent: SEED_USER_AGENT });
  expect(res.step).toBe('authenticated');
  return user;
}

test('FE-LOG-01: login correcto con OTP deshabilitado guarda el token y entra al dashboard', async ({
  page,
}) => {
  await setSetting(admin, 'OTP_ENABLED', 'false');

  await page.goto('/login');
  await page.locator('#login-email').fill(SEED_ADMIN.email);
  await page.locator('#login-password').fill(SEED_ADMIN.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();

  await expect(page).toHaveURL(/\/dashboard\/?$/);
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeTruthy();
});

test('FE-LOG-02: login con credenciales incorrectas muestra el error del backend y no entra', async ({
  page,
}) => {
  await setSetting(admin, 'OTP_ENABLED', 'false');

  await page.goto('/login');
  await page.locator('#login-email').fill(SEED_ADMIN.email);
  await page.locator('#login-password').fill('contraseña-incorrecta');
  await page.getByRole('button', { name: 'Ingresar' }).click();

  // El backend responde 401 "Credenciales inválidas"; la pantalla lo muestra en el banner rojo.
  await expect(page.getByText('Credenciales inválidas')).toBeVisible();
  await expect(page).toHaveURL(/\/login\/?$/);
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
});

test('FE-LOG-03: un login que responde otp_required pasa a la vista de OTP con el aviso', async ({
  page,
}) => {
  await setSetting(admin, 'OTP_ENABLED', 'true');
  const user = await userWithForeignDevice();

  await page.goto('/login');
  await page.locator('#login-email').fill(user.email);
  await page.locator('#login-password').fill(user.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();

  await expect(page.getByText('Se envió un código de verificación a tu email')).toBeVisible();
  await expect(page.locator('#login-otp')).toBeVisible();
  await expect(page).toHaveURL(/\/login\/?$/);
});

test('FE-LOG-04: ingresar el código OTP correcto verifica, guarda el token y entra al panel', async ({
  page,
}) => {
  await setSetting(admin, 'OTP_ENABLED', 'true');
  const user = await userWithForeignDevice();

  // Marca del log ANTES de disparar el login: el OTP se genera cuando el backend responde
  // otp_required, así se lee solo el código de esta corrida y no uno viejo.
  const mark = apiLogMark();

  await page.goto('/login');
  await page.locator('#login-email').fill(user.email);
  await page.locator('#login-password').fill(user.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();

  await expect(page.locator('#login-otp')).toBeVisible();

  const code = await waitForOtpCode(mark);
  await page.locator('#login-otp').fill(code);
  await page.getByRole('button', { name: 'Verificar' }).click();

  await expect(page).toHaveURL(/\/dashboard\/?$/);
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeTruthy();
});

test('FE-LOG-05: "Volver a credenciales" no limpia el código ni el banner de error ya tipeados', async ({
  page,
}) => {
  await setSetting(admin, 'OTP_ENABLED', 'true');
  const user = await userWithForeignDevice();

  await page.goto('/login');
  await page.locator('#login-email').fill(user.email);
  await page.locator('#login-password').fill(user.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page.locator('#login-otp')).toBeVisible();

  // Un código inválido para forzar el banner de error en la vista OTP.
  await page.locator('#login-otp').fill('000000');
  await page.getByRole('button', { name: 'Verificar' }).click();
  const errorBanner = page.locator('.bg-red-100');
  await expect(errorBanner).toBeVisible();

  await page.getByRole('button', { name: 'Volver a credenciales' }).click();

  // Vuelve al primer paso (campos de credenciales visibles)...
  await expect(page.locator('#login-email')).toBeVisible();
  // ...pero el banner de error NO se limpió (comportamiento actual documentado en el plan).
  await expect(errorBanner).toBeVisible();
});

test('FE-LOG-06: el botón queda deshabilitado mientras la request está en curso (no doble submit)', async ({
  page,
}) => {
  await setSetting(admin, 'OTP_ENABLED', 'false');

  // Retenemos la respuesta del login para observar el estado "en curso" sin carrera.
  await page.route('**/auth/login', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  await page.goto('/login');
  await page.locator('#login-email').fill(SEED_ADMIN.email);
  await page.locator('#login-password').fill(SEED_ADMIN.password);
  const button = page.getByRole('button', { name: 'Ingresar' });
  await button.click();

  // Mientras `loading`, el botón cambia a "Ingresando..." y queda deshabilitado.
  const pending = page.getByRole('button', { name: 'Ingresando...' });
  await expect(pending).toBeVisible();
  await expect(pending).toBeDisabled();

  // Se libera y termina entrando al panel.
  await expect(page).toHaveURL(/\/dashboard\/?$/);
});

test('FE-LOG-07: el campo OTP acepta hasta 8 dígitos (OTP_CODE_LENGTH configurable)', async ({
  page,
}) => {
  await setSetting(admin, 'OTP_ENABLED', 'true');
  const user = await userWithForeignDevice();

  await page.goto('/login');
  await page.locator('#login-email').fill(user.email);
  await page.locator('#login-password').fill(user.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();

  const otp = page.locator('#login-otp');
  await expect(otp).toBeVisible();
  await otp.fill('');
  await otp.pressSequentially('1234567890'); // 10 dígitos: el maxLength=8 trunca al tipear
  await expect(otp).toHaveValue('12345678');
});
