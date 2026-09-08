/**
 * Bloque 3.13 del plan de pruebas — Calendario de feriados/guardias
 * (`/dashboard/schedule-calendar`).
 *
 * Casos FE-CAL-01..07. Corren contra el web aislado (`localhost:3100`); la siembra va por la API
 * real (`localhost:3101`). Cada test crea su propia empresa y su propio usuario, y se para en esa
 * empresa con la sesión inyectada.
 *
 * La grilla la dibuja `react-big-calendar`: los anclajes son los textos en español de su barra
 * (Mes / Semana / Día / Hoy / Anterior / Siguiente) y el título de cada evento, que la pantalla
 * arma como `"<Tipo>: <título>"` (más 🔁 si repite y 🇦🇷 si vino del import). En la vista de MES
 * el título del evento se oculta a propósito (queda solo en el `title` del nodo, o sea el
 * tooltip), así que los asserts de texto visible se hacen en semana o día.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  adminContext,
  apiLogin,
  createTenant,
  createRole,
  createUser,
  createScheduleEntry,
  listScheduleEntries,
  uniquePassword,
  type AdminCtx,
} from './support/seed';
import { injectSession } from './support/session';

const CAL_PERMS = [
  'schedule-calendar:read',
  'schedule-calendar:create',
  'schedule-calendar:update',
  'schedule-calendar:delete',
];

let admin: AdminCtx;

test.beforeEach(async () => {
  admin = await adminContext();
});

/** Empresa + usuario con los permisos dados, ya logueado y parado en esa empresa. */
async function tenantConUsuario(permissions: string[], extraRoleName?: string) {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions });
  const password = uniquePassword();
  const user = await createUser(admin, {
    password,
    memberships: [{ tenantId: tenant.id, roleId: role.id }],
  });
  const login = await apiLogin(user.email, password);
  expect(login.accessToken, 'el usuario debería loguear sin OTP').toBeTruthy();
  const otroRol = extraRoleName
    ? await createRole(admin, { tenantId: tenant.id, name: extraRoleName })
    : null;
  return {
    tenant,
    role,
    otroRol,
    session: { token: login.accessToken as string, activeTenant: tenant.id },
  };
}

/** Fechas de una entrada de "hoy", para que caiga en el período que el calendario abre por defecto. */
function hoyEntre(desdeHora: number, hastaHora: number) {
  const base = new Date();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), desdeHora, 0, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hastaHora, 0, 0);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

