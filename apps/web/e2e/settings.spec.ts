/**
 * Bloque 3.8 del plan de pruebas — Configuración del sistema (`/settings`).
 *
 * Casos FE-SET-01..15. `/settings` es ruta raíz (fuera de `/dashboard`, comparte el sidebar),
 * gateada por `SystemTenantGuard` + `settings:read`: se opera como SuperAdmin del seed, parado en
 * la empresa de sistema. La siembra va por la API real (`localhost:3101`); la UI corre contra el
 * web aislado (`localhost:3100`).
 *
 * Los grupos del catálogo (`apps/api/src/modules/settings/settings.catalog.ts`) se muestran como
 * pestañas (`role="tab"`, nombre accesible = nombre del grupo; los puntitos de estado son
 * `aria-hidden`). Cada setting es una tarjeta `div.bg-white` con un input `id={KEY}`.
 *
 * FE-SET-10 queda BLOQUEADO: exige el backend levantado SIN `SETTINGS_ENCRYPTION_KEY`, y el stack
 * efímero la hereda de `apps/api/.env`, así que la condición no se puede reproducir acá.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  adminContext,
  apiLogin,
  createUserWithPermissions,
  setSetting,
  deleteSetting,
  uniqueSlug,
  type AdminCtx,
} from './support/seed';
import { injectSession } from './support/session';

let admin: AdminCtx;

test.beforeEach(async () => {
  admin = await adminContext();
});

async function sessionForUser(email: string, password: string, activeTenant: string) {
  const res = await apiLogin(email, password);
  expect(res.accessToken, 'el usuario común debería loguear sin OTP').toBeTruthy();
  return { token: res.accessToken as string, activeTenant };
}

/** La tarjeta (`div.bg-white`) que contiene el input de esa clave. */
function settingCard(page: Page, key: string) {
  return page.locator('div.bg-white').filter({ has: page.locator(`#${key}`) });
}

/** Activa la pestaña de un grupo por su nombre exacto. */
async function openTab(page: Page, group: string) {
  await page.getByRole('tab', { name: group, exact: true }).click();
}

test('FE-SET-01: como SuperAdmin de sistema carga /settings + /settings/providers/status y muestra las pestañas', async ({
  page,
}) => {
  const calls: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/settings/providers/status')) calls.push('status');
    else if (u.endsWith('/settings')) calls.push('settings');
  });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');

  await expect(page.getByRole('heading', { name: 'Configuración del sistema' })).toBeVisible();
  await expect(page.getByRole('tablist')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Autenticación y 2FA', exact: true })).toBeVisible();

  await expect.poll(() => calls.includes('status')).toBe(true);
  await expect.poll(() => calls.includes('settings')).toBe(true);
});

test('FE-SET-02: sin settings:update la pantalla queda en modo sólo lectura', async ({ page }) => {
  // Usuario de la empresa de sistema con settings:read (puede leer) pero SIN settings:update.
  const ro = await createUserWithPermissions(admin, ['settings:read']);
  await injectSession(page, await sessionForUser(ro.email, ro.password, admin.systemTenantId));
  await page.goto('/settings');

  await expect(
    page.getByText('Tenés acceso de solo lectura: falta el permiso', { exact: false }),
  ).toBeVisible();
  // Los inputs y el botón Guardar quedan deshabilitados.
  await expect(page.locator('#OTP_TTL_SECONDS')).toBeDisabled();
  await expect(
    settingCard(page, 'OTP_TTL_SECONDS').getByRole('button', { name: 'Guardar' }),
  ).toBeDisabled();
});

test('FE-SET-03: el badge de origen refleja de dónde sale cada valor (BD vs default)', async ({
  page,
}) => {
  await setSetting(admin, 'OTP_TTL_SECONDS', '120');

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings'); // arranca en "Autenticación y 2FA"

  // La clave sembrada resuelve por BD.
  await expect(settingCard(page, 'OTP_TTL_SECONDS').getByText('guardado en BD')).toBeVisible();
  // Una clave sin fila en BD ni env resuelve por su default del catálogo.
  await expect(settingCard(page, 'OTP_CODE_LENGTH').getByText('valor por defecto')).toBeVisible();
});

