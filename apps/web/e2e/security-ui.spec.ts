/**
 * Bloque 3.12 del plan de pruebas — Seguridad de la UI.
 *
 * Casos FE-SEC-01..06. La visibilidad por permisos y el enmascarado en pantalla son DEFENSA EN
 * PROFUNDIDAD, no la barrera real: la autorización la impone el backend. Estos tests verifican que
 * la UI no debilite esa postura y que forzar la request equivalente igual la rechace el backend.
 *
 * Se siembra por la API real (`localhost:3101`) y la UI corre contra el web aislado
 * (`localhost:3100`). Para "forzar la request equivalente" se usa el `request` de Playwright
 * (APIRequestContext), que pega directo a la API sin pasar por la UI.
 *
 * FE-SEC-06 cubre el gateo de Skills. La parte de UI (pestaña Skills de Fuentes de verdad y
 * selector de Skill del editor) vive en las pantallas 3.9/3.10, fuera del alcance de esta corrida;
 * acá se verifica el corazón del caso: forzar la request a `/skills` sin permiso la rechaza (403).
 */
import { test, expect } from '@playwright/test';
import {
  adminContext,
  apiLogin,
  createTenant,
  createUserWithPermissions,
  createUser,
  createRole,
  findUserIdByEmail,
  deleteUserInTenant,
  setSetting,
  uniqueSlug,
  type AdminCtx,
} from './support/seed';
import { injectSession, readLocalStorage } from './support/session';
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

test('FE-SEC-01: ocultar un botón no es la única defensa — forzar la request igual da 403', async ({
  page,
  request,
}) => {
  const tenant = await createTenant(admin);
  const user = await createUserWithPermissions(admin, ['areas:read'], { tenantId: tenant.id });
  const token = (await sessionForUser(user.email, user.password, tenant.id)).token;

  // La UI no muestra el botón de alta (falta areas:create).
  await injectSession(page, { token, activeTenant: tenant.id });
  await page.goto('/dashboard/areas');
  await expect(page.getByRole('button', { name: 'Nueva área' })).toHaveCount(0);

  // Forzar la request equivalente: el backend la rechaza igual (defensa real).
  const res = await request.post(`${API_URL}/areas`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenant.id },
    data: { name: `Área forzada ${uniqueSlug('x')}` },
  });
  expect(res.status()).toBe(403);
});

test('FE-SEC-02: el JWT vive en localStorage (expuesto a XSS) — se documenta el riesgo', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard\/?$/);

  // El token queda accesible desde JS de la página: es un JWT (tres segmentos) en `localStorage`.
  // Relacionado con SEC-06 (el refresh de 7 días también sirve como access). Sólo se documenta.
  const token = await readLocalStorage(page, 'token');
  expect(token, 'el token debería estar en localStorage').toBeTruthy();
  expect((token as string).split('.')).toHaveLength(3);
});

test('FE-SEC-03: los campos secretos nunca muestran el valor real, sólo enmascarado + estado', async ({
  page,
}) => {
  // Cobertura del lado de /settings (los secretos de Fuentes de verdad viven en la pantalla 3.9,
  // fuera del alcance de esta corrida).
  const secretValue = `sk-${uniqueSlug('secreto')}`;
  await setSetting(admin, 'OPENAI_API_KEY', secretValue);

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');
  // La pestaña del proveedor vive en una jerarquía de tablists: LLM (categoría) → OpenAI (sub-sección).
  await page
    .getByRole('tablist', { name: 'Secciones de configuración' })
    .getByRole('tab', { name: 'LLM', exact: true })
    .click();
  await page
    .getByRole('tablist', { name: 'Sub-secciones de LLM' })
    .getByRole('tab', { name: 'OpenAI', exact: true })
    .click();

  // El input arranca vacío, muestra el estado "cargada" y en ningún lugar aparece el valor real.
  await expect(page.locator('#OPENAI_API_KEY')).toHaveValue('');
  await expect(page.getByText('cargada:', { exact: false })).toBeVisible();
  await expect(page.getByText(secretValue)).toHaveCount(0);
});

test('FE-SEC-04: la baja del usuario durante la sesión hace que /auth/me falle y el front cierre sesión', async ({
  page,
}) => {
  // Usuario con una única membresía: darlo de baja de ese tenant lo da de baja lógica por completo.
  const tenant = await createTenant(admin);
  const user = await createUserWithPermissions(admin, ['areas:read'], { tenantId: tenant.id });
  const session = await sessionForUser(user.email, user.password, tenant.id);

  await injectSession(page, session);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard\/?$/);

  // Baja durante la sesión (por la API, como lo haría otro operador).
  const userId = await findUserIdByEmail(admin, user.email);
  expect(userId, 'el usuario sembrado debería existir antes de la baja').toBeTruthy();
  await deleteUserInTenant(admin, userId as string, tenant.id);

  // Al recargar, /auth/me responde 401 (auth.service.me filtra deletedAt) → logout + /login.
  await page.reload();
  await expect(page).toHaveURL(/\/login\/?$/);
  await page.waitForFunction(() => localStorage.getItem('token') === null);
});

test('FE-SEC-05: un común por URL directa a /settings (systemTenantOnly) ve el 403 y no tiene el ítem en el menú', async ({
  page,
}) => {
  // Usuario de una empresa NO-sistema: /settings exige tenant de sistema (SystemTenantGuard).
  const tenant = await createTenant(admin);
  const user = await createUserWithPermissions(admin, ['areas:read'], { tenantId: tenant.id });
  await injectSession(page, await sessionForUser(user.email, user.password, tenant.id));
  await page.goto('/settings');

  // La pantalla explica el estado sin acceso (el backend rechazó GET /settings con 403).
  await expect(
    page.getByText('solo es accesible desde el tenant de sistema', { exact: false }),
  ).toBeVisible();
  // El ítem "Configuración" (systemTenantOnly) no está en el menú parado en una empresa común.
  await expect(page.getByRole('link', { name: 'Configuración', exact: true })).toHaveCount(0);
});

test('FE-SEC-06: sin el permiso skills, forzar la request a /skills la rechaza el backend (403)', async ({
  request,
}) => {
  // Rol con acceso al backoffice pero SIN ningún permiso de skills.
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['areas:read'] });
  const user = await createUser(admin, {
    memberships: [{ tenantId: tenant.id, roleId: role.id }],
  });
  const token = (await sessionForUser(user.email, user.password, tenant.id)).token;
  const headers = { Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenant.id };

  // Leer y crear skills sin permiso: ambas rechazadas por RolesGuard (defensa real, más allá de
  // que la pestaña Skills y el selector del editor no se muestren — eso vive en 3.9/3.10).
  const list = await request.get(`${API_URL}/skills`, { headers });
  expect(list.status()).toBe(403);

  const create = await request.post(`${API_URL}/skills`, {
    headers,
    data: { name: `Skill forzada ${uniqueSlug('x')}`, promptText: 'x' },
  });
  expect(create.status()).toBe(403);
});
