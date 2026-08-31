/**
 * Bloque 3.6 del plan de pruebas — Tenants (`/dashboard/tenants`).
 *
 * Casos FE-TEN-01..07. Pantalla `systemTenantOnly`: se opera siempre como SuperAdmin del seed,
 * parado en la empresa de sistema. La siembra va por la API real (`localhost:3101`); la UI corre
 * contra el web aislado (`localhost:3100`).
 *
 * FE-TEN-06 y FE-TEN-07 verifican que el selector del sidebar refleje el alta y el renombre de una
 * empresa sin recargar: la pantalla emite un evento tras cada cambio y el sidebar refresca su lista.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  adminContext,
  apiLogin,
  createTenant,
  deleteTenant,
  createUserWithPermissions,
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

function rowWith(page: Page, text: string) {
  return page.getByRole('row').filter({ hasText: text });
}

/** Completa el modal de empresa (nombre + slug) y aprieta Guardar. */
async function fillTenantModal(page: Page, name: string, slug: string) {
  const dialog = page.getByRole('dialog');
  await dialog.locator('#tenant-name').fill(name);
  await dialog.locator('#tenant-slug').fill(slug);
  await dialog.getByRole('button', { name: 'Guardar' }).click();
}

test('FE-TEN-01: el ítem "Tenants" del menú aparece sólo con tenants:read en contexto de sistema', async ({
  page,
}) => {
  // Miembro de la empresa de sistema CON tenants:read → ve el ítem, rotulado "Tenants".
  const conPermiso = await createUserWithPermissions(admin, ['tenants:read']);
  await injectSession(page, await sessionForUser(conPermiso.email, conPermiso.password, admin.systemTenantId));
  await page.goto('/dashboard');
  // Gate: esperar a que useAuth resuelva /auth/me y el sidebar monte (el email aparece recién
  // ahí) antes de mirar el menú. En la primera navegación, la compilación on-demand de Next más
  // la resolución de permisos pueden pasarse de los 5s por defecto de la aserción — ése era el
  // origen del flaky. Con el gate, la comprobación del menú ya no corre esa carrera.
  await expect(page.getByText(conPermiso.email)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'Tenants', exact: true })).toBeVisible();

  // Miembro de sistema SIN tenants:read → no lo ve (el corte es por permiso, no por contexto).
  const sinPermiso = await createUserWithPermissions(admin, ['users:read']);
  await injectSession(page, await sessionForUser(sinPermiso.email, sinPermiso.password, admin.systemTenantId));
  await page.goto('/dashboard');
  await expect(page.getByText(sinPermiso.email)).toBeVisible({ timeout: 15_000 });
  // "Usuarios" visible confirma que el menú ya se renderizó, así el toHaveCount(0) de "Tenants"
  // se evalúa sobre el menú final, no sobre uno todavía vacío.
  await expect(page.getByRole('link', { name: 'Usuarios', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tenants', exact: true })).toHaveCount(0);
});

test('FE-TEN-02: el toggle "Mostrar dados de baja" pide includeDeleted y muestra el badge', async ({
  page,
}) => {
  const bajada = await createTenant(admin);
  await deleteTenant(admin, bajada.id);

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/tenants');
  // Sin el toggle, la dada de baja no está en la tabla.
  await expect(rowWith(page, bajada.slug)).toHaveCount(0);

  const includeDeletedCalls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/tenants/all') && r.url().includes('includeDeleted=true')) {
      includeDeletedCalls.push(r.url());
    }
  });

  await page.getByRole('checkbox', { name: 'Mostrar dados de baja' }).check();

  await expect.poll(() => includeDeletedCalls.length).toBeGreaterThan(0);
  const row = rowWith(page, bajada.slug);
  await expect(row).toBeVisible();
  await expect(row.getByText('Dada de baja', { exact: true })).toBeVisible();
});