test('FE-SET-04: un secreto cargado muestra el enmascarado + isSet y el input arranca vacío', async ({
  page,
}) => {
  const secretValue = `sk-${uniqueSlug('secret')}`;
  await setSetting(admin, 'OPENAI_API_KEY', secretValue);

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');
  await openTab(page, 'LLM: OpenAI');

  const card = settingCard(page, 'OPENAI_API_KEY');
  // Estado "cargada: <enmascarado>" (isSet true).
  await expect(card.getByText('cargada:', { exact: false })).toBeVisible();
  // El input de escritura arranca vacío ("vacío = no tocar").
  await expect(page.locator('#OPENAI_API_KEY')).toHaveValue('');
  // Nunca aparece el valor real en pantalla.
  await expect(page.getByText(secretValue)).toHaveCount(0);
});

test('FE-SET-05: guardar un secreto nuevo persiste sin volver a mostrar el valor en claro', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');
  await openTab(page, 'LLM: OpenAI');

  const patchCalls: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/settings/OPENAI_API_KEY')) {
      patchCalls.push(r.url());
    }
  });

  const input = page.locator('#OPENAI_API_KEY');
  // El campo secreto se renderiza como password: el valor tipeado no queda a la vista.
  await expect(input).toHaveAttribute('type', 'password');
  await input.fill(`sk-${uniqueSlug('nueva')}`);
  await settingCard(page, 'OPENAI_API_KEY').getByRole('button', { name: 'Guardar' }).click();

  await expect(page.getByText('OPENAI_API_KEY actualizado.')).toBeVisible();
  await expect.poll(() => patchCalls.length).toBeGreaterThan(0);
  // Tras guardar, el input vuelve a vaciarse (no re-muestra el secreto) y aparece el "cargada".
  await expect(input).toHaveValue('');
  await expect(settingCard(page, 'OPENAI_API_KEY').getByText('cargada:', { exact: false })).toBeVisible();
});

test('FE-SET-06: "Restaurar" borra el valor de BD y la clave vuelve a resolver por env/default', async ({
  page,
}) => {
  await setSetting(admin, 'OTP_TTL_SECONDS', '120');

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');

  const card = settingCard(page, 'OTP_TTL_SECONDS');
  await expect(card.getByText('guardado en BD')).toBeVisible();

  const deleteCalls: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE' && r.url().includes('/settings/OTP_TTL_SECONDS')) {
      deleteCalls.push(r.url());
    }
  });

  await card.getByRole('button', { name: 'Restaurar' }).click();
  await expect(page.getByText('OTP_TTL_SECONDS volvió al valor', { exact: false })).toBeVisible();
  await expect.poll(() => deleteCalls.length).toBeGreaterThan(0);
  // Ya no resuelve por BD.
  await expect(settingCard(page, 'OTP_TTL_SECONDS').getByText('guardado en BD')).toHaveCount(0);
});

test('FE-SET-07: el dropdown de "Modelo" se llena y ofrece "Otro — escribir a mano"', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');
  await openTab(page, 'LLM: OpenAI');

  const select = page.locator('select#OPENAI_MODEL');
  await expect(select).toBeVisible();
  await expect(select.locator('option', { hasText: 'Otro — escribir a mano' })).toHaveCount(1);
  // Indica el origen de la lista: consultada al proveedor o lista conocida (fallback). Cualquiera
  // de las dos es válida según si hay una key que permita consultar la API del proveedor.
  await expect(
    settingCard(page, 'OPENAI_MODEL').getByText(
      /modelos consultados al proveedor|Lista conocida/,
    ),
  ).toBeVisible();
});

test('FE-SET-08: cambiar de pestaña de proveedor consulta sus modelos automáticamente', async ({
  page,
}) => {
  const modelCalls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/settings/providers/gemini/models')) modelCalls.push(r.url());
  });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');
  await openTab(page, 'LLM: Gemini');

  await expect.poll(() => modelCalls.length).toBeGreaterThan(0);
  await expect(page.locator('select#GEMINI_MODEL')).toBeVisible();
});

test('FE-SET-09: el punto de la pestaña marca el proveedor activo', async ({ page }) => {
  // Fijamos el proveedor activo para que el punto azul sea determinista.
  await setSetting(admin, 'LLM_PROVIDER', 'openai');

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');

  const openaiTab = page.getByRole('tab', { name: 'LLM: OpenAI', exact: true });
  await expect(openaiTab.locator('span[title="Proveedor activo"]')).toBeVisible();
});

test.skip('FE-SET-10: sin SETTINGS_ENCRYPTION_KEY el banner rojo aparece y el backend rechaza guardar secretos [BLOQUEADO: requiere el backend levantado SIN SETTINGS_ENCRYPTION_KEY; el stack efímero la hereda de apps/api/.env]', async ({
  page,
}) => {
  // Este caso necesita el backend corriendo sin la clave maestra de cifrado. El stack aislado la
  // toma de apps/api/.env, así que encryptionConfigured siempre da true y la condición no se
  // reproduce. Se deja escrito para cuando exista una variante del stack sin esa key.
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');
  await expect(
    page.getByText('Falta SETTINGS_ENCRYPTION_KEY en el backend', { exact: false }),
  ).toBeVisible();
});