/** Espera a que la grilla del calendario esté montada. */
async function abrirCalendario(page: Page) {
  await page.goto('/dashboard/schedule-calendar');
  await expect(page.getByRole('heading', { name: 'Calendario de feriados/guardias' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mes', exact: true })).toBeVisible();
}

test('FE-CAL-01: la pantalla muestra las entradas de la empresa activa y navega entre mes, semana y día', async ({
  page,
}) => {
  const { tenant, session } = await tenantConUsuario(CAL_PERMS);
  const hoy = hoyEntre(9, 17);
  await createScheduleEntry(admin, {
    tenantId: tenant.id,
    type: 'feriado',
    title: 'Feriado visible',
    startAt: hoy.startAt,
    endAt: hoy.endAt,
    allDay: true,
  });
  await createScheduleEntry(admin, {
    tenantId: tenant.id,
    type: 'guardia',
    title: 'Guardia visible',
    startAt: hoy.startAt,
    endAt: hoy.endAt,
    allDay: false,
  });
  // Entrada de OTRA empresa: no debe aparecer.
  const ajena = await createTenant(admin);
  await createScheduleEntry(admin, {
    tenantId: ajena.id,
    title: 'De la otra empresa',
    startAt: hoy.startAt,
    endAt: hoy.endAt,
  });

  await injectSession(page, session);
  await abrirCalendario(page);

  // Vista de día: el feriado (todo el día) va arriba y la guardia con horario, en la grilla.
  await page.getByRole('button', { name: 'Día', exact: true }).click();
  await expect(page.getByText('Feriado: Feriado visible')).toBeVisible();
  await expect(page.getByText('Guardia: Guardia visible')).toBeVisible();
  await expect(page.getByText('De la otra empresa')).toHaveCount(0);

  // Y las tres vistas son navegables.
  await page.getByRole('button', { name: 'Semana', exact: true }).click();
  await expect(page.getByText('Guardia: Guardia visible')).toBeVisible();
  await page.getByRole('button', { name: 'Mes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Siguiente' })).toBeVisible();
});

test('FE-CAL-02: una guardia que cruza la medianoche se dibuja en dos tramos; un feriado de varios días, en uno solo', async ({
  page,
}) => {
  const { tenant, session } = await tenantConUsuario(CAL_PERMS);
  const base = new Date();
  const inicio = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 20, 0, 0);
  const fin = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 8, 0, 0);
  await createScheduleEntry(admin, {
    tenantId: tenant.id,
    type: 'guardia',
    title: 'Guardia nocturna',
    startAt: inicio.toISOString(),
    endAt: fin.toISOString(),
    allDay: false,
  });
  await createScheduleEntry(admin, {
    tenantId: tenant.id,
    type: 'feriado',
    title: 'Fin de semana largo',
    startAt: new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0).toISOString(),
    endAt: new Date(base.getFullYear(), base.getMonth(), base.getDate() + 2, 23, 59, 0).toISOString(),
    allDay: true,
  });

  await injectSession(page, session);
  await abrirCalendario(page);
  await page.getByRole('button', { name: 'Semana', exact: true }).click();

  // La guardia se parte: un tramo hasta medianoche y otro desde, cada uno en su columna. Sin
  // partirla, react-big-calendar la mandaría entera al renglón de "todo el día".
  await expect(page.getByText('Guardia: Guardia nocturna')).toHaveCount(2);
  // El feriado NO se parte: sigue siendo una barra continua arriba.
  await expect(page.getByText('Feriado: Fin de semana largo')).toHaveCount(1);
});

test('FE-CAL-03: el alta desde el modal crea la entrada y aparece en la grilla', async ({ page }) => {
  // El desplegable de rol del modal se llena con `GET /roles`, que exige `roles:read`. Sin ese
  // permiso la página deja la lista vacía a propósito (ver el `catch` de la carga de roles) y no
  // habría ningún rol que elegir, así que el caso lo suma a los permisos del calendario.
  const { tenant, role, otroRol, session } = await tenantConUsuario(
    [...CAL_PERMS, 'roles:read'],
    'Guardias nocturnas',
  );
  // El rol extra es precondición del caso: sin él no hay un segundo rol que elegir.
  if (!otroRol) throw new Error('El caso necesita el rol extra de la empresa.');

  await injectSession(page, session);
  await abrirCalendario(page);
  await page.getByRole('button', { name: 'Día', exact: true }).click();

  // El modal se abre seleccionando una franja de la grilla (`selectable` + `onSelectSlot`). Se
  // apunta a `.rbc-day-slot`: la columna de las horas (`.rbc-time-gutter`) usa la MISMA clase
  // `.rbc-time-slot` y va antes en el DOM, pero no es seleccionable, así que un click ahí no
  // abre nada.
  await page.locator('.rbc-day-slot .rbc-time-slot').first().click({ force: true });
  await expect(page.getByRole('heading', { name: 'Nueva entrada de calendario' })).toBeVisible();

  // El tipo sale del catálogo del backend, no de una lista escrita a mano en el frontend. Se busca
  // dentro del `form` del modal: el filtro "Rol:" de la página es otro `select` y va antes.
  const tipo = page.locator('form select').first();
  await expect(tipo.locator('option')).toHaveText(['Feriado', 'Guardia']);
  await tipo.selectOption('guardia');

  // El selector ofrece TODOS los roles de la empresa, no solo el del usuario que mira la pantalla,
  // e incluye "todos los roles" como primera opción.
  const selectorRol = page.locator('form select').nth(1);
  await expect(selectorRol.locator('option').first()).toHaveText('Todos los roles');
  await expect(selectorRol.locator(`option[value="${role.id}"]`)).toHaveCount(1);
  await expect(selectorRol.locator(`option[value="${otroRol.id}"]`)).toHaveCount(1);
  // Se elige el rol EXTRA, distinto del que tiene el usuario: si la pantalla mandara el rol
  // equivocado (por caso, el propio), la comprobación del final lo delata.
  await selectorRol.selectOption({ label: otroRol.name });

  await page.getByPlaceholder('Feriado de fin de año').fill('Guardia creada desde la UI');
  await page.getByRole('button', { name: 'Crear' }).click();

  await expect(page.getByRole('heading', { name: 'Nueva entrada de calendario' })).toHaveCount(0);
  await expect(page.getByText('Guardia: Guardia creada desde la UI')).toBeVisible();

  // Se busca por título en vez de tomar la primera fila: el orden del listado lo decide la API.
  const enLaApi = await listScheduleEntries(admin, tenant.id);
  const creada = enLaApi.find((e) => e.title === 'Guardia creada desde la UI');
  expect(creada, 'la entrada creada desde la UI debería llegar a la API').toBeTruthy();
  expect(creada?.roleId).toBe(otroRol.id);
});

