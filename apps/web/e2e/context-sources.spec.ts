/**
 * Bloque 3.9 del plan de pruebas — Fuentes de verdad (`/dashboard/context-sources`).
 *
 * Casos FE-CS-01..12. Corren contra el web aislado (`localhost:3100`); la siembra va por la API
 * real (`localhost:3101`). La pantalla tiene dos pestañas (Conexiones / Skills) y es por empresa:
 * cada test crea su propia empresa, sus fuentes/skills y (cuando hace falta) usuarios, y se para en
 * esa empresa vía sesión inyectada.
 *
 * La pantalla NO tiene `data-testid` ni modales: el formulario es inline. Los anclajes son textos y
 * roles ARIA nativos (heading, button, table, row, columnheader) y placeholders. Los diálogos de
 * "Eliminar" son `window.confirm` NATIVOS → se manejan con `page.once('dialog', …)`.
 *
 * FE-CS-11 y FE-CS-12 verifican que, en modo consolidado ("Todas las empresas"), la pantalla
 * esconda el alta (como Áreas/Roles) en vez de dejar crear a ciegas en una empresa de respaldo.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  adminContext,
  apiLogin,
  createTenant,
  createContextSource,
  createSkill,
  createFlow,
  createUserWithPermissions,
  type AdminCtx,
} from './support/seed';
import { injectSession } from './support/session';

/** Centinela de "Todas las empresas" (mismo valor que `@/lib/system-tenant`). */
const ALL_TENANTS = '__all__';

let admin: AdminCtx;

test.beforeEach(async () => {
  admin = await adminContext();
});

/** Autentica a un usuario común por la API y devuelve su sesión (token + empresa activa). */
async function sessionForUser(email: string, password: string, activeTenant: string) {
  const res = await apiLogin(email, password);
  expect(res.accessToken, 'el usuario común debería loguear sin OTP').toBeTruthy();
  return { token: res.accessToken as string, activeTenant };
}

/** Fila de la tabla que contiene el texto dado (para acotar botones sin ids de fila). */
function rowWith(page: Page, text: string) {
  return page.getByRole('row').filter({ hasText: text });
}

/**
 * El `<select>` de "Tipo" del formulario de alta: el que contiene las opciones del catálogo. Se lo
 * ancla por una de sus opciones para no confundirlo con el selector de empresa del sidebar (que
 * también es un combobox y va primero en el DOM).
 */
function typeSelect(page: Page) {
  return page.locator('select').filter({ has: page.locator('option', { hasText: 'n8n (proceso externo)' }) });
}

