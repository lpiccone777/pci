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
import { API_URL } from './support/ports';

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

/**
 * Ruta de navegación (labels de pestaña, nivel por nivel) hasta cada grupo del catálogo.
 * Espeja `GROUP_HIERARCHY` de `apps/web/src/app/settings/page.tsx`: las ~17 pestañas planas
 * del catálogo se reorganizaron en una jerarquía de hasta 3 niveles de tablists anidados
 * (categoría → sub-sección → proveedor), con labels cortos. Ver FE-SET-16/17 como referencia.
 *
 * Cada sub-tablist solo se renderiza cuando su rama tiene más de un hijo, así que las categorías
 * de un solo grupo (Integraciones → InvGate) no exponen sub-pestaña: alcanza con clickear la
 * categoría, que activa su primera (y única) hoja.
 */
const GROUP_PATH: Record<string, string[]> = {
  'Autenticación y 2FA': ['Seguridad', 'Autenticación y 2FA'],
  Dispositivos: ['Seguridad', 'Dispositivos'],
  LLM: ['LLM', 'General'],
  'LLM: OpenAI': ['LLM', 'OpenAI'],
  'LLM: Gemini': ['LLM', 'Gemini'],
  'LLM: Claude': ['LLM', 'Claude'],
  'LLM: OpenRouter': ['LLM', 'OpenRouter'],
  'LLM: OpenCode Go': ['LLM', 'OpenCode Go'],
  'LLM: MiniMax': ['LLM', 'MiniMax'],
  'Mensajería: WhatsApp': ['Mensajería', 'WhatsApp', 'General'],
  'Mensajería: WhatsApp (Twilio)': ['Mensajería', 'WhatsApp', 'Twilio'],
  'Mensajería: WhatsApp (Gupshup)': ['Mensajería', 'WhatsApp', 'Gupshup'],
  'Mensajería: SMS': ['Mensajería', 'SMS', 'General'],
  'Mensajería: SMS (Twilio)': ['Mensajería', 'SMS', 'Twilio'],
  'Mensajería: SMS (Gupshup)': ['Mensajería', 'SMS', 'Gupshup'],
  'Mensajería: Email': ['Mensajería', 'Email'],
  'Integración: InvGate': ['Integraciones'],
};

