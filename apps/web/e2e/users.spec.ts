/**
 * Bloque 3.4 del plan de pruebas — Usuarios (`/dashboard/users`).
 *
 * Casos FE-USR-01..16. Corren contra el web aislado (`localhost:3100`); la siembra va por la API
 * real (`localhost:3101`). El ABM es multiempresa: cada test crea sus empresas, roles y usuarios,
 * y se para en la empresa que necesita vía sesión inyectada.
 *
 * La pantalla no tiene `data-testid` ni asocia labels a inputs (PersonField y los selects de
 * membresía rinden `<label>` + control como hermanos), así que los campos se anclan por
 * adyacencia CSS (`label:text-is("X") + input/select`), por tipo (`input[type=email/password]`)
 * o por `title`/`placeholder`. Los modales son `role="dialog"`.
 *
 * FE-USR-15 y FE-USR-16 son casos invertidos (`❌` por diseño): verifican el comportamiento
 * SEGURO esperado y van con `test.fail` (rojo esperado hoy; cuando se corrija el bug, saltarán).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import {
  adminContext,
  apiLogin,
  createTenant,
  createRole,
  createUser,
  createUserWithPermissions,
  uniqueEmail,
  uniquePassword,
  type AdminCtx,
} from './support/seed';
import { injectSession } from './support/session';

const ALL_TENANTS = '__all__';

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

/** Input de un PersonField por su label (no hay asociación, se usa adyacencia). */
function personInput(dialog: Locator, label: string) {
  return dialog.locator(`label:text-is("${label}") + input`);
}

/** Selecciona un rol en la (última) membresía abierta del editor. */
async function pickRole(dialog: Locator, roleName: string) {
  await dialog.locator('label:text-is("Rol *") + select').last().selectOption({ label: roleName });
}

test('FE-USR-01: el botón "Nuevo usuario" aparece sólo con users:create y abre el alta', async ({
  page,
}) => {
  // Con users:create (+ roles:read para que el alta funcione) → ve el botón y abre el modal.
  const creador = await createUserWithPermissions(admin, ['users:read', 'users:create', 'roles:read']);
  await injectSession(page, await sessionForUser(creador.email, creador.password, admin.systemTenantId));
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Nuevo usuario' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Nuevo usuario' })).toBeVisible();

  // Sólo lectura → no ve el botón de alta.
  const lector = await createUserWithPermissions(admin, ['users:read']);
  await injectSession(page, await sessionForUser(lector.email, lector.password, admin.systemTenantId));
  await page.goto('/dashboard/users');
  await expect(page.getByRole('button', { name: 'Nuevo usuario' })).toHaveCount(0);
});

test('FE-USR-02: alta multiempresa con rol válido llama a /users/multi y refresca la lista', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, name: 'Operador', permissions: ['users:read'] });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Nuevo usuario' }).click();
  const dialog = page.getByRole('dialog');

  const email = uniqueEmail('alta');
  await personInput(dialog, 'Nombre *').fill('Nuevo');
  await personInput(dialog, 'Apellido *').fill('Usuario');
  await dialog.locator('input[type="email"]').fill(email);
  await dialog.locator('input[type="password"]').fill(uniquePassword());
  await pickRole(dialog, role.name); // la empresa activa viene pre-agregada como membresía

  await dialog.getByRole('button', { name: 'Crear' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(rowWith(page, email)).toBeVisible();
});

test('FE-USR-03: el alta bloquea Guardar sin empresa o con una empresa sin rol', async ({ page }) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['users:read'] });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Nuevo usuario' }).click();
  const dialog = page.getByRole('dialog');
  const crear = dialog.getByRole('button', { name: 'Crear' });

  // Empresa pre-agregada pero sin rol → bloqueado.
  await expect(crear).toBeDisabled();
  // Sin ninguna empresa (se quita la pre-agregada) → sigue bloqueado.
  await dialog.getByRole('button', { name: 'Quitar' }).click();
  await expect(crear).toBeDisabled();
  // Se re-agrega la empresa y se elige rol → habilitado.
  await dialog
    .locator('select', { has: page.getByRole('option', { name: '+ Agregar empresa…' }) })
    .selectOption({ label: tenant.name });
  await expect(crear).toBeDisabled();
  await pickRole(dialog, role.name);
  await expect(crear).toBeEnabled();
});