test('FE-CS-01: el listado de Conexiones muestra nombre, tipo, estado y "Probar conexión" por fila', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const source = await createContextSource(admin, { tenantId: tenant.id, type: 'n8n' });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/context-sources');

  // Columnas de la tabla de conexiones.
  await expect(page.getByRole('columnheader', { name: 'Nombre' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Tipo' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Estado' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Conexión' })).toBeVisible();

  // La fila de la fuente sembrada: nombre, label del tipo, estado "Activa" y su botón de prueba.
  const row = rowWith(page, source.name);
  await expect(row).toBeVisible();
  await expect(row.getByText('n8n (proceso externo)')).toBeVisible();
  await expect(row.getByText('Activa', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Probar conexión' })).toBeVisible();
});

test('FE-CS-02: el alta arma el formulario dinámicamente según el tipo elegido', async ({ page }) => {
  const tenant = await createTenant(admin);

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/context-sources');

  // El form de alta es inline; su heading lo identifica.
  await expect(page.getByRole('heading', { name: 'Nueva fuente de verdad' })).toBeVisible();
  const tipo = typeSelect(page);

  // MCP → aparece el campo propio "URL del servidor MCP" (del catálogo GET /context-sources/types).
  await tipo.selectOption({ label: 'MCP (Model Context Protocol)' });
  await expect(page.getByText('URL del servidor MCP')).toBeVisible();
  await expect(page.getByText('URL del webhook')).toHaveCount(0);

  // n8n → el formulario se rearma con los campos de ese tipo.
  await tipo.selectOption({ label: 'n8n (proceso externo)' });
  await expect(page.getByText('URL del webhook')).toBeVisible();
  await expect(page.getByText('URL del servidor MCP')).toHaveCount(0);
});

test('FE-CS-03: en la edición el tipo aparece bloqueado', async ({ page }) => {
  const tenant = await createTenant(admin);
  const source = await createContextSource(admin, { tenantId: tenant.id, type: 'n8n' });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/context-sources');

  await rowWith(page, source.name).getByRole('button', { name: 'Editar' }).click();
  await expect(page.getByRole('heading', { name: 'Editar fuente de verdad' })).toBeVisible();

  // En edición el tipo es un input deshabilitado con el label del tipo (no un select editable).
  const typeInput = page.locator('input[disabled]').filter({ hasNot: page.locator('[type="checkbox"]') });
  await expect(typeInput.first()).toHaveValue('n8n (proceso externo)');
});

test('FE-CS-04: el campo secreto arranca vacío, muestra el enmascarado y ofrece "Quitar"', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  // n8n tiene un campo secreto (`authToken`): al sembrarlo cargado, el GET lo devuelve enmascarado.
  const source = await createContextSource(admin, {
    tenantId: tenant.id,
    type: 'n8n',
    config: { webhookUrl: 'https://n8n.e2e.invalid/webhook/e2e', authToken: 'tok-secreto-de-prueba' },
  });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/context-sources');
  await rowWith(page, source.name).getByRole('button', { name: 'Editar' }).click();
  await expect(page.getByRole('heading', { name: 'Editar fuente de verdad' })).toBeVisible();

  // El input secreto arranca vacío y su placeholder es el enmascarado + la leyenda de "no cambiar".
  const secret = page.getByPlaceholder(/cargado — dejar vacío para no cambiar/);
  await expect(secret).toBeVisible();
  await expect(secret).toHaveValue('');
  // Botón "Quitar" para borrar el valor guardado.
  await expect(page.getByRole('button', { name: 'Quitar' })).toBeVisible();
});

test('FE-CS-05: guardar usa POST/PATCH y no toca un secreto que se dejó vacío', async ({ page }) => {
  const tenant = await createTenant(admin);

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/context-sources');

  // --- Alta (POST): un secreto vacío no viaja en el body ---
  const nombre = `Fuente ${Date.now()}`;
  await page.getByPlaceholder('RAG de tickets resueltos').fill(nombre);
  await typeSelect(page).selectOption({ label: 'n8n (proceso externo)' });
  await page.getByPlaceholder('https://n8n.miempresa.com/webhook/9f2a1c3d').fill('https://n8n.e2e.invalid/webhook/x');

  const [postReq] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && /\/context-sources$/.test(r.url())),
    page.getByRole('button', { name: 'Crear' }).click(),
  ]);
  const postBody = JSON.parse(postReq.postData() ?? '{}');
  expect(postBody.type).toBe('n8n');
  expect(postBody.config?.webhookUrl).toBe('https://n8n.e2e.invalid/webhook/x');
  expect(postBody.config?.authToken, 'un secreto vacío no debe enviarse en el alta').toBeUndefined();
  await expect(page.getByText('Fuente de verdad creada.')).toBeVisible();

  // --- Edición (PATCH): renombrar dejando el secreto vacío no lo borra ---
  const conSecreto = await createContextSource(admin, {
    tenantId: tenant.id,
    type: 'n8n',
    config: { webhookUrl: 'https://n8n.e2e.invalid/webhook/e2e', authToken: 'tok-a-preservar' },
  });
  await page.reload();
  await rowWith(page, conSecreto.name).getByRole('button', { name: 'Editar' }).click();
  const nuevoNombre = `${conSecreto.name} editada`;
  await page.getByPlaceholder('RAG de tickets resueltos').fill(nuevoNombre);

  const [patchReq] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && /\/context-sources\/[^/]+$/.test(r.url())),
    page.getByRole('button', { name: 'Guardar cambios' }).click(),
  ]);
  const patchBody = JSON.parse(patchReq.postData() ?? '{}');
  expect(patchBody.config?.authToken, 'un secreto vacío no debe pisar el guardado').toBeUndefined();
  await expect(page.getByText('Fuente de verdad actualizada.')).toBeVisible();

  // Reabrir la edición: el secreto sigue cargado (placeholder de "no cambiar") → no se borró.
  await rowWith(page, nuevoNombre).getByRole('button', { name: 'Editar' }).click();
  await expect(page.getByPlaceholder(/cargado — dejar vacío para no cambiar/)).toBeVisible();
});

