/**
 * Bloque 3.11 del plan de pruebas — Responsive.
 *
 * Casos FE-RSP-01..04. Verifican que las pantallas clave sigan usables en anchos chicos. Se opera
 * como SuperAdmin del seed; la siembra va por la API real (`localhost:3101`) y la UI contra el web
 * aislado (`localhost:3100`). Cada test fija su propio viewport con `setViewportSize`.
 *
 * FE-RSP-03 abre el editor de flujos (`/dashboard/flows/[id]`, bloque 3.10, fuera del alcance de
 * esta corrida): acá sólo se comprueba su LAYOUT en pantalla chica (canvas + paleta + Controls),
 * no su funcionalidad de edición.
 */
import { test, expect } from '@playwright/test';
import { adminContext, type AdminCtx } from './support/seed';
import { injectSession } from './support/session';

let admin: AdminCtx;

test.beforeEach(async () => {
  admin = await adminContext();
});

test('FE-RSP-01: el panel a ~400px de ancho sigue mostrando el contenido principal usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard');

  // El contenido principal (no sólo el sidebar) se ve y es legible en móvil. Se documenta el
  // scroll horizontal conocido del layout del sidebar (preexistente): no se asevera su ausencia.
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tu rol y permisos' })).toBeVisible();
});

test('FE-RSP-02: las tablas de ABM (usuarios/roles) se leen y operan en pantallas chicas', async ({
  page,
}) => {
  await page.setViewportSize({ width: 500, height: 900 });
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });

  // Usuarios: la tabla tiene filas y una acción operable a la vista (con scroll donde haga falta).
  await page.goto('/dashboard/users');
  await expect(page.getByRole('button', { name: 'Nuevo usuario' })).toBeVisible();
  await expect(page.getByRole('row').nth(1)).toBeVisible();

  // Roles: la matriz/listado sigue mostrando sus columnas y filas.
  await page.goto('/dashboard/roles');
  await expect(page.getByRole('columnheader', { name: 'Rol' })).toBeVisible();
  await expect(page.getByRole('row').nth(1)).toBeVisible();
});

test('FE-RSP-03: el editor de flujos en pantalla chica mantiene canvas, paleta y Controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/flows/edit/?id=new');

  // Paleta de nodos.
  await expect(page.getByRole('heading', { name: 'Nodos' })).toBeVisible();
  // Canvas de ReactFlow y sus Controls (operables aun en poco ancho).
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(page.locator('.react-flow__controls')).toBeVisible();
});

test('FE-RSP-04: las pestañas de /settings se recorren sin desbordar horizontalmente la página', async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/settings');

  const tablist = page.getByRole('tablist');
  await expect(tablist).toBeVisible();
  // Con tantos proveedores el tablist envuelve (flex-wrap): la PÁGINA no debe desbordar en x.
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflows, 'la página no debería tener scroll horizontal a 700px').toBe(false);
});