test('FE-USR-04: un dato en uso dispara el chequeo en vivo y deshabilita Guardar', async ({ page }) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['users:read'] });
  const ocupante = await createUser(admin, { memberships: [{ tenantId: tenant.id, roleId: role.id }] });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Nuevo usuario' }).click();
  const dialog = page.getByRole('dialog');

  const email = dialog.locator('input[type="email"]');
  await email.fill(ocupante.email);
  await email.blur(); // onBlur → GET /users/check-availability

  await expect(dialog.getByText('Ya está en uso por', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Crear' })).toBeDisabled();
});

test('FE-USR-05: si el solicitante puede ver al ocupante, el conflicto enlaza a su detalle', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['users:read'] });
  const ocupante = await createUser(admin, {
    memberships: [{ tenantId: tenant.id, roleId: role.id }],
    firstName: 'Ocupante',
    lastName: 'Visible',
  });

  // El SuperAdmin ve a cualquiera → el conflicto trae el link al ocupante.
  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Nuevo usuario' }).click();
  const dialog = page.getByRole('dialog');

  const email = dialog.locator('input[type="email"]');
  await email.fill(ocupante.email);
  await email.blur();

  await dialog.getByRole('button', { name: /Ocupante/ }).click();
  await expect(page.getByText('Ya usa este dato')).toBeVisible();
});

test('FE-USR-06: un conflicto de una empresa que no administra no revela quién lo usa', async ({
  page,
}) => {
  // Ocupante en la empresa A.
  const tenantA = await createTenant(admin);
  const roleA = await createRole(admin, { tenantId: tenantA.id, permissions: ['users:read'] });
  const ocupante = await createUser(admin, { memberships: [{ tenantId: tenantA.id, roleId: roleA.id }] });

  // Solicitante que sólo administra la empresa B (no comparte empresa con el ocupante).
  const tenantB = await createTenant(admin);
  const solicitante = await createUserWithPermissions(
    admin,
    ['users:read', 'users:create', 'roles:read'],
    { tenantId: tenantB.id },
  );
  await createRole(admin, { tenantId: tenantB.id, permissions: ['users:read'] }); // para el dropdown

  await injectSession(page, await sessionForUser(solicitante.email, solicitante.password, tenantB.id));
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Nuevo usuario' }).click();
  const dialog = page.getByRole('dialog');

  const email = dialog.locator('input[type="email"]');
  await email.fill(ocupante.email);
  await email.blur();

  await expect(dialog.getByText('un usuario de otra empresa')).toBeVisible();
});

test('FE-USR-07: al editar, el email queda deshabilitado y la contraseña es opcional', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['users:read'] });
  const user = await createUser(admin, { memberships: [{ tenantId: tenant.id, roleId: role.id }] });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/users');
  await rowWith(page, user.email).getByRole('button', { name: 'Editar' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Editar usuario' })).toBeVisible();

  const emailInput = dialog.getByTitle('El email no se puede cambiar');
  await expect(emailInput).toBeDisabled();
  await expect(emailInput).toHaveValue(user.email);

  const pass = dialog.locator('input[placeholder="Dejar vacío para no cambiarla"]');
  await expect(pass).toBeVisible();
  // Opcional: sin el atributo required (se puede guardar sin tocarla).
  await expect(pass).not.toHaveAttribute('required', '');
});

test('FE-USR-08: el editor de membresías agrega una empresa y guarda con PATCH /users/:id/full', async ({
  page,
}) => {
  const t1 = await createTenant(admin);
  const t2 = await createTenant(admin);
  // Editor con permiso pleno en ambas empresas (para poder gestionar y agregar T2).
  const perms = ['users:read', 'users:create', 'users:update', 'users:delete', 'roles:read'];
  const mRole1 = await createRole(admin, { tenantId: t1.id, permissions: perms });
  const mRole2 = await createRole(admin, { tenantId: t2.id, permissions: perms });
  const editor = await createUser(admin, {
    memberships: [
      { tenantId: t1.id, roleId: mRole1.id },
      { tenantId: t2.id, roleId: mRole2.id },
    ],
  });
  // Usuario a editar: sólo en T1.
  const roleU1 = await createRole(admin, { tenantId: t1.id, permissions: ['users:read'] });
  const roleU2 = await createRole(admin, { tenantId: t2.id, name: 'Rol en T2', permissions: ['users:read'] });
  const target = await createUser(admin, { memberships: [{ tenantId: t1.id, roleId: roleU1.id }] });

  const patchFull: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && /\/users\/[^/]+\/full/.test(r.url())) patchFull.push(r.url());
  });

  await injectSession(page, await sessionForUser(editor.email, editor.password, t1.id));
  await page.goto('/dashboard/users');
  await rowWith(page, target.email).getByRole('button', { name: 'Editar' }).click();
  const dialog = page.getByRole('dialog');

  // Quitar T1 y Deshacer (mecánica del editor); no queda ninguna baja al guardar.
  await dialog.getByRole('button', { name: 'Quitar' }).click();
  await expect(dialog.getByText('se dará de baja al guardar', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Deshacer' }).click();

  // Agregar T2 y elegir su rol.
  await dialog
    .locator('select', { has: page.getByRole('option', { name: '+ Agregar empresa…' }) })
    .selectOption({ label: t2.name });
  await pickRole(dialog, roleU2.name);

  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => patchFull.length).toBeGreaterThan(0);

  // La membresía nueva quedó aplicada: el usuario ahora aparece parado en T2.
  await injectSession(page, { token: admin.token, activeTenant: t2.id });
  await page.goto('/dashboard/users');
  await expect(rowWith(page, target.email)).toBeVisible();
});