test('FE-CAL-04: el "hasta" del modal solo aplica con una frecuencia elegida, y la repetición se dibuja en el período', async ({
  page,
}) => {
  const { tenant, session } = await tenantConUsuario(CAL_PERMS);
  // Semanal desde hace tres semanas: la ocurrencia de esta semana tiene que dibujarse igual.
  const base = new Date();
  const inicio = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 21, 9, 0, 0);
  const fin = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 21, 17, 0, 0);
  await createScheduleEntry(admin, {
    tenantId: tenant.id,
    type: 'guardia',
    title: 'Guardia semanal',
    startAt: inicio.toISOString(),
    endAt: fin.toISOString(),
    allDay: false,
    recurrenceFreq: 'weekly',
  });

  await injectSession(page, session);
  await abrirCalendario(page);
  await page.getByRole('button', { name: 'Semana', exact: true }).click();

  // El 🔁 marca que la ocurrencia dibujada viene de una serie.
  await expect(page.getByText('Guardia: Guardia semanal 🔁')).toBeVisible();

  // En el modal, el "hasta" aparece recién al elegir una frecuencia.
  await page.getByText('Guardia: Guardia semanal 🔁').first().click();
  await expect(page.getByRole('heading', { name: 'Editar entrada' })).toBeVisible();
  await expect(page.getByText('Nuevo aviso')).toBeVisible();
  const repetir = page.locator('form select').last();
  await repetir.selectOption('');
  await expect(page.getByText('Nuevo aviso')).toHaveCount(0);
});

test('FE-CAL-05: editar y borrar una entrada actualiza la grilla', async ({ page }) => {
  const { tenant, session } = await tenantConUsuario(CAL_PERMS);
  const hoy = hoyEntre(10, 12);
  await createScheduleEntry(admin, {
    tenantId: tenant.id,
    type: 'guardia',
    title: 'Título original',
    startAt: hoy.startAt,
    endAt: hoy.endAt,
    allDay: false,
  });

  await injectSession(page, session);
  await abrirCalendario(page);
  await page.getByRole('button', { name: 'Día', exact: true }).click();

  // Editar: el modal abre con los valores cargados.
  await page.getByText('Guardia: Título original').first().click();
  await expect(page.getByRole('heading', { name: 'Editar entrada' })).toBeVisible();
  const titulo = page.getByPlaceholder('Feriado de fin de año');
  await expect(titulo).toHaveValue('Título original');
  await titulo.fill('Título corregido');
  await page.getByRole('button', { name: 'Guardar cambios' }).click();

  await expect(page.getByText('Guardia: Título corregido')).toBeVisible();
  await expect(page.getByText('Guardia: Título original')).toHaveCount(0);

  // Borrar: pide confirmación.
  await page.getByText('Guardia: Título corregido').first().click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Eliminar' }).click();

  await expect(page.getByText('Guardia: Título corregido')).toHaveCount(0);
  expect(await listScheduleEntries(admin, tenant.id)).toHaveLength(0);
});

