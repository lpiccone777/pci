/**
 * Bloque 3.3 del plan de pruebas — Dashboard (home).
 *
 * Casos FE-DASH-01..02. Corren contra el web aislado (`localhost:3100`) que levanta el
 * `global-setup`; la siembra va por la API real (`localhost:3101`) como el SuperAdmin del seed.
 *
 * La pantalla `/dashboard` no hace ningún fetch propio: todo sale del contexto de auth
 * (`/auth/me`). Por eso los datos que se verifican se controlan sembrando el usuario y su rol.
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

test('FE-DASH-01: el home muestra las cuatro tarjetas de resumen con el placeholder "—"', async ({
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
  // Hoy las cuatro tarjetas muestran el guion largo (U+2014) como valor placeholder, sin datos.
  await expect(cards.getByText('—', { exact: true })).toHaveCount(4);
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