test('FE-CS-06: "Probar conexión" pega al backend y muestra el resultado con su mensaje', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  // webhookUrl a un host *.invalid (nunca resuelve): el connector devuelve ok:false → se pinta ✗.
  const source = await createContextSource(admin, { tenantId: tenant.id, type: 'n8n' });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/context-sources');

  const [testReq] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === 'POST' && /\/context-sources\/[^/]+\/test-connection$/.test(r.url()),
    ),
    rowWith(page, source.name).getByRole('button', { name: 'Probar conexión' }).click(),
  ]);
  expect(testReq).toBeTruthy();

  // El resultado del test aparece bajo el botón; con un host inalcanzable es el camino ✗ + mensaje.
  await expect(rowWith(page, source.name).getByText(/^✗/)).toBeVisible({ timeout: 20_000 });
});

test('FE-CS-07: eliminar una fuente en uso por flujos muestra el error del backend', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const source = await createContextSource(admin, { tenantId: tenant.id, type: 'n8n' });
  // Un flujo que la referencia: el backend rechaza el borrado con 409 y explica el motivo.
  await createFlow(admin, { contextSourceId: source.id });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/context-sources');

  page.once('dialog', (d) => d.accept()); // confirm nativo "¿Eliminar la fuente de verdad ...?"
  await rowWith(page, source.name).getByRole('button', { name: 'Eliminar' }).click();

  await expect(
    page.getByText(`"${source.name}" está vinculada a 1 flujo. Desvinculala antes de eliminarla.`),
  ).toBeVisible();
  // Sigue en el listado: no se borró.
  await expect(rowWith(page, source.name)).toBeVisible();
});

test('FE-CS-08: los botones de ABM de Conexiones aparecen sólo con el permiso correspondiente', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const source = await createContextSource(admin, { tenantId: tenant.id, type: 'n8n' });

  // Sólo lectura: ve la fila pero ni el form de alta ni Editar/Eliminar.
  const reader = await createUserWithPermissions(admin, ['context-sources:read'], { tenantId: tenant.id });
  await injectSession(page, await sessionForUser(reader.email, reader.password, tenant.id));
  await page.goto('/dashboard/context-sources');
  await expect(rowWith(page, source.name)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nueva fuente de verdad' })).toHaveCount(0);
  await expect(rowWith(page, source.name).getByRole('button', { name: 'Editar' })).toHaveCount(0);
  await expect(rowWith(page, source.name).getByRole('button', { name: 'Eliminar' })).toHaveCount(0);

  // Con permiso de alta: sí ve el formulario "Nueva fuente de verdad".
  const creator = await createUserWithPermissions(admin, ['context-sources:read', 'context-sources:create'], {
    tenantId: tenant.id,
  });
  // Limpiar la sesión del reader antes de inyectar la del creator: `injectSession` asume que /login
  // monta SIN token (si no, la pantalla redirige antes de setear el nuevo y la sesión no cambia,
  // quedando en /login). Mismo recaudo que FE-CS-10 al cambiar de sesión en la misma página.
  await page.evaluate(() => localStorage.clear());
  await injectSession(page, await sessionForUser(creator.email, creator.password, tenant.id));
  await page.goto('/dashboard/context-sources');
  await expect(page.getByRole('heading', { name: 'Nueva fuente de verdad' })).toBeVisible();
});