test('FE-USR-09: baja por fila con confirmación inline y DELETE con el header de esa empresa', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['users:read'] });
  const user = await createUser(admin, { memberships: [{ tenantId: tenant.id, roleId: role.id }] });

  const deleteHeaders: Array<string | undefined> = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE' && /\/users\/[^/]+$/.test(r.url())) {
      deleteHeaders.push(r.headers()['x-tenant-id']);
    }
  });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/users');
  await rowWith(page, user.email).getByRole('button', { name: 'Eliminar' }).click();
  await expect(page.getByText(/¿Dar de baja a/)).toBeVisible();
  await page.getByRole('button', { name: 'Sí, dar de baja' }).click();

  await expect(rowWith(page, user.email)).toHaveCount(0);
  await expect.poll(() => deleteHeaders.length).toBeGreaterThan(0);
  expect(deleteHeaders).toContain(tenant.id);
});

test('FE-USR-10: darse de baja a uno mismo queda deshabilitado con el motivo', async ({ page }) => {
  const tenant = await createTenant(admin);
  const self = await createUserWithPermissions(admin, ['users:read', 'users:delete'], {
    tenantId: tenant.id,
  });

  await injectSession(page, await sessionForUser(self.email, self.password, tenant.id));
  await page.goto('/dashboard/users');

  const eliminar = rowWith(page, self.email).getByRole('button', { name: 'Eliminar' });
  await expect(eliminar).toHaveAttribute('aria-disabled', 'true');
  // force: usa aria-disabled (no disabled) para poder clickearse y explicar el motivo.
  await eliminar.click({ force: true });
  await expect(page.getByText('No podés darte de baja a vos mismo.')).toBeVisible();
  await expect(rowWith(page, self.email)).toBeVisible();
});

test('FE-USR-11: en modo consolidado hay columna Empresa, filtro y una fila por membresía', async ({
  page,
}) => {
  const t1 = await createTenant(admin);
  const t2 = await createTenant(admin);
  const r1 = await createRole(admin, { tenantId: t1.id, permissions: ['users:read'] });
  const r2 = await createRole(admin, { tenantId: t2.id, permissions: ['users:read'] });
  const persona = await createUser(admin, {
    memberships: [
      { tenantId: t1.id, roleId: r1.id },
      { tenantId: t2.id, roleId: r2.id },
    ],
  });

  await injectSession(page, { token: admin.token, activeTenant: ALL_TENANTS });
  await page.goto('/dashboard/users');

  await expect(page.getByRole('columnheader', { name: 'Empresa' })).toBeVisible();
  await expect(page.getByText('Empresa:', { exact: true })).toBeVisible();
  // La persona aparece en las dos empresas (una fila por membresía).
  await expect(rowWith(page, persona.email)).toHaveCount(2);
  await expect(rowWith(page, persona.email).filter({ hasText: t1.name })).toHaveCount(1);
  await expect(rowWith(page, persona.email).filter({ hasText: t2.name })).toHaveCount(1);
});

