/**
 * Bloque 3.1 del plan de pruebas — Infraestructura transversal (sesión, tenant activo, menú).
 *
 * Casos FE-INF-01..19, menos FE-INF-17 (se difiere al bloque 3.4 — Usuarios —, donde vive el
 * filtro "Empresa:" de la pantalla que compara).
 *
 * Corren contra el web aislado (`localhost:3100`); la siembra va por la API real (`localhost:3101`)
 * como el SuperAdmin del seed. La mayoría de los casos inyectan la sesión en `localStorage` para
 * arrancar autenticados sin ejercitar el login (eso es del bloque 3.2); los que prueban el propio
 * mecanismo de sesión (redirecciones, logout) lo montan a mano.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  adminContext,
  apiLogin,
  createTenant,
  createUserWithPermissions,
  type AdminCtx,
} from './support/seed';
import { injectSession } from './support/session';
import { API_URL } from './support/ports';

let admin: AdminCtx;

test.beforeEach(async () => {
  // Token fresco por test: evita que uno lento tope los 15 min de expiración del access token.
  admin = await adminContext();
});

/** Ítem del menú lateral por su texto exacto. */
function menuLink(page: Page, name: string) {
  return page.getByRole('link', { name, exact: true });
}

const ALL_MENU_ITEMS = [
  'Dashboard',
  'Usuarios',
  'Tenants',
  'Áreas',
  'Roles',
  'Flujos IVR',
  'Fuentes de Verdad',
  'Configuración',
];

/** Autentica a un usuario común por la API y devuelve token + su empresa (para inyectar sesión). */
async function sessionForUser(email: string, password: string, activeTenant: string) {
  const res = await apiLogin(email, password);
  expect(res.accessToken, 'el usuario común debería loguear sin OTP (sin device previo)').toBeTruthy();
  return { token: res.accessToken as string, activeTenant };
}

test('FE-INF-01: entrar a /dashboard sin sesión redirige a /login', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login\/?$/);
});

test('FE-INF-02: entrar a la raíz redirige a /login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\/?$/);
});

test('FE-INF-03: recargar con sesión válida re-consulta /auth/me y mantiene la sesión', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard\/?$/);

  const authMeCalls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/auth/me')) authMeCalls.push(r.url());
  });

  await page.reload();
  await expect(page).toHaveURL(/\/dashboard\/?$/);
  await expect.poll(() => authMeCalls.length).toBeGreaterThan(0);
});

test('FE-INF-04: un token inválido al montar cierra la sesión y manda a /login', async ({
  page,
}) => {
  await injectSession(page, { token: 'token-basura-invalido', activeTenant: admin.systemTenantId });
  await page.goto('/dashboard');

  // GET /auth/me responde 401 → apiFetch/logout limpian localStorage y redirigen.
  await expect(page).toHaveURL(/\/login\/?$/);
  // `waitForFunction` corre dentro de la página y sobrevive a la navegación (a diferencia de un
  // `page.evaluate` suelto, que puede pegarle a un contexto ya destruido por el redirect).
  await page.waitForFunction(() => localStorage.getItem('token') === null);
});

test('FE-INF-05: toda request del panel lleva Authorization y X-Tenant-Id (aun con una sola empresa)', async ({
  page,
}) => {
  const authMeHeaders: Array<Record<string, string>> = [];
  page.on('request', (r) => {
    if (r.url().includes('/auth/me')) authMeHeaders.push(r.headers());
  });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard\/?$/);

  await expect.poll(() => authMeHeaders.length).toBeGreaterThan(0);
  const headers = authMeHeaders[0];
  expect(headers['authorization']).toMatch(/^Bearer /);
  expect(headers['x-tenant-id']).toBe(admin.systemTenantId);
});

test('FE-INF-06: cambiar de empresa en el selector persiste y recarga contra el tenant nuevo', async ({
  page,
}) => {
  const tenant = await createTenant(admin);

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard');

  const selector = page.locator('aside select');
  // El sidebar del superadmin trae /tenants/all; esperamos a que la empresa nueva aparezca.
  await expect(selector.locator(`option[value="${tenant.id}"]`)).toBeAttached();

  const newTenantRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/auth/me') && r.headers()['x-tenant-id'] === tenant.id) {
      newTenantRequests.push(r.url());
    }
  });

  await selector.selectOption(tenant.id);

  // setActiveTenant persiste el nuevo id y recarga; tras la recarga se re-consulta con él.
  // `waitForFunction` sobrevive al reload; la lectura del array de requests es JS en Node.
  await page.waitForFunction((id) => localStorage.getItem('activeTenant') === id, tenant.id);
  await expect.poll(() => newTenantRequests.length).toBeGreaterThan(0);
});