test('FE-SET-11: al guardar la key de un proveedor el dropdown de modelos se refresca solo', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');
  await openTab(page, 'LLM: OpenAI');

  const refreshCalls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/settings/providers/openai/models') && r.url().includes('refresh=true')) {
      refreshCalls.push(r.url());
    }
  });

  await page.locator('#OPENAI_API_KEY').fill(`sk-${uniqueSlug('refresh')}`);
  await settingCard(page, 'OPENAI_API_KEY').getByRole('button', { name: 'Guardar' }).click();

  await expect(page.getByText('OPENAI_API_KEY actualizado.')).toBeVisible();
  // save() dispara loadModels(provider, refresh=true) al tocar la key.
  await expect.poll(() => refreshCalls.length).toBeGreaterThan(0);
});

test('FE-SET-12: "Otro — escribir a mano" abre input libre y conserva un modelo fuera del catálogo', async ({
  page,
}) => {
  const modeloRaro = `modelo-fuera-catalogo-${uniqueSlug('x')}`;
  await setSetting(admin, 'OPENAI_MODEL', modeloRaro);

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');
  await openTab(page, 'LLM: OpenAI');

  const select = page.locator('select#OPENAI_MODEL');
  await expect(select).toBeVisible();
  // El valor guardado, aunque no esté en la lista, se conserva marcado "(actual)".
  await expect(select.locator('option', { hasText: `${modeloRaro} (actual)` })).toHaveCount(1);

  // Elegir "Otro — escribir a mano" cambia a un input de texto libre, con el valor conservado.
  await select.selectOption('__custom__');
  const input = page.locator('input#OPENAI_MODEL');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(modeloRaro);
});

test('FE-SET-13: "Cancelar" revierte el draft al valor efectivo sin llamar al backend', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');

  const input = page.locator('#OTP_TTL_SECONDS');
  const original = await input.inputValue();

  const patchCalls: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/settings/OTP_TTL_SECONDS')) {
      patchCalls.push(r.url());
    }
  });

  await input.fill(String(Number(original) + 7));
  const card = settingCard(page, 'OTP_TTL_SECONDS');
  await card.getByRole('button', { name: 'Cancelar' }).click();

  await expect(input).toHaveValue(original);
  // Cancelar no toca el backend.
  expect(patchCalls).toHaveLength(0);
});

test('FE-SET-14: aparecen las pestañas de mensajería/InvGate con los secretos vacíos', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');

  for (const group of [
    'Mensajería: WhatsApp (Twilio)',
    'Mensajería: WhatsApp (Gupshup)',
    'Mensajería: SMS (Twilio)',
    'Mensajería: SMS (Gupshup)',
    'Integración: InvGate',
  ]) {
    await expect(page.getByRole('tab', { name: group, exact: true })).toBeVisible();
  }

  await openTab(page, 'Mensajería: WhatsApp (Twilio)');
  const token = page.locator('#TWILIO_AUTH_TOKEN');
  await expect(token).toHaveAttribute('type', 'password'); // 🔒 secret
  await expect(token).toHaveValue('');
  await expect(settingCard(page, 'TWILIO_AUTH_TOKEN').getByText('sin configurar')).toBeVisible();
});

test('FE-SET-15: los selectores de proveedor WHATSAPP_PROVIDER/SMS_PROVIDER son enum y avisan que requieren reiniciar', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');

  await openTab(page, 'Mensajería: WhatsApp');
  const waProvider = page.locator('select#WHATSAPP_PROVIDER');
  await expect(waProvider).toBeVisible();
  for (const value of ['meta', 'twilio', 'gupshup']) {
    await expect(waProvider.locator(`option[value="${value}"]`)).toHaveCount(1);
  }
  // La descripción aclara la excepción: cambiarlo requiere reiniciar el backend.
  await expect(settingCard(page, 'WHATSAPP_PROVIDER').getByText(/reiniciar/)).toBeVisible();

  await openTab(page, 'Mensajería: SMS');
  const smsProvider = page.locator('select#SMS_PROVIDER');
  await expect(smsProvider).toBeVisible();
  for (const value of ['twilio', 'gupshup']) {
    await expect(smsProvider.locator(`option[value="${value}"]`)).toHaveCount(1);
  }
});
