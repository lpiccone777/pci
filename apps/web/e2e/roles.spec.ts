/**
 * Bloque 3.5 del plan de pruebas — Roles y matriz de permisos (`/dashboard/roles`).
 *
 * Casos FE-ROL-01..10. Corren contra el web aislado (`localhost:3100`); la siembra va por la API
 * real (`localhost:3101`). El catálogo de permisos son 15 recursos × 4 acciones = 60 (labels de
 * acción: Ver/Crear/Modificar/Eliminar; recurso "Usuarios" = users, etc.), definidos en
 * `apps/api/src/modules/rbac/permissions.catalog.ts`.
 *
 * La matriz usa `aria-label="<AcciónLabel> <RecursoLabel>"` por celda (ej. "Crear Usuarios").
 */
import { test, expect, type Page } from '@playwright/test';
import {
  adminContext,
  apiLogin,
  createTenant,
  createRole,
  createUser,
  type AdminCtx,
} from './support/seed';
import { injectSession } from './support/session';

const ALL_TENANTS = '__all__';
const CATALOG_TOTAL = 60;

let admin: AdminCtx;

test.beforeEach(async () => {
  admin = await adminContext();
});

async function sessionForUser(email: string, password: string, activeTenant: string) {
  const res = await apiLogin(email, password);
  expect(res.accessToken, 'el usuario común debería loguear sin OTP').toBeTruthy();
  return { token: res.accessToken as string, activeTenant };
}

function rowWith(page: Page, text: string) {
  return page.getByRole('row').filter({ hasText: text });
}

test('FE-ROL-01: el listado muestra el badge del rol protegido y el conteo de permisos', async ({
  page,
}) => {
  // En la empresa de sistema vive el rol protegido (SuperAdmin) → badge "Rol del sistema".
  const role = await createRole(admin, {
    name: `Rol ROL01 ${Date.now()}`,
    permissions: ['users:read', 'users:create'],
  });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/roles');

  await expect(page.getByRole('columnheader', { name: 'Rol' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Permisos' })).toBeVisible();
  await expect(page.getByText('Rol del sistema').first()).toBeVisible();
  // El rol recién creado muestra su nombre y el conteo de permisos (2).
  await expect(rowWith(page, role.name).getByText('2', { exact: true })).toBeVisible();
});

test('FE-ROL-02: crear un rol valida el nombre único (case-insensitive) y persiste el alta', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  await createRole(admin, { tenantId: tenant.id, name: 'Supervisor' });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/roles');

  await page.getByRole('button', { name: 'Nuevo rol' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Nuevo rol' })).toBeVisible();

  await dialog.locator('#role-name').fill('supervisor');
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText('Ya existe un rol llamado supervisor en esta empresa.')).toBeVisible();

  const nuevo = `Coordinador ${Date.now()}`;
  await dialog.locator('#role-name').fill(nuevo);
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(rowWith(page, nuevo)).toBeVisible();
});

test('FE-ROL-03: la matriz de permisos actualiza el contador con los toggles de fila/columna/todo', async ({
  page,
}) => {
  const tenant = await createTenant(admin);

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/roles');
  await page.getByRole('button', { name: 'Nuevo rol' }).click();
  const dialog = page.getByRole('dialog');

  await expect(dialog.getByText(`0 de ${CATALOG_TOTAL} permisos activos`)).toBeVisible();

  // "Todos los recursos" llena la matriz completa.
  await dialog.getByRole('button', { name: 'Todos los recursos' }).click();
  await expect(
    dialog.getByText(`${CATALOG_TOTAL} de ${CATALOG_TOTAL} permisos activos · acceso total`),
  ).toBeVisible();
  // Y de nuevo la vacía.
  await dialog.getByRole('button', { name: 'Todos los recursos' }).click();
  await expect(dialog.getByText(`0 de ${CATALOG_TOTAL} permisos activos`)).toBeVisible();

  // Toggle por fila del recurso "Usuarios" → 4 acciones (read/create/update/delete).
  await dialog.getByRole('button', { name: 'Usuarios', exact: true }).click();
  await expect(dialog.getByText(`4 de ${CATALOG_TOTAL} permisos activos`)).toBeVisible();
});

test('FE-ROL-04: marcar una acción distinta de "Ver" fuerza y bloquea el read del recurso', async ({
  page,
}) => {
  const tenant = await createTenant(admin);

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/roles');
  await page.getByRole('button', { name: 'Nuevo rol' }).click();
  const dialog = page.getByRole('dialog');

  await dialog.getByRole('checkbox', { name: 'Crear Usuarios' }).check();

  const verUsuarios = dialog.getByRole('checkbox', { name: 'Ver Usuarios' });
  await expect(verUsuarios).toBeChecked();
  await expect(verUsuarios).toBeDisabled();
});

test('FE-ROL-05: guardar dispara PATCH del nombre y PUT de permisos, sólo lo que cambió', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, {
    tenantId: tenant.id,
    name: `Editable A ${Date.now()}`,
    permissions: ['users:read'],
  });

  const patchCalls: string[] = [];
  const putPermCalls: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (r.method() === 'PATCH' && /\/roles\/[^/]+$/.test(u)) patchCalls.push(u);
    if (r.method() === 'PUT' && u.includes(`/roles/${role.id}/permissions`)) putPermCalls.push(u);
  });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/roles');

  // Cambiar nombre + permisos → dos llamadas.
  await rowWith(page, role.name).getByRole('button', { name: 'Editar' }).click();
  const dialog = page.getByRole('dialog');
  const nuevoNombre = `${role.name} v2`;
  await dialog.locator('#role-name').fill(nuevoNombre);
  await dialog.getByRole('checkbox', { name: 'Crear Tickets' }).check();
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await expect.poll(() => patchCalls.length).toBeGreaterThan(0);
  await expect.poll(() => putPermCalls.length).toBeGreaterThan(0);

  // Segundo rol: cambiar SÓLO el nombre → PATCH sí, PUT de permisos no.
  const role2 = await createRole(admin, {
    tenantId: tenant.id,
    name: `Editable B ${Date.now()}`,
    permissions: ['users:read'],
  });
  const putPerm2: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes(`/roles/${role2.id}/permissions`)) {
      putPerm2.push(r.url());
    }
  });
  await page.reload();
  await rowWith(page, role2.name).getByRole('button', { name: 'Editar' }).click();
  const dialog2 = page.getByRole('dialog');
  await dialog2.locator('#role-name').fill(`${role2.name} v2`);
  await dialog2.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(rowWith(page, `${role2.name} v2`)).toBeVisible();
  expect(putPerm2).toHaveLength(0);
});