test('FE-INF-07: el sidebar de un usuario común solo muestra los ítems con permiso', async ({
  page,
}) => {
  const user = await createUserWithPermissions(admin, ['users:read']);
  const session = await sessionForUser(user.email, user.password, admin.systemTenantId);

  await injectSession(page, session);
  await page.goto('/dashboard');

  await expect(menuLink(page, 'Usuarios')).toBeVisible();
  for (const item of ['Dashboard', 'Roles', 'Áreas', 'Tenants', 'Configuración', 'Flujos IVR', 'Fuentes de Verdad']) {
    await expect(menuLink(page, item)).toHaveCount(0);
  }
});

test('FE-INF-08: los ítems solo-sistema aparecen para un miembro del sistema con contexto de sistema', async ({
  page,
}) => {
  // Rama positiva: usuario común, miembro de la empresa de sistema, con los permisos → los ve.
  const user = await createUserWithPermissions(admin, ['tenants:read', 'settings:read']);
  const session = await sessionForUser(user.email, user.password, admin.systemTenantId);

  await injectSession(page, session);
  await page.goto('/dashboard');

  await expect(menuLink(page, 'Tenants')).toBeVisible();
  await expect(menuLink(page, 'Configuración')).toBeVisible();
});

test('FE-INF-08b: el mismo permiso en contexto NO-sistema oculta los ítems solo-sistema', async ({
  page,
}) => {
  // Contraparte de FE-INF-08: los ítems solo-sistema los gatea el CONTEXTO, no el permiso. Un
  // usuario común miembro de una empresa NO-sistema, con tenants:read + settings:read, NO debe
  // verlos (permiso correcto, contexto equivocado). El usuario se siembra en la empresa no-sistema
  // gracias al bypass del superusuario en TenantGuard (createUserWithPermissions con tenantId).
  const tenant = await createTenant(admin);
  const user = await createUserWithPermissions(admin, ['tenants:read', 'settings:read'], {
    tenantId: tenant.id,
  });
  const session = await sessionForUser(user.email, user.password, tenant.id);

  await injectSession(page, session);
  await page.goto('/dashboard');
  // Esperar a que el sidebar monte con la sesión del usuario (su email aparece en el panel). Con
  // eso confirmado, el menú ya se calculó: los ítems solo-sistema NO están (contexto no-sistema),
  // aunque el rol tenga tenants:read y settings:read.
  await expect(page.getByText(user.email)).toBeVisible();
  await expect(menuLink(page, 'Tenants')).toHaveCount(0);
  await expect(menuLink(page, 'Configuración')).toHaveCount(0);
});

test('FE-INF-09: un usuario de una sola empresa no ve el selector', async ({ page }) => {
  const user = await createUserWithPermissions(admin, ['users:read']);
  const session = await sessionForUser(user.email, user.password, admin.systemTenantId);

  await injectSession(page, session);
  await page.goto('/dashboard');
  await expect(menuLink(page, 'Usuarios')).toBeVisible();

  await expect(page.locator('aside select')).toHaveCount(0);
});

test('FE-INF-10: "Todas las empresas" activa el modo consolidado y traduce el header al de sistema', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard');

  const consolidatedRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/auth/me') && r.headers()['x-tenant-id'] === admin.systemTenantId) {
      consolidatedRequests.push(r.url());
    }
  });

  await page.locator('aside select').selectOption('__all__');

  await page.waitForFunction(() => localStorage.getItem('activeTenant') === '__all__');
  // El centinela __all__ no es una empresa: apiFetch lo traduce al id de sistema en X-Tenant-Id.
  await expect.poll(() => consolidatedRequests.length).toBeGreaterThan(0);
});

test('FE-INF-11: cerrar sesión limpia el almacenamiento y redirige a /login', async ({ page }) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard');
  await expect(menuLink(page, 'Dashboard')).toBeVisible();
  // Esperar a que no queden requests en vuelo: una respuesta con X-Access-Token (sesión
  // deslizante) que llegara DESPUÉS de clearSession volvería a escribir el token en localStorage.
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: 'Cerrar sesión' }).click();

  await expect(page).toHaveURL(/\/login\/?$/);
  await page.waitForFunction(
    () => localStorage.getItem('token') === null && localStorage.getItem('activeTenant') === null,
  );
});