test('FE-CAL-06: importar los feriados de un año y deshacer ese import, sin tocar lo cargado a mano', async ({
  page,
}) => {
  const { tenant, session } = await tenantConUsuario(CAL_PERMS);
  const anio = new Date().getFullYear();
  const hoy = hoyEntre(9, 11);
  await createScheduleEntry(admin, {
    tenantId: tenant.id,
    type: 'guardia',
    title: 'Cargada a mano',
    startAt: hoy.startAt,
    endAt: hoy.endAt,
    allDay: false,
  });

  await injectSession(page, session);
  await abrirCalendario(page);

  await page.getByRole('button', { name: 'Importar' }).click();

  // El aviso de cuántos se crearon se muestra EN PANTALLA (los errores de la API externa
  // también, no en la consola).
  const aviso = page.locator('span.text-green-600, span.text-red-500').first();
  await expect(aviso).toBeVisible({ timeout: 30_000 });
  const textoAviso = (await aviso.textContent()) ?? '';

  if (/feriado/i.test(textoAviso)) {
    // Import exitoso: aparece el botón de deshacer para ese año y las entradas importadas.
    const deshacer = page.getByRole('button', { name: `Deshacer import de ${anio}` });
    await expect(deshacer).toBeVisible();
    const conImport = await listScheduleEntries(admin, tenant.id);
    expect(conImport.filter((e) => e.source === 'ar_holidays_import').length).toBeGreaterThan(0);

    // El botón pide confirmación con el cartel nativo del navegador: Playwright lo cancela salvo
    // que el test lo acepte, y sin eso el borrado nunca se ejecuta (mismo patrón que FE-CAL-05).
    page.once('dialog', (dialog) => dialog.accept());
    await deshacer.click();
    await expect(deshacer).toHaveCount(0);
    const trasDeshacer = await listScheduleEntries(admin, tenant.id);
    expect(trasDeshacer.filter((e) => e.source === 'ar_holidays_import')).toHaveLength(0);
    // Lo cargado a mano queda intacto.
    expect(trasDeshacer.map((e) => e.title)).toContain('Cargada a mano');
  } else {
    // La API pública no respondió: el error se muestra en pantalla, que es lo que el caso
    // exige verificar (no queda solo en la consola).
    expect(textoAviso.length).toBeGreaterThan(0);
    const sinImport = await listScheduleEntries(admin, tenant.id);
    expect(sinImport.map((e) => e.title)).toContain('Cargada a mano');
  }
});

test('FE-CAL-07: sin permisos de calendario no hay ítem en el menú, y por URL directa la pantalla avisa', async ({
  page,
}) => {
  // Sin `schedule-calendar:read`: el ítem no está en el menú y el listado da 403.
  const sinPermiso = await tenantConUsuario(['users:read']);
  await injectSession(page, sinPermiso.session);
  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: 'Calendario' })).toHaveCount(0);

  await page.goto('/dashboard/schedule-calendar');
  await expect(page.getByText(/Permiso denegado/i)).toBeVisible();

  // Solo lectura: el ítem sí está, pero no se ofrecen los botones de escritura.
  const soloLectura = await tenantConUsuario(['schedule-calendar:read']);
  await injectSession(page, soloLectura.session);
  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: 'Calendario' })).toBeVisible();
  await abrirCalendario(page);
  await expect(
    page.getByText('No tenés permiso para crear entradas de calendario — vista de solo lectura.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Importar' })).toHaveCount(0);
});