test('FE-ROL-06: al editar el propio rol aparece el aviso de posible pérdida de acceso', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, {
    tenantId: tenant.id,
    name: `Autogestión ${Date.now()}`,
    permissions: ['roles:read', 'roles:update', 'permissions:update'],
  });
  const me = await createUser(admin, { memberships: [{ tenantId: tenant.id, roleId: role.id }] });

  await injectSession(page, await sessionForUser(me.email, me.password, tenant.id));
  await page.goto('/dashboard/roles');

  await rowWith(page, role.name).getByRole('button', { name: 'Editar' }).click();
  await expect(page.getByText(/Este es tu rol\./)).toBeVisible();
});

test('FE-ROL-07: el rol protegido se abre en modo consulta, sin editar ni eliminar', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/roles');

  // Abrir el detalle del rol protegido clickeando su badge (la fila abre la ventana en consulta).
  await rowWith(page, 'Rol del sistema').getByText('Rol del sistema').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Rol del sistema' })).toBeVisible();
  await expect(dialog.locator('#role-name')).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: 'Ver Usuarios' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  // "Cerrar" del pie (la "×" del encabezado también tiene aria-label "Cerrar").
  await expect(dialog.locator('button', { hasText: 'Cerrar' })).toBeVisible();
});

test('FE-ROL-08: eliminar un rol con usuarios asignados queda bloqueado con el botón gris', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, {
    tenantId: tenant.id,
    name: `Con gente ${Date.now()}`,
    permissions: ['users:read'],
  });
  await createUser(admin, { memberships: [{ tenantId: tenant.id, roleId: role.id }] });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/roles');

  const borrar = rowWith(page, role.name).getByRole('button', { name: 'Borrar' });
  await expect(borrar).toHaveAttribute('aria-disabled', 'true');
  // force: usa aria-disabled (no disabled) para poder clickearse y explicar el motivo.
  await borrar.click({ force: true });
  await expect(
    page.getByText(
      `No se puede eliminar ${role.name}: 1 usuario lo tiene asignado. Reasignalos a otro rol desde Usuarios y volvé a intentar.`,
    ),
  ).toBeVisible();
  await expect(rowWith(page, role.name)).toBeVisible();
});

test('FE-ROL-09: en modo consolidado aparece la columna Empresa y no se puede crear', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: ALL_TENANTS });
  await page.goto('/dashboard/roles');

  await expect(page.getByRole('columnheader', { name: 'Empresa' })).toBeVisible();
  await expect(page.getByText('Empresa:', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nuevo rol' })).toHaveCount(0);
});

test('FE-ROL-10: el contador de usuarios de un rol abre el modal con su gente', async ({ page }) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, {
    tenantId: tenant.id,
    name: `Con usuarios ${Date.now()}`,
    permissions: ['users:read'],
  });
  const member = await createUser(admin, {
    memberships: [{ tenantId: tenant.id, roleId: role.id }],
  });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/roles');

  await page.getByTitle(`Ver los usuarios con el rol ${role.name}`).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: `Usuarios con el rol ${role.name}` })).toBeVisible();
  await expect(dialog.getByText(member.email)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Ir a Usuarios' })).toBeVisible();
  // "Cerrar" del pie (la "×" del encabezado también tiene aria-label "Cerrar").
  await expect(dialog.locator('button', { hasText: 'Cerrar' })).toBeVisible();
});