/** Navega la jerarquía de pestañas hasta dejar activo el panel del grupo `group` del catálogo. */
async function openTab(page: Page, group: string) {
  const path = GROUP_PATH[group];
  if (!path) throw new Error(`openTab: grupo sin ruta mapeada en GROUP_PATH: ${group}`);

  // Nivel 1 — categorías (tablist raíz "Secciones de configuración").
  await page
    .getByRole('tablist', { name: 'Secciones de configuración' })
    .getByRole('tab', { name: path[0], exact: true })
    .click();

  // Nivel 2 — sub-secciones (solo si la categoría tiene más de una hoja/rama).
  if (path[1]) {
    await page
      .getByRole('tablist', { name: `Sub-secciones de ${path[0]}` })
      .getByRole('tab', { name: path[1], exact: true })
      .click();
  }

  // Nivel 3 — proveedores (solo si el sub-tema tiene más de una hoja).
  if (path[2]) {
    await page
      .getByRole('tablist', { name: `Proveedores de ${path[1]}` })
      .getByRole('tab', { name: path[2], exact: true })
      .click();
  }
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
  // El tablist raíz de categorías (ahora conviven varios tablists anidados: hay que nombrarlo).
  await expect(page.getByRole('tablist', { name: 'Secciones de configuración' })).toBeVisible();
  // "Autenticación y 2FA" es la primera sub-sección de "Seguridad" (categoría activa por defecto).
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

  // Abrimos la categoría LLM para que aparezcan sus sub-pestañas por proveedor.
  await page
    .getByRole('tablist', { name: 'Secciones de configuración' })
    .getByRole('tab', { name: 'LLM', exact: true })
    .click();

  // La sub-pestaña del proveedor activo (OpenAI) lleva el punto "Proveedor activo".
  const openaiTab = page
    .getByRole('tablist', { name: 'Sub-secciones de LLM' })
    .getByRole('tab', { name: 'OpenAI', exact: true });
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

  const topTabs = page.getByRole('tablist', { name: 'Secciones de configuración' });

  // Mensajería abre sus sub-secciones (WhatsApp / SMS / Email).
  await topTabs.getByRole('tab', { name: 'Mensajería', exact: true }).click();
  const msgTabs = page.getByRole('tablist', { name: 'Sub-secciones de Mensajería' });
  for (const mid of ['WhatsApp', 'SMS', 'Email']) {
    await expect(msgTabs.getByRole('tab', { name: mid, exact: true })).toBeVisible();
  }

  // WhatsApp (activo por defecto) muestra sus proveedores, entre ellos Twilio y Gupshup.
  const waProviders = page.getByRole('tablist', { name: 'Proveedores de WhatsApp' });
  for (const leaf of ['Twilio', 'Gupshup']) {
    await expect(waProviders.getByRole('tab', { name: leaf, exact: true })).toBeVisible();
  }

  // Ídem para SMS.
  await msgTabs.getByRole('tab', { name: 'SMS', exact: true }).click();
  const smsProviders = page.getByRole('tablist', { name: 'Proveedores de SMS' });
  for (const leaf of ['Twilio', 'Gupshup']) {
    await expect(smsProviders.getByRole('tab', { name: leaf, exact: true })).toBeVisible();
  }

  // Integraciones tiene una sola integración (InvGate): sin sub-tablist, la categoría abre su panel.
  await topTabs.getByRole('tab', { name: 'Integraciones', exact: true }).click();
  await expect(page.locator('#INVGATE_API_URL')).toBeVisible();

  // Un secreto de mensajería (Auth Token de Twilio) arranca vacío y "sin configurar".
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

test('FE-SET-16: las pestañas forman una jerarquía de 3 niveles navegable por teclado, con "Otros" y punto de estado propagado', async ({
  page,
}) => {
  // Fijamos openai como proveedor activo para que el punto de estado sea determinista.
  await setSetting(admin, 'LLM_PROVIDER', 'openai');

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');

  // Nivel 1 — categorías por tema (no los ~17 grupos planos del catálogo). El tablist raíz tiene
  // aria-label "Secciones de configuración"; cada tab lleva como nombre accesible el label de la
  // categoría (el puntito de estado es aria-hidden).
  const topTabs = page.getByRole('tablist', { name: 'Secciones de configuración' });
  await expect(topTabs).toBeVisible();
  for (const cat of ['Seguridad', 'LLM', 'Mensajería', 'Integraciones']) {
    await expect(topTabs.getByRole('tab', { name: cat, exact: true })).toBeVisible();
  }

  // Navegación por teclado (WAI-ARIA APG, activación automática): arranca en "Seguridad" (primera
  // categoría, seleccionada por defecto); ArrowRight mueve el foco Y activa "LLM" al toque.
  const seguridad = topTabs.getByRole('tab', { name: 'Seguridad', exact: true });
  await expect(seguridad).toHaveAttribute('aria-selected', 'true');
  await seguridad.focus();
  await seguridad.press('ArrowRight');
  await expect(topTabs.getByRole('tab', { name: 'LLM', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(seguridad).toHaveAttribute('aria-selected', 'false');

  // El punto de estado se propaga a la RAMA: el activo (openai) vive en una hoja ("LLM: OpenAI"),
  // pero la categoría "LLM" muestra igual el puntito de "Proveedor activo".
  await expect(
    topTabs
      .getByRole('tab', { name: 'LLM', exact: true })
      .locator('span[title="Proveedor activo"]'),
  ).toBeVisible();

  // Los 3 niveles: clic en "Mensajería" abre su sub-tablist (WhatsApp/SMS/Email) y, como la primera
  // hoja cuelga de WhatsApp, también el tablist de proveedores (General/Twilio/Gupshup).
  await topTabs.getByRole('tab', { name: 'Mensajería', exact: true }).click();

  const midTabs = page.getByRole('tablist', { name: 'Sub-secciones de Mensajería' });
  await expect(midTabs).toBeVisible();
  for (const mid of ['WhatsApp', 'SMS', 'Email']) {
    await expect(midTabs.getByRole('tab', { name: mid, exact: true })).toBeVisible();
  }

  const leafTabs = page.getByRole('tablist', { name: 'Proveedores de WhatsApp' });
  await expect(leafTabs).toBeVisible();
  for (const leaf of ['General', 'Twilio', 'Gupshup']) {
    await expect(leafTabs.getByRole('tab', { name: leaf, exact: true })).toBeVisible();
  }

  // "Otros" — con el catálogo real todos los grupos están mapeados en GROUP_HIERARCHY, así que la
  // pestaña "Otros" NO aparece hoy.
  await expect(topTabs.getByRole('tab', { name: 'Otros', exact: true })).toHaveCount(0);

  // Para ejercitar la rama defensiva (un grupo del catálogo sin mapear cae en "Otros" en vez de
  // desaparecer) hace falta un grupo que la jerarquía no conozca, y no hay endpoint para agregar
  // grupos al catálogo. Interceptamos SOLO el GET /settings para reusar la respuesta REAL de la API
  // y sumarle una única clave con un grupo inexistente en GROUP_HIERARCHY; el resto del payload y el
  // status de proveedores siguen siendo los reales (frontera bajo prueba: el agrupamiento en el
  // cliente).
  const probeKey = 'E2E_UNMAPPED_PROBE';
  await page.route(`${API_URL}/settings`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resp = await route.fetch();
    const real = await resp.json();
    real.push({
      key: probeKey,
      type: 'string',
      group: 'Grupo E2E Sin Mapear',
      label: 'Sonda E2E',
      description: 'Grupo sintético para ejercitar la pestaña "Otros".',
      defaultValue: '',
      value: '',
      source: 'default',
      updatedAt: null,
    });
    await route.fulfill({ response: resp, json: real });
  });
  await page.reload();

  const otros = page
    .getByRole('tablist', { name: 'Secciones de configuración' })
    .getByRole('tab', { name: 'Otros', exact: true });
  await expect(otros).toBeVisible();
  await otros.click();
  // El grupo sin mapear quedó dentro de "Otros" y su tarjeta se renderiza (no se perdió).
  await expect(page.locator(`#${probeKey}`)).toBeVisible();
});

test('FE-SET-17: guardar una fila resetea solo su draft y conserva lo tipeado en las demás', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  // Arranca en "Autenticación y 2FA": OTP_TTL_SECONDS y OTP_CODE_LENGTH conviven en este panel.
  await page.goto('/settings');

  const ttl = page.locator('#OTP_TTL_SECONDS');
  const codeLen = page.locator('#OTP_CODE_LENGTH');
  await expect(ttl).toBeVisible();
  await expect(codeLen).toBeVisible();

  const ttlOriginal = await ttl.inputValue();
  const codeOriginal = await codeLen.inputValue();
  const ttlNew = String(Number(ttlOriginal) + 7); // dentro del rango 60–3600
  const codeNew = codeOriginal === '7' ? '5' : '7'; // otro valor válido (rango 4–8), distinto del actual

  // Tipeamos drafts SIN guardar en las dos filas.
  await ttl.fill(ttlNew);
  await codeLen.fill(codeNew);

  const patchCalls: string[] = [];
  const statusCalls: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/settings/OTP_')) patchCalls.push(r.url());
    if (r.url().includes('/settings/providers/status')) statusCalls.push(r.url());
  });

  // Guardamos SOLO la fila de OTP_TTL_SECONDS.
  await settingCard(page, 'OTP_TTL_SECONDS').getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText('OTP_TTL_SECONDS actualizado.')).toBeVisible();

  // La fila guardada mergea su valor: su draft queda en el valor efectivo (ni vacío ni revertido).
  await expect(ttl).toHaveValue(ttlNew);
  // La OTRA fila conserva lo tipeado: guardar una no pisa los drafts de las demás (antes un load()
  // completo los borraba a todos).
  await expect(codeLen).toHaveValue(codeNew);
  // Y sigue "sucia" (su Guardar habilitado): no se guardó ni se reseteó.
  await expect(
    settingCard(page, 'OTP_CODE_LENGTH').getByRole('button', { name: 'Guardar' }),
  ).toBeEnabled();

  // Solo se tocó el backend por la fila guardada; y `refreshStatus` corrió tras el PATCH.
  expect(patchCalls.length).toBe(1);
  expect(patchCalls[0]).toContain('/settings/OTP_TTL_SECONDS');
  await expect.poll(() => statusCalls.length).toBeGreaterThanOrEqual(1);
});