test('FE-INF-12: un error del backend muestra su mensaje, no uno genérico', async ({ page }) => {
  const backendMessage = 'Explotó el backend a propósito (e2e)';
  // Ruta scopeada a la API (no `**/areas`, que interceptaría también la navegación del documento
  // /dashboard/areas y dejaría el JSON crudo en pantalla — un falso verde).
  await page.route(`${API_URL}/areas`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ message: backendMessage }),
    });
  });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/areas');

  await expect(page.getByText(backendMessage)).toBeVisible();
});

test('FE-INF-13: el superadmin ve SIEMPRE el menú completo, esté donde esté en el selector', async ({
  page,
}) => {
  // NOTA: describe una regresión ya corregida (el bug era que al superadmin le desaparecían
  // Tenants y Configuración al pararse en una empresa común). El código lo resuelve en
  // sidebar.tsx (`isSuperAdmin ? menuDefinition : filtrado`), así que se prueba como
  // comportamiento seguro (verde). La fila vigente del plan ya figura en `✅` con esa misma
  // descripción — test y plan quedan consistentes.
  const tenant = await createTenant(admin);

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard');
  for (const item of ALL_MENU_ITEMS) {
    await expect(menuLink(page, item)).toBeVisible();
  }

  // Parado en una empresa común: el menú NO cambia (las 8 opciones siguen, incluidas las
  // solo-sistema).
  const selector = page.locator('aside select');
  await expect(selector.locator(`option[value="${tenant.id}"]`)).toBeAttached();
  await selector.selectOption(tenant.id);
  await page.waitForFunction((id) => localStorage.getItem('activeTenant') === id, tenant.id);

  for (const item of ALL_MENU_ITEMS) {
    await expect(menuLink(page, item)).toBeVisible();
  }
});

test('FE-INF-14: X-Access-Token de una respuesta autenticada pisa el token de localStorage', async ({
  page,
}) => {
  let refreshed: string | undefined;
  page.on('response', (resp) => {
    if (resp.url().includes('/auth/me')) {
      const header = resp.headers()['x-access-token'];
      if (header) refreshed = header;
    }
  });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard\/?$/);

  // El interceptor de sesión deslizante reemite el token en cada request autenticado; apiFetch
  // lo guarda en localStorage.token, así que este pasa a valer lo que vino en el header.
  await expect.poll(() => refreshed).toBeTruthy();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('token')))
    .toBe(refreshed);
});

test('FE-INF-15: un 401 con token presente cierra la sesión y redirige de inmediato', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard\/?$/);

  // El listado de Usuarios responde 401 (sesión caída del lado servidor) con el token puesto.
  // Ruta scopeada a la API para no interceptar la navegación del documento /dashboard/users.
  // Con el admin parado en una empresa puntual (no consolidado), la pantalla llama a `/users`.
  await page.route(`${API_URL}/users`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'No autorizado' }),
    });
  });

  await page.goto('/dashboard/users');

  // El redirect a /login ante un 401 con token lo dispara SOLO clearSession(): alcanza como prueba
  // de que se cerró la sesión. El vaciado del localStorage se verifica en FE-INF-11 (con networkidle,
  // para no chocar con la carrera de la sesión deslizante).
  await expect(page).toHaveURL(/\/login\/?$/);
});

test.fail(
  'FE-INF-16: parado en una pantalla solo-sistema, cambiar a una empresa no-sistema debería sacar al usuario al dashboard @invertido',
  async ({ page }) => {
    // Comportamiento SEGURO esperado (hoy NO implementado): al cambiar el selector a una empresa
    // que ya no tiene esta pantalla en el menú, la app debería redirigir al dashboard. Hoy la
    // recarga deja al usuario en la misma URL huérfana (/dashboard/tenants). `test.fail` da verde
    // mientras el bug siga vivo; cuando se corrija, gritará "sacá el marcador".
    const tenant = await createTenant(admin);

    await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
    await page.goto('/dashboard/tenants');
    await expect(page).toHaveURL(/\/dashboard\/tenants\/?$/);

    const selector = page.locator('aside select');
    await expect(selector.locator(`option[value="${tenant.id}"]`)).toBeAttached();
    await selector.selectOption(tenant.id);

    // El cambio de empresa ya se aplicó (persistió + recargó); lo verificamos con waitForFunction
    // para que el `test.fail` falle por la ASERCIÓN de abajo (la redirección), no por una carrera
    // de contexto destruido durante el reload.
    await page.waitForFunction((id) => localStorage.getItem('activeTenant') === id, tenant.id);
    // Lo esperado (hoy NO implementado): haber sido redirigido fuera de la pantalla solo-sistema.
    await expect(page).toHaveURL(/\/dashboard\/?$/);
  },
);