test('FE-TEN-03: crear una empresa valida el slug único localmente y persiste el alta', async ({
  page,
}) => {
  const existente = await createTenant(admin);

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/tenants');

  await page.getByRole('button', { name: 'Nuevo Tenant' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Nueva empresa' })).toBeVisible();

  // Slug ya en uso por otra empresa: el chequeo local corta antes de llamar a la API.
  await fillTenantModal(page, 'Empresa dup', existente.slug);
  await expect(
    page.getByText(`Ya existe una empresa con el slug ${existente.slug}.`),
  ).toBeVisible();

  // Slug libre: persiste (POST /tenants) y la fila aparece.
  const nuevoSlug = uniqueSlug('emp');
  await fillTenantModal(page, 'Empresa nueva', nuevoSlug);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(rowWith(page, nuevoSlug)).toBeVisible();
});

test('FE-TEN-04: la empresa de sistema tiene el slug bloqueado y no se puede dar de baja', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/tenants');

  const systemRow = rowWith(page, 'Sistema');
  // El botón "Dar de baja" de la empresa de sistema está deshabilitado (aria-disabled) con motivo.
  await expect(systemRow.getByRole('button', { name: 'Dar de baja' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  // Al abrir su edición, el slug está bloqueado con la leyenda correspondiente; el nombre no.
  await systemRow.getByRole('button', { name: 'Editar' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('#tenant-slug')).toBeDisabled();
  await expect(dialog.getByText('El slug de la empresa de sistema no se puede cambiar.')).toBeVisible();
  await expect(dialog.locator('#tenant-name')).toBeEnabled();
});

test('FE-TEN-05: baja lógica y reactivación por fila con confirmación inline', async ({ page }) => {
  const empresa = await createTenant(admin);

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/tenants');

  // Baja: confirmación inline roja.
  await rowWith(page, empresa.slug).getByRole('button', { name: 'Dar de baja' }).click();
  await expect(
    page.getByText(`¿Dar de baja la empresa ${empresa.name}?`, { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sí, dar de baja' }).click();
  // Sale del listado por defecto (queda dada de baja).
  await expect(rowWith(page, empresa.slug)).toHaveCount(0);

  // Reactivación: se muestra con el toggle y se restaura con la confirmación inline verde.
  await page.getByRole('checkbox', { name: 'Mostrar dados de baja' }).check();
  await rowWith(page, empresa.slug).getByRole('button', { name: 'Reactivar' }).click();
  await expect(
    page.getByText(`¿Reactivar la empresa ${empresa.name}?`, { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sí, reactivar' }).click();
  await expect(rowWith(page, empresa.slug).getByText('Dada de baja')).toHaveCount(0);
});

test(
  'FE-TEN-06: crear una empresa se refleja también en el selector del sidebar',
  async ({ page }) => {
    await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
    await page.goto('/dashboard/tenants');
    // El selector del sidebar del superadmin ya montó con /tenants/all.
    await expect(page.locator('aside select')).toBeVisible();

    const name = `Empresa selector ${Date.now()}`;
    const slug = uniqueSlug('sel');
    await page.getByRole('button', { name: 'Nuevo Tenant' }).click();
    await fillTenantModal(page, name, slug);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // La tabla sí la muestra de inmediato.
    await expect(rowWith(page, slug)).toBeVisible();

    // La empresa nueva debe estar en el selector sin recargar (el sidebar refresca su lista al
    // recibir el evento que emite la pantalla).
    await expect(page.locator(`aside select option:has-text("${name}")`)).toBeAttached({
      timeout: 5000,
    });
  },
);

test(
  'FE-TEN-07: renombrar una empresa se refleja también en el selector del sidebar',
  async ({ page }) => {
    // La empresa existe ANTES de montar, así que el sidebar la cachea con su nombre viejo; al
    // renombrarla, el evento de la pantalla lo hace refrescar.
    const empresa = await createTenant(admin);

    await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
    await page.goto('/dashboard/tenants');
    await expect(page.locator(`aside select option:has-text("${empresa.name}")`)).toBeAttached();

    const nuevoNombre = `${empresa.name} RENOMBRADA`;
    await rowWith(page, empresa.slug).getByRole('button', { name: 'Editar' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#tenant-name').fill(nuevoNombre);
    await dialog.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // La tabla ya muestra el nombre nuevo.
    await expect(rowWith(page, nuevoNombre)).toBeVisible();

    // El selector debe mostrar el nombre nuevo sin recargar.
    await expect(page.locator(`aside select option:has-text("${nuevoNombre}")`)).toBeAttached({
      timeout: 5000,
    });
  },
);
