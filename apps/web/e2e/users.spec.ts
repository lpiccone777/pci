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

/* ------------------------------------------------------------------ */
/* Importación masiva desde Excel (`import-users-modal.tsx`)           */
/*                                                                     */
/* El modal parsea el archivo en el navegador con la librería `xlsx`   */
/* (`parseSpreadsheet`), que también lee CSV: por eso los fixtures se  */
/* generan como buffers `.csv` en memoria (más estable que un binario  */
/* `.xlsx`) y se suben con `setInputFiles` al <input type=file> oculto */
/* del paso "upload". El mapeo columna→campo se hace por CLICK (elegir */
/* la etiqueta y después la columna), no por drag&drop, porque el      */
/* componente soporta ambos y el click es determinístico en Playwright.*/
/* ------------------------------------------------------------------ */

/** Sube un archivo en memoria al input oculto del paso 1 (acepta `.xlsx/.xls/.csv`). */
async function uploadFile(dialog: Locator, name: string, content: string, mimeType = 'text/csv') {
  await dialog
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType, buffer: Buffer.from(content, 'utf-8') });
}

/** Selecciona el <select> "Rol por defecto" del paso de mapeo por su primera opción-placeholder. */
function defaultRoleSelect(page: Page, dialog: Locator) {
  return dialog.locator('select', { has: page.getByRole('option', { name: 'Elegí un rol...' }) });
}

/** Mapea un campo requerido a una columna: click en la etiqueta, después click en el <th>. */
async function mapFieldToHeader(dialog: Locator, fieldLabel: string, headerText: string) {
  await dialog.getByRole('button', { name: fieldLabel, exact: true }).click();
  await dialog.locator('thead th').filter({ hasText: headerText }).first().click();
}

test('FE-USR-17: importar desde Excel recorre subir→mapear→resultado y postea a /users/bulk-import', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  // Un rol en la empresa activa: es el "Rol por defecto" obligatorio del paso de mapeo.
  const role = await createRole(admin, { tenantId: tenant.id, name: 'Importados', permissions: ['users:read'] });
  const okEmail = uniqueEmail('bulk-ok');

  // La fila 3 reusa el email de un usuario que YA existe → el backend la rechaza por fila con
  // 'Ya existe un usuario con ese email' (users.service.ts `bulkImport`), sin abortar el lote.
  // Ojo: una fila con email VACÍO no sirve para esto — `BulkImportUserRowDto.email` es `@IsEmail`
  // y NO opcional, así que un email vacío hace fallar la validación del DTO y devuelve 400 sobre
  // TODO el lote (nunca se llega al paso "result"); la rama 'Falta el email' del service es
  // defensiva e inalcanzable por este endpoint. Por eso el rechazo por fila se prueba con un
  // email duplicado, que sí pasa el DTO y falla recién en la lógica de importación.
  const dupEmail = uniqueEmail('bulk-dup');
  await createUser(admin, {
    email: dupEmail,
    memberships: [{ tenantId: tenant.id, roleId: role.id }],
  });

  // Se captura el POST real a /users/bulk-import para fundar endpoint + header de empresa activa.
  const bulkPosts: Array<{ url: string; tenant: string | undefined }> = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/users/bulk-import')) {
      bulkPosts.push({ url: r.url(), tenant: r.headers()['x-tenant-id'] });
    }
  });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Importar desde Excel' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Importar usuarios desde Excel' })).toBeVisible();

  // Fila 2 (Ana) es válida; fila 3 (Bruno) reusa un email ya existente → el backend la rechaza.
  const csv = ['Nombre,Apellido,Email', `Ana,Perez,${okEmail}`, `Bruno,Gomez,${dupEmail}`].join('\n');
  await uploadFile(dialog, 'usuarios.csv', csv);

  // Avanza a "map": el subtítulo reporta el archivo y las filas de datos detectadas.
  await expect(dialog.getByText('usuarios.csv', { exact: false })).toBeVisible();
  await expect(dialog.getByText('2 filas detectadas', { exact: false })).toBeVisible();

  // Mapeo de los 3 requeridos + rol por defecto → habilita "Importar 2 usuarios".
  await mapFieldToHeader(dialog, 'Nombre *', 'Nombre');
  await mapFieldToHeader(dialog, 'Apellido *', 'Apellido');
  await mapFieldToHeader(dialog, 'Email *', 'Email');
  await defaultRoleSelect(page, dialog).selectOption({ label: role.name });

  const importBtn = dialog.getByRole('button', { name: /Importar 2 usuarios/ });
  await expect(importBtn).toBeEnabled();
  await importBtn.click();

  // Paso "result": creados con contraseña temporal + botón de descarga, y el fallido con fila y motivo.
  await expect(dialog.getByRole('heading', { name: 'Resultado de la importación' })).toBeVisible();
  await expect(dialog.getByText('1 importado', { exact: false })).toBeVisible();
  await expect(dialog.getByText('Descargar CSV')).toBeVisible();
  await expect(dialog.getByText(okEmail)).toBeVisible();
  await expect(dialog.getByText('Fila 3')).toBeVisible();
  await expect(dialog.getByText('Ya existe un usuario con ese email')).toBeVisible();

  // El POST fue al endpoint correcto y con el header de la empresa activa.
  expect(bulkPosts.length).toBeGreaterThan(0);
  expect(bulkPosts[0].tenant).toBe(tenant.id);
});

