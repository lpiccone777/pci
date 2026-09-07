/**
 * Bloque 3.3 del plan de pruebas — Dashboard (home).
 *
 * Casos FE-DASH-01..02. Corren contra el web aislado (`localhost:3100`) que levanta el
 * `global-setup`; la siembra va por la API real (`localhost:3101`) como el SuperAdmin del seed.
 *
 * La pantalla `/dashboard` tiene dos mitades con origen distinto: las cuatro tarjetas de resumen
 * traen sus conteos de `GET /metrics/dashboard` (el guion largo es sólo el estado inicial, y el
 * valor al que se cae si esa llamada falla), y el panel "Tu rol y permisos" sale del contexto de
 * auth (`/auth/me`), sin llamada propia. Por eso lo que verifica el panel se controla sembrando
 * el usuario y su rol, y lo de las tarjetas no se fija en un número exacto.
 */
import { test, expect } from '@playwright/test';
import {
  adminContext,
  apiLogin,
  createTenant,
  createRole,
  createUser,
  type AdminCtx,
} from './support/seed';
import { injectSession } from './support/session';

let admin: AdminCtx;

test.beforeEach(async () => {
  // Token fresco por test: evita que uno lento tope los 15 min de expiración del access token.
  admin = await adminContext();
});

test('FE-DASH-01: el home muestra las cuatro tarjetas de resumen con sus conteos', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard\/?$/);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  // Las tarjetas viven en la grilla del contenido, no en el sidebar (donde "Usuarios"/"Tenants"
  // también aparecen como links de menú). Se acota la grilla por un título que es exclusivo de
  // las tarjetas ("Conversaciones" no es un ítem del menú).
  const cards = page.locator('div.grid').filter({ hasText: 'Conversaciones' }).first();
  for (const title of ['Usuarios', 'Tenants', 'Conversaciones', 'Tickets']) {
    await expect(cards.getByText(title, { exact: true })).toBeVisible();
  }
  // Las cuatro tarjetas traen los conteos de GET /metrics/dashboard. El guion largo (U+2014) que
  // este caso esperaba antes es sólo el estado inicial, mientras la respuesta está en camino (y el
  // valor al que se cae si la llamada falla): la aserción va contra el número ya cargado.
  // No se fija CUÁNTO da cada tarjeta — depende de lo que hayan sembrado los tests previos —, sino
  // que las cuatro resuelvan a un conteo.
  await expect(cards.getByText(/^\d+$/)).toHaveCount(4);
});

test('FE-DASH-02: el panel "Tu rol y permisos" lista el rol y la cantidad de permisos por empresa', async ({
  page,
}) => {
  // Se siembra una empresa con un rol de exactamente 2 permisos y un usuario con ese rol, para
  // verificar contra un número conocido (el del catálogo del SuperAdmin dependería de la
  // resolución de permisos efectivos). El panel se dibuja con lo que /auth/me trae del usuario.
  const tenant = await createTenant(admin);
  const role = await createRole(admin, {
    tenantId: tenant.id,
    name: 'Rol Dashboard 2P',
    permissions: ['users:read', 'users:create'],
  });
  const user = await createUser(admin, {
    memberships: [{ tenantId: tenant.id, roleId: role.id }],
  });
  const login = await apiLogin(user.email, user.password);
  expect(login.accessToken, 'el usuario común debería loguear sin OTP').toBeTruthy();

  await injectSession(page, { token: login.accessToken as string, activeTenant: tenant.id });
  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { name: 'Tu rol y permisos' })).toBeVisible();
  // Línea "NombreEmpresa: NombreRol" (el rol en un <span> dentro del <p>) + "N permisos".
  await expect(page.getByText(`${tenant.name}:`, { exact: false })).toBeVisible();
  await expect(page.getByText('Rol Dashboard 2P', { exact: true })).toBeVisible();
  await expect(page.getByText('2 permisos', { exact: true })).toBeVisible();
});