test('FE-CS-09: la pantalla se parte en pestañas Conexiones y Skills', async ({ page }) => {
  const tenant = await createTenant(admin);
  const source = await createContextSource(admin, { tenantId: tenant.id, type: 'n8n' });
  const skill = await createSkill(admin, { tenantId: tenant.id });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/context-sources');

  // Arranca en Conexiones: se ve la fuente.
  await expect(page.getByRole('button', { name: 'Conexiones' })).toBeVisible();
  await expect(rowWith(page, source.name)).toBeVisible();

  // Al cambiar a Skills: se ve el CRUD de skills (la skill sembrada) y no la tabla de conexiones.
  await page.getByRole('button', { name: 'Skills' }).click();
  await expect(rowWith(page, skill.name)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nuevo skill' })).toBeVisible();
  await expect(rowWith(page, source.name)).toHaveCount(0);
});

test('FE-CS-10: alta de una Skill en la pestaña Skills persiste y se gatea por permisos', async ({
  page,
}) => {
  const tenant = await createTenant(admin);

  // Admin: crea una skill desde el formulario (POST /skills) y la ve en la tabla.
  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/context-sources');
  await page.getByRole('button', { name: 'Skills' }).click();

  const nombre = `Skill ${Date.now()}`;
  await page.getByPlaceholder('Soporte nivel 1').fill(nombre);
  // El textarea de promptText no tiene el label asociado por `for`: en la pestaña Skills es el único.
  await page.locator('textarea').fill('Respondé consultas de facturación paso a paso.');
  const [postReq] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && /\/skills$/.test(r.url())),
    page.getByRole('button', { name: 'Crear' }).click(),
  ]);
  expect(JSON.parse(postReq.postData() ?? '{}').name).toBe(nombre);
  await expect(page.getByText('Skill creado.')).toBeVisible();
  await expect(rowWith(page, nombre)).toBeVisible();

  // Usuario con sólo skills:read: no ve el formulario de alta de skills.
  const reader = await createUserWithPermissions(admin, ['context-sources:read', 'skills:read'], {
    tenantId: tenant.id,
  });
  // Limpiar la sesión del admin antes de inyectar la del reader: `injectSession` asume que /login
  // monta SIN token (si no, la pantalla redirige antes de setear el nuevo y la sesión no cambia).
  await page.evaluate(() => localStorage.clear());
  await injectSession(page, await sessionForUser(reader.email, reader.password, tenant.id));
  await page.goto('/dashboard/context-sources');
  await page.getByRole('button', { name: 'Skills' }).click();
  // La sesión del reader cargó (ve la skill creada, tiene skills:read)...
  await expect(rowWith(page, nombre)).toBeVisible();
  // ...pero sin skills:create no ve el formulario de alta.
  await expect(page.getByRole('heading', { name: 'Nuevo skill' })).toHaveCount(0);
});

// --- Modo consolidado "Todas las empresas": la pantalla no debe dejar crear a ciegas ---

test(
  'FE-CS-11: en "Todas las empresas" la pestaña Conexiones NO debería dejar crear a ciegas',
  async ({ page }) => {
    // En modo consolidado la pantalla no debe dejar crear a ciegas en una empresa de respaldo:
    // como Áreas/Roles, esconde el alta y pide elegir una empresa puntual en el selector.
    const tenant = await createTenant(admin);
    await createContextSource(admin, { tenantId: tenant.id, type: 'n8n' });

    await injectSession(page, { token: admin.token, activeTenant: ALL_TENANTS });
    await page.goto('/dashboard/context-sources');
    // Esperar a que la pantalla termine de montar (useAuth resuelve /auth/me → decide el alta) antes
    // de evaluar; si no, el heading todavía no existe y pasaría por timing.
    await expect(page.getByRole('button', { name: 'Conexiones' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    // El formulario de alta no debe estar disponible en modo consolidado.
    await expect(page.getByRole('heading', { name: 'Nueva fuente de verdad' })).toHaveCount(0);
  },
);

test(
  'FE-CS-12: en "Todas las empresas" la pestaña Skills NO debería dejar crear a ciegas',
  async ({ page }) => {
    // Mismo criterio que FE-CS-11, en la pestaña Skills.
    const tenant = await createTenant(admin);
    await createSkill(admin, { tenantId: tenant.id });

    await injectSession(page, { token: admin.token, activeTenant: ALL_TENANTS });
    await page.goto('/dashboard/context-sources');
    await page.getByRole('button', { name: 'Skills' }).click();

    // El alta de skill no debe estar disponible en modo consolidado.
    await expect(page.getByRole('heading', { name: 'Nuevo skill' })).toHaveCount(0);
  },
);