test('FE-USR-18: en "Todas las empresas" no aparece el botón ni monta el modal de importación', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  await createRole(admin, { tenantId: tenant.id, permissions: ['users:read'] });
  // Usuario sin permiso de crear: ni con empresa concreta ve el botón (gate `canCreate`).
  const lector = await createUserWithPermissions(admin, ['users:read'], { tenantId: tenant.id });

  // Superadmin (canCreate) parado en una empresa concreta → el botón está.
  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/users');
  await expect(page.getByRole('button', { name: 'Importar desde Excel' })).toBeVisible();

  // Mismo superadmin en modo consolidado → el botón desaparece y el modal no monta.
  await injectSession(page, { token: admin.token, activeTenant: ALL_TENANTS });
  await page.goto('/dashboard/users');
  await expect(page.getByRole('columnheader', { name: 'Empresa' })).toBeVisible(); // confirma consolidado
  await expect(page.getByRole('button', { name: 'Importar desde Excel' })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Importar usuarios desde Excel' }),
  ).toHaveCount(0);

  // Sin canCreate, en empresa concreta, tampoco.
  await injectSession(page, await sessionForUser(lector.email, lector.password, tenant.id));
  await page.goto('/dashboard/users');
  await expect(page.getByRole('button', { name: 'Importar desde Excel' })).toHaveCount(0);
});

test('FE-USR-19: archivo no soportado, sin filas o con más de 10.000 filas → error y no postea', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  await createRole(admin, { tenantId: tenant.id, permissions: ['users:read'] });

  const bulkPosts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/users/bulk-import')) bulkPosts.push(r.url());
  });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Importar desde Excel' }).click();
  const dialog = page.getByRole('dialog');

  // 1) Extensión no soportada → mensaje del validador `isSupportedFile`, no avanza a "map".
  await uploadFile(dialog, 'datos.txt', 'lo que sea', 'text/plain');
  await expect(dialog.getByText('El archivo tiene que ser .xlsx, .xls o .csv.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Nombre *', exact: true })).toHaveCount(0);

  // 2) Solo headers, sin filas de datos → `parseSpreadsheet` corta con su mensaje.
  await uploadFile(dialog, 'solo-headers.csv', 'Nombre,Apellido,Email');
  await expect(dialog.getByText('El archivo no tiene filas de datos.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Nombre *', exact: true })).toHaveCount(0);

  // 3) Más de MAX_ROWS (10000) filas → corte del lado del cliente antes de armar el mapeo.
  const bigRows = Array.from({ length: 10001 }, (_, i) => `N${i},A${i},u${i}@e.local`);
  await uploadFile(dialog, 'enorme.csv', ['Nombre,Apellido,Email', ...bigRows].join('\n'));
  await expect(dialog.getByText('el máximo por importación es 10000', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Nombre *', exact: true })).toHaveCount(0);

  // En ningún caso se llegó a postear al backend.
  expect(bulkPosts).toHaveLength(0);
});

test('FE-USR-20: headers vacíos/repetidos → "Columna N", mapeo por índice y bloqueo sin los 3 requeridos', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  await createRole(admin, { tenantId: tenant.id, permissions: ['users:read'] });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Importar desde Excel' }).click();
  const dialog = page.getByRole('dialog');

  // Header con una columna repetida ("Email","Email") y una sin nombre (col 3 vacía).
  await uploadFile(dialog, 'raro.csv', ['Email,Email,', 'a@e.local,b@e.local,x'].join('\n'));

  // La columna sin header se renombra "Columna 3" (índice 1-based); es el 3.º <th>.
  await expect(dialog.locator('thead th').nth(2)).toContainText('Columna 3');

  // Mapeo por índice: asignar Email al 1.º <th> deja la etiqueta como "✓ Email".
  await dialog.getByRole('button', { name: 'Email *', exact: true }).click();
  await dialog.locator('thead th').nth(0).click();
  await expect(dialog.getByRole('button', { name: '✓ Email' })).toBeVisible();

  // Una columna, un solo campo: reasignar el MISMO <th> a "Nombre" libera Email (vuelve a "Email *").
  await dialog.getByRole('button', { name: 'Nombre *', exact: true }).click();
  await dialog.locator('thead th').nth(0).click();
  await expect(dialog.getByRole('button', { name: '✓ Nombre' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Email *', exact: true })).toBeVisible();

  // Sin los 3 requeridos (falta Apellido/Email) + sin rol → aviso y botón de importar deshabilitado.
  await expect(dialog.getByText('para poder importar', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Importar 1 usuario/ })).toBeDisabled();
});