test('FE-INF-18: un miembro común del tenant de sistema NO ve el menú completo ni "Todas las empresas"', async ({
  page,
}) => {
  // Miembro de la EMPRESA DE SISTEMA con un rol propio (NO SuperAdmin): createUserWithPermissions
  // siembra en el tenant de sistema y le crea un rol nuevo con solo `users:read`, así que el
  // backend lo devuelve con `isSuperAdmin: false` (el rol no es el SuperAdmin del seed) aunque
  // `isSystemMember` sea true. Es justo el escalón que separa "pertenecer al sistema" de "ser
  // superusuario": el sidebar arma el menú completo SOLO para `isSuperAdmin`, no para cualquier
  // miembro del sistema, y `useAuth` ya no hereda el rol de sistema a un no-superadmin.
  const user = await createUserWithPermissions(admin, ['users:read']);
  const session = await sessionForUser(user.email, user.password, admin.systemTenantId);

  await injectSession(page, session);
  await page.goto('/dashboard');

  // Ve solo lo que su rol permite: aparece Usuarios (tiene users:read)...
  await expect(menuLink(page, 'Usuarios')).toBeVisible();
  // ...pero NO el menú completo. Las 7 opciones restantes no se renderizan: ni las que exigen otro
  // permiso (Dashboard, Roles, Áreas, Flujos IVR, Fuentes de Verdad), ni las solo-sistema (Tenants,
  // Configuración), que además de estar en contexto de sistema requieren el permiso — que no tiene.
  for (const item of [
    'Dashboard',
    'Tenants',
    'Áreas',
    'Roles',
    'Flujos IVR',
    'Fuentes de Verdad',
    'Configuración',
  ]) {
    await expect(menuLink(page, item)).toHaveCount(0);
  }

  // No es superadmin y pertenece a una sola empresa: el selector no se renderiza y, con él, tampoco
  // la opción global "🌐 Todas las empresas" (que el sidebar reserva para `isSuperAdmin`). Un
  // superadmin, en cambio, tendría selector + esa opción + el menú de 8 ítems (ver FE-INF-13).
  await expect(page.locator('aside select')).toHaveCount(0);
  await expect(page.getByRole('option', { name: '🌐 Todas las empresas' })).toHaveCount(0);
});

test('FE-INF-19: la navegación del panel usa rutas con barra final y el editor de flujos viaja por query', async ({
  page,
}) => {
  // El build de producción sirve el estático con `output:'export'` + `trailingSlash` (ver
  // next.config.ts): cada ruta se emite como `carpeta/index.html`. En el stack e2e `output:'export'`
  // se OMITE (el web corre con `next start`, modo servidor), así que la EMISIÓN física de esos
  // `index.html` no se puede asertar acá. Lo que SÍ se conserva en e2e —a propósito— es
  // `trailingSlash`, que es la causa observable: se verifica navegando (URLs con barra final, editor
  // por query, sin 404 ni redirects de más), que es lo que de verdad importa del caso.
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });

  // 1) Forma canónica: entrar a /dashboard queda en /dashboard/ (un único redirect a la barra
  //    final, no "de más").
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard\/$/);

  // 2) Menú completo (superadmin) y sin links rotos: cada ítem apunta a una ruta interna del panel.
  for (const item of ALL_MENU_ITEMS) {
    const href = await menuLink(page, item).getAttribute('href');
    expect(href, `${item} debería enlazar a una ruta interna`).toMatch(/^\//);
  }

  // 3) `router.push`/`Link` llevan barra final: navegar por el menú aterriza en la forma canónica y
  //    la pantalla monta de verdad (layout con sidebar + su encabezado), no un 404.
  await menuLink(page, 'Usuarios').click();
  await expect(page).toHaveURL(/\/dashboard\/users\/$/);
  await expect(page.getByRole('heading', { name: 'Usuarios' })).toBeVisible();
  await expect(page.locator('aside')).toBeVisible();

  // 4) El editor de flujos viaja por QUERY (`/dashboard/flows/edit/?id=…`), no por ruta dinámica
  //    `[id]` (que el export no soporta sin generateStaticParams). "Nuevo Flujo" hace
  //    router.push('/dashboard/flows/edit/?id=new').
  await page.goto('/dashboard/flows');
  await expect(page).toHaveURL(/\/dashboard\/flows\/$/);
  await page.getByRole('button', { name: 'Nuevo Flujo' }).click();
  await expect(page).toHaveURL(/\/dashboard\/flows\/edit\/\?id=new$/);
  // El editor montó (no 404): su input de nombre está presente.
  await expect(page.getByPlaceholder('Nombre del flujo')).toBeVisible();
});