test('FE-USR-12: en consolidado los botones por fila dependen del permiso en esa empresa', async ({
  page,
}) => {
  // M administra la empresa T1 (read/update/delete) y sólo lee la T2.
  const t1 = await createTenant(admin);
  const t2 = await createTenant(admin);
  const mRole1 = await createRole(admin, {
    tenantId: t1.id,
    permissions: ['users:read', 'users:update', 'users:delete'],
  });
  const mRole2 = await createRole(admin, { tenantId: t2.id, permissions: ['users:read'] });
  const m = await createUser(admin, {
    memberships: [
      { tenantId: t1.id, roleId: mRole1.id },
      { tenantId: t2.id, roleId: mRole2.id },
    ],
  });
  // Otro usuario en cada empresa, sobre el que M podría (o no) accionar.
  const roleA = await createRole(admin, { tenantId: t1.id, permissions: ['users:read'] });
  const roleB = await createRole(admin, { tenantId: t2.id, permissions: ['users:read'] });
  const userA = await createUser(admin, { memberships: [{ tenantId: t1.id, roleId: roleA.id }] });
  const userB = await createUser(admin, { memberships: [{ tenantId: t2.id, roleId: roleB.id }] });

  await injectSession(page, await sessionForUser(m.email, m.password, ALL_TENANTS));
  await page.goto('/dashboard/users');

  // En T1 (con update/delete): botones de acción presentes sobre el usuario A.
  await expect(rowWith(page, userA.email).getByRole('button', { name: 'Editar' })).toBeVisible();
  await expect(rowWith(page, userA.email).getByRole('button', { name: 'Eliminar' })).toBeVisible();
  // En T2 (sólo lectura): sin botón de edición sobre el usuario B.
  await expect(rowWith(page, userB.email).getByRole('button', { name: 'Editar' })).toHaveCount(0);
});

test('FE-USR-13: cerrar el alta con cambios pide confirmación antes de descartar', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  await createRole(admin, { tenantId: tenant.id, permissions: ['users:read'] });

  let confirmMessage: string | undefined;
  page.on('dialog', (d) => {
    confirmMessage = d.message();
    void d.accept();
  });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Nuevo usuario' }).click();
  const dialog = page.getByRole('dialog');
  await personInput(dialog, 'Nombre *').fill('Con cambios');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(confirmMessage).toBe('Tenés cambios sin guardar. ¿Descartarlos?');
});

test('FE-USR-14: un clic en la fila abre el detalle de solo lectura con botón Editar', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['users:read'] });
  const user = await createUser(admin, { memberships: [{ tenantId: tenant.id, roleId: role.id }] });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/users');
  // Clic sobre el texto de la fila (fuera de los botones, que hacen stopPropagation).
  await rowWith(page, user.email).getByText(user.email).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(user.email)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Editar' })).toBeVisible();
  // "Cerrar" del pie (la "×" del encabezado también tiene aria-label "Cerrar").
  await expect(dialog.locator('button', { hasText: 'Cerrar' })).toBeVisible();
});

test.fail(
  'FE-USR-15: cancelar un alta en blanco no debería avisar de cambios sin guardar @invertido',
  async ({ page }) => {
    const tenant = await createTenant(admin);
    await createRole(admin, { tenantId: tenant.id, permissions: ['users:read'] });

    // Comportamiento SEGURO esperado: abrir y cerrar sin tocar nada NO dispara el confirm.
    // Hoy sí lo hace (el preset de la empresa activa ya cuenta como "cambio"): el handler acepta
    // el diálogo y registra que apareció → la aserción de abajo falla → test.fail verde.
    let confirmShown = false;
    page.on('dialog', (d) => {
      confirmShown = true;
      void d.accept();
    });

    await injectSession(page, { token: admin.token, activeTenant: tenant.id });
    await page.goto('/dashboard/users');
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape'); // sin tocar nada
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(confirmShown).toBe(false);
  },
);

test.fail(
  'FE-USR-16: con users:create pero sin roles:read el alta debería poder elegir un rol @invertido',
  async ({ page }) => {
    const tenant = await createTenant(admin);
    const role = await createRole(admin, { tenantId: tenant.id, name: 'Rol existente', permissions: ['users:read'] });
    // Usuario con alta de usuarios pero SIN roles:read (la empresa SÍ tiene roles).
    const w = await createUserWithPermissions(admin, ['users:read', 'users:create'], {
      tenantId: tenant.id,
    });

    await injectSession(page, await sessionForUser(w.email, w.password, tenant.id));
    await page.goto('/dashboard/users');
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    const dialog = page.getByRole('dialog');

    // Comportamiento SEGURO esperado: el rol existente debería poder elegirse en el desplegable.
    // Hoy el GET /roles da 403, el dropdown queda vacío y la opción nunca aparece → falla → test.fail.
    await expect(dialog.getByRole('option', { name: role.name })).toBeAttached({ timeout: 8000 });
  },
);
