/**
 * Bloque 3.7 del plan de pruebas — Áreas (`/dashboard/areas`).
 *
 * Casos FE-ARE-01..05. Corren contra el web aislado (`localhost:3100`); la siembra va por la API
 * real (`localhost:3101`). El ABM de áreas es por empresa: cada test crea su propia empresa, sus
 * áreas y (cuando hace falta) usuarios asignados, y se para en esa empresa vía sesión inyectada.
 *
 * No hay `data-testid` en la pantalla: los anclajes son textos/roles ARIA en español, los ids de
 * heading de los modales (`area-modal-title`, `area-users-modal-title`) y el `title` del contador.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  adminContext,
  apiLogin,
  createTenant,
  createRole,
  createUser,
  createUserWithPermissions,
  createArea,
  type AdminCtx,
} from './support/seed';
import { injectSession } from './support/session';

/** Centinela de "Todas las empresas" (mismo valor que `@/lib/system-tenant`, sin depender del alias). */
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

/** Crea un área en `tenant` y le asigna un usuario nuevo (queda con userCount 1). */
async function areaWithOneUser(tenantId: string): Promise<{ id: string; name: string }> {
  const area = await createArea(admin, { tenantId });
  const role = await createRole(admin, { tenantId, permissions: ['users:read'] });
  await createUser(admin, {
    memberships: [{ tenantId, roleId: role.id, areaId: area.id }],
  });
  return area;
}

/** Fila de la tabla que contiene el texto dado (para acotar botones sin ids de fila). */
function rowWith(page: Page, text: string) {
  return page.getByRole('row').filter({ hasText: text });
}

test('FE-ARE-01: el listado muestra el userCount por área y en consolidado agrega la columna Empresa', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const area = await areaWithOneUser(tenant.id);
  // Una segunda empresa con área, para que el consolidado tenga >1 empresa y muestre el filtro
  // (el filtro "Empresa:" sólo aparece con más de una empresa en la lista).
  const otra = await createTenant(admin);
  await createArea(admin, { tenantId: otra.id });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/areas');

  // Empresa puntual: columnas Nombre/Usuarios/Creada, sin columna Empresa, y el área con su conteo.
  await expect(page.getByRole('columnheader', { name: 'Nombre' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Usuarios' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Empresa' })).toHaveCount(0);
  await expect(rowWith(page, area.name).getByRole('button', { name: '1' })).toBeVisible();

  // Consolidado: se cambia a "Todas las empresas" desde el selector (flujo real de UX; reusar
  // injectSession sobre la misma página deja la pantalla en una carrera de re-navegación).
  await page.locator('aside select').selectOption(ALL_TENANTS);
  await expect(page.getByRole('columnheader', { name: 'Empresa' })).toBeVisible();
  await expect(page.getByText('Empresa:', { exact: true })).toBeVisible();
});

test('FE-ARE-02: crear un área valida el nombre único (case-insensitive) y persiste el alta', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  await createArea(admin, { tenantId: tenant.id, name: 'Soporte' });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/areas');

  await page.getByRole('button', { name: 'Nueva área' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Nueva área' })).toBeVisible();

  // Colisión case-insensitive contra el área ya existente "Soporte": el chequeo local corta.
  await dialog.locator('#area-name').fill('soporte');
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(
    page.getByText('Ya existe un área llamada soporte en esta empresa.'),
  ).toBeVisible();

  // Un nombre libre sí persiste: POST /areas y la fila aparece en el listado.
  const nuevo = `Ventas ${Date.now()}`;
  await dialog.locator('#area-name').fill(nuevo);
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(rowWith(page, nuevo)).toBeVisible();
});

test('FE-ARE-03: eliminar un área con usuarios asignados queda bloqueado con el botón gris', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const area = await areaWithOneUser(tenant.id);

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/areas');

  const eliminar = rowWith(page, area.name).getByRole('button', { name: 'Eliminar' });
  await expect(eliminar).toHaveAttribute('aria-disabled', 'true');

  // Al clickear el botón gris no borra: informa el motivo y el área sigue en el listado.
  // force: el botón usa aria-disabled (no disabled) para poder clickearse y explicar el motivo.
  await eliminar.click({ force: true });
  await expect(
    page.getByText(
      `No se puede eliminar ${area.name}: 1 usuario está asignado a esta área. Reasignalos desde Usuarios y volvé a intentar.`,
    ),
  ).toBeVisible();
  await expect(rowWith(page, area.name)).toBeVisible();
});

test('FE-ARE-04: los botones de ABM aparecen sólo con el permiso correspondiente', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const area = await createArea(admin, { tenantId: tenant.id });

  // Usuario de sólo lectura: ve el listado pero ningún botón de alta/edición/borrado.
  const reader = await createUserWithPermissions(admin, ['areas:read'], { tenantId: tenant.id });
  await injectSession(page, await sessionForUser(reader.email, reader.password, tenant.id));
  await page.goto('/dashboard/areas');
  await expect(rowWith(page, area.name)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nueva área' })).toHaveCount(0);
  await expect(rowWith(page, area.name).getByRole('button', { name: 'Editar' })).toHaveCount(0);
  await expect(rowWith(page, area.name).getByRole('button', { name: 'Eliminar' })).toHaveCount(0);

  // Usuario con permiso de alta: sí ve "Nueva área".
  const editor = await createUserWithPermissions(admin, ['areas:read', 'areas:create'], {
    tenantId: tenant.id,
  });
  await injectSession(page, await sessionForUser(editor.email, editor.password, tenant.id));
  await page.goto('/dashboard/areas');
  await expect(page.getByRole('button', { name: 'Nueva área' })).toBeVisible();
});

test('FE-ARE-05: el contador de usuarios de un área abre el modal con su gente', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const area = await createArea(admin, { tenantId: tenant.id });
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['users:read'] });
  const member = await createUser(admin, {
    memberships: [{ tenantId: tenant.id, roleId: role.id, areaId: area.id }],
  });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/areas');

  // El número del área es un botón; su title lo identifica sin ambigüedad.
  await page.getByTitle(`Ver los usuarios del área ${area.name}`).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: `Usuarios del área ${area.name}` })).toBeVisible();
  await expect(dialog.getByText(member.email)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Ir a Usuarios' })).toBeVisible();
  // "Cerrar" del pie (la "×" del encabezado también tiene aria-label "Cerrar"): se ancla por texto.
  await expect(dialog.locator('button', { hasText: 'Cerrar' })).toBeVisible();
});
