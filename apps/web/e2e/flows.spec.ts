/**
 * Bloque 3.10 del plan de pruebas — Flujos IVR: listado (`/dashboard/flows`) y editor
 * (`/dashboard/flows/[id]`).
 *
 * Corren contra el web aislado (`localhost:3100`); la siembra va por la API real (`localhost:3101`).
 * Los flujos se administran globalmente desde el tenant de sistema, así que se siembran con el
 * SuperAdmin del seed. El listado y el editor son por empresa activa: cada test se para en la
 * empresa que necesita vía sesión inyectada.
 *
 * El editor es `@xyflow/react` (ReactFlow) y NO tiene `data-testid`: los únicos anclajes estables son
 * los ids `#flow-skill` / `#flow-context-source`, las clases de la librería (`.react-flow__node-<tipo>`)
 * y el texto literal de labels/botones. Los diálogos de guardar/confirmar/eliminar son
 * `window.confirm`/`window.alert` NATIVOS → se manejan con `page.on('dialog', …)`.
 *
 * Cinco casos del canvas quedan EXCLUIDOS por decisión del plan (gestos nativos de ReactFlow
 * demasiado frágiles en headless, sin selectores estables — ver `docs/plan-de-pruebas.md`):
 * FE-FLW-05 (arrastrar de la paleta), FE-FLW-06 (conectar dos nodos handle-a-handle), FE-FLW-07
 * (borrar arista con la × al hover), FE-FLW-16 (borrar el nodo con Delete: depende de selección
 * previa y foco del canvas) y FE-FLW-19 (nodo SMS: hereda el drag nativo de la paleta). FE-05/06/07
 * nunca tuvieron cuerpo; FE-16/19 antes corrían y quedan como `test.skip` para dejar visible la
 * reclasificación. Ninguno se cuenta como cubierto.
 *
 * FE-FLW-22..25 y FE-FLW-29 son casos INVERTIDOS (`test.fail`): describen el comportamiento
 * SEGURO/robusto que hoy no existe. El assert verifica ese comportamiento deseado; hoy falla a
 * propósito. Cuando se corrija el hallazgo, el marcador saltará y avisará que hay que quitarlo.
 */
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import {
  adminContext,
  apiLogin,
  createTenant,
  createRole,
  createUser,
  createUserWithPermissions,
  createContextSource,
  createSkill,
  createFlow,
  setFlowDefault,
  findUserIdByEmail,
  type AdminCtx,
} from './support/seed';
import { injectSession } from './support/session';

/** Centinela de "Todas las empresas" (mismo valor que `@/lib/system-tenant`). */
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

/** Card del listado que contiene el nombre dado (wrapper `div.shadow.border`). */
function flowCard(page: Page, name: string) {
  return page.locator('div.shadow.border').filter({ hasText: name });
}

/** Abre el editor de un flujo y espera a que ReactFlow monte. */
async function openEditor(page: Page, flowId: string) {
  await page.goto(`/dashboard/flows/edit/?id=${flowId}`);
  await expect(page.locator('.react-flow')).toBeVisible();
}

// ===================== LISTADO =====================

test('FE-FLW-01: el listado muestra badges Default/Inactivo y chips de empresa o "Sin empresas"', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['flows:read'] });
  const assignments = [{ tenantId: tenant.id, roleIds: [role.id] }];

  const conDefault = await createFlow(admin, { assignments });
  await setFlowDefault(admin, conDefault.id);
  const inactivo = await createFlow(admin, { assignments, isActive: false });
  const sinEmpresas = await createFlow(admin, {}); // sin assignments

  // Vista consolidada: el superadmin ve todos los flujos (incluidos los sin empresas) vía /flows/all.
  await injectSession(page, { token: admin.token, activeTenant: ALL_TENANTS });
  await page.goto('/dashboard/flows');

  await expect(flowCard(page, conDefault.name).getByText('Default', { exact: true })).toBeVisible();
  await expect(flowCard(page, conDefault.name).getByText(tenant.name)).toBeVisible();
  await expect(flowCard(page, inactivo.name).getByText('Inactivo', { exact: true })).toBeVisible();
  await expect(flowCard(page, sinEmpresas.name).getByText('Sin empresas')).toBeVisible();
});

test('FE-FLW-02: los botones del listado aparecen según flows:create/update/delete', async ({
  page,
}) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['flows:read'] });
  const flow = await createFlow(admin, { assignments: [{ tenantId: tenant.id, roleIds: [role.id] }] });

  // Sólo lectura: ve la card pero ningún botón de acción.
  const reader = await createUserWithPermissions(admin, ['flows:read'], { tenantId: tenant.id });
  await injectSession(page, await sessionForUser(reader.email, reader.password, tenant.id));
  await page.goto('/dashboard/flows');
  await expect(flowCard(page, flow.name)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nuevo Flujo' })).toHaveCount(0);
  await expect(flowCard(page, flow.name).getByRole('button', { name: 'Editar' })).toHaveCount(0);
  await expect(flowCard(page, flow.name).getByRole('button', { name: 'Eliminar' })).toHaveCount(0);

  // Con permisos de gestión: sí ve "Nuevo Flujo", "Editar" y "Default".
  const editor = await createUserWithPermissions(
    admin,
    ['flows:read', 'flows:create', 'flows:update', 'flows:delete'],
    { tenantId: tenant.id },
  );
  await injectSession(page, await sessionForUser(editor.email, editor.password, tenant.id));
  await page.goto('/dashboard/flows');
  await expect(page.getByRole('button', { name: 'Nuevo Flujo' })).toBeVisible();
  await expect(flowCard(page, flow.name).getByRole('button', { name: 'Editar' })).toBeVisible();
  await expect(flowCard(page, flow.name).getByRole('button', { name: 'Default' })).toBeVisible();
});

test('FE-FLW-03: "Default" marca el flujo por defecto y se refleja en la card', async ({ page }) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['flows:read'] });
  const flow = await createFlow(admin, { assignments: [{ tenantId: tenant.id, roleIds: [role.id] }] });

  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await page.goto('/dashboard/flows');

  const [req] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && /\/flows\/[^/]+\/default$/.test(r.url())),
    flowCard(page, flow.name).getByRole('button', { name: 'Default' }).click(),
  ]);
  expect(req).toBeTruthy();
  await expect(flowCard(page, flow.name).getByText('Default', { exact: true })).toBeVisible();
});

// ===================== EDITOR =====================

test('FE-FLW-04: el editor de un flujo nuevo arranca con un nodo start', async ({ page }) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/flows/edit/?id=new');
  await expect(page.locator('.react-flow')).toBeVisible();

  await expect(page.locator('.react-flow__node-start')).toBeVisible();
  await expect(page.getByText('Inicio / Identificación')).toBeVisible();
});

test('FE-FLW-08: seleccionar un nodo abre el panel con sus campos propios', async ({ page }) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/flows/edit/?id=new');
  await expect(page.locator('.react-flow__node-start')).toBeVisible();

  await page.locator('.react-flow__node-start').click();
  await expect(page.getByRole('heading', { name: 'Propiedades' })).toBeVisible();
  // Campos propios del nodo start.
  await expect(page.getByText('Texto de bienvenida (usuarios nuevos)')).toBeVisible();
  await expect(page.getByText('Salida: Usuario Conocido')).toBeVisible();
});

test('FE-FLW-09: el panel de transfer_agent muestra métodos, asignados y observadores', async ({
  page,
}) => {
  const flow = await createFlow(admin, {
    nodes: [
      { id: 'start_1', type: 'start', data: { text: 'Hola' }, position: { x: 250, y: 40 } },
      { id: 'ta_1', type: 'transfer_agent', data: { methods: ['email'] }, position: { x: 250, y: 220 } },
    ],
  });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await openEditor(page, flow.id);
  await page.locator('.react-flow__node-transfer_agent').click();
  await expect(page.getByRole('heading', { name: 'Propiedades' })).toBeVisible();

  await expect(page.getByText('Método de transferencia')).toBeVisible();
  // El método 'phone' está reservado (deshabilitado).
  const phone = page.locator('label', { hasText: 'Teléfono (próximamente)' }).locator('input[type="checkbox"]');
  await expect(phone).toBeDisabled();
  await expect(page.getByText('Asignados (orden = round robin)')).toBeVisible();
  await expect(page.getByText('Observadores')).toBeVisible();
  await expect(page.getByText('Colaboradores de la tarea')).toBeVisible();
});

test('FE-FLW-10: el header lista las fuentes de verdad activas del tenant', async ({ page }) => {
  const source = await createContextSource(admin, { tenantId: admin.systemTenantId, type: 'n8n' });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/flows/edit/?id=new');
  await expect(page.locator('#flow-context-source')).toBeVisible();
  await expect(page.locator('#flow-context-source')).toContainText(source.name);
});

test('FE-FLW-11: el modal "Empresas y roles" arma el acordeón y avisa cuando una empresa queda sin roles', async ({
  page,
}) => {
  const t1 = await createTenant(admin);
  await createRole(admin, { tenantId: t1.id, name: 'Soporte', permissions: ['flows:read'] });
  const t2 = await createTenant(admin);
  await createRole(admin, { tenantId: t2.id, name: 'Ventas', permissions: ['flows:read'] });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/flows/edit/?id=new');
  await expect(page.locator('.react-flow')).toBeVisible();

  await page.getByRole('button', { name: /Empresas y roles/ }).click();
  const modal = page.locator('div.fixed.inset-0');
  await expect(modal.getByRole('heading', { name: 'Empresas y roles' })).toBeVisible();
  await expect(modal.getByText('No hay empresas asignadas todavía.')).toBeVisible();

  // Agregar t2 (queda con 0 roles marcados → aviso ámbar; addTenant auto-expande el acordeón).
  await modal.locator('select').selectOption({ label: t2.name });
  await expect(
    modal.getByText(`Sin roles: ningún usuario de ${t2.name} recibe este flujo.`),
  ).toBeVisible();

  // Agregar t1 y marcar su rol: el checkbox del rol aparece y el aviso ámbar de t1 desaparece.
  await modal.locator('select').selectOption({ label: t1.name });
  const soporte = modal.locator('label', { hasText: 'Soporte' }).locator('input[type="checkbox"]');
  await expect(soporte).toBeVisible();
  await soporte.check();
  await expect(soporte).toBeChecked();
});

test('FE-FLW-12: el checkbox "Inicio" está deshabilitado mientras no haya empresas', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/flows/edit/?id=new');
  await expect(page.locator('.react-flow')).toBeVisible();

  const inicio = page.locator('label', { hasText: 'Inicio' }).locator('input[type="checkbox"]');
  await expect(inicio).toBeDisabled();
  await expect(page.getByText('(elegí una empresa primero)')).toBeVisible();
});

test('FE-FLW-13: guardar un flujo nuevo hace POST y uno existente PATCH + assign-tenants', async ({
  page,
}) => {
  page.on('dialog', (d) => d.accept()); // confirm de "sin empresas" + alert de "Flujo guardado"

  // --- Nuevo: POST /flows ---
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/flows/edit/?id=new');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.getByPlaceholder('Nombre del flujo').fill(`Flujo nuevo ${Date.now()}`);
  const [postReq] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && /\/flows$/.test(r.url())),
    page.getByRole('button', { name: 'Guardar' }).click(),
  ]);
  expect(postReq).toBeTruthy();

  // --- Existente: PATCH /flows/:id + POST /flows/:id/assign-tenants ---
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['flows:read'] });
  const flow = await createFlow(admin, { assignments: [{ tenantId: tenant.id, roleIds: [role.id] }] });
  await openEditor(page, flow.id);
  await page.getByPlaceholder('Nombre del flujo').fill(`${flow.name} editado`);
  const [patchReq, assignReq] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && /\/flows\/[^/]+$/.test(r.url())),
    page.waitForRequest((r) => r.method() === 'POST' && /\/flows\/[^/]+\/assign-tenants$/.test(r.url())),
    page.getByRole('button', { name: 'Guardar' }).click(),
  ]);
  expect(patchReq).toBeTruthy();
  expect(assignReq).toBeTruthy();
});

test('FE-FLW-14: guardar sin empresas asignadas pide confirmación', async ({ page }) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/flows/edit/?id=new');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.getByPlaceholder('Nombre del flujo').fill(`Flujo ${Date.now()}`);

  // El confirm() bloquea la página hasta que se lo maneje: hay que registrar el handler ANTES del
  // click (si no, el click nunca resuelve y espera al handler que vendría después → deadlock).
  let dialogMessage = '';
  page.once('dialog', async (d) => {
    dialogMessage = d.message();
    await d.dismiss(); // cancela: no guarda, sólo verificamos que pidió confirmación
  });
  await page.getByRole('button', { name: 'Guardar' }).click();
  expect(dialogMessage).toBe(
    'Este flujo va a quedar sin empresas asignadas: no lo va a recibir ningún usuario ' +
      'y aparecerá como "sin asignar" en la lista. ¿Guardar igual?',
  );
});

test('FE-FLW-15: el payload de guardado limpia las props transitorias de ReactFlow', async ({
  page,
}) => {
  page.on('dialog', (d) => d.accept());
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['flows:read'] });
  const flow = await createFlow(admin, {
    nodes: [
      { id: 'start_1', type: 'start', data: { text: 'Hola' }, position: { x: 250, y: 40 } },
      { id: 'msg_1', type: 'message', data: { text: 'Mensaje' }, position: { x: 250, y: 220 } },
    ],
    assignments: [{ tenantId: tenant.id, roleIds: [role.id] }],
  });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await openEditor(page, flow.id);

  const [patchReq] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && /\/flows\/[^/]+$/.test(r.url())),
    page.getByRole('button', { name: 'Guardar' }).click(),
  ]);
  const body = JSON.parse(patchReq.postData() ?? '{}');
  for (const node of body.nodes) {
    // Sólo las cuatro claves declaradas: sin measured/selected/dragging que agrega ReactFlow.
    expect(Object.keys(node).sort()).toEqual(['data', 'id', 'position', 'type']);
  }
});

// Reclasificado a EXCLUIDO por el plan (gesto de canvas frágil: depende de selección previa y foco
// del canvas). Antes corría; se deja como `test.skip` para dejar constancia de la reclasificación.
test.skip('FE-FLW-16: se puede borrar el nodo seleccionado con la tecla Delete', async ({ page }) => {
  const flow = await createFlow(admin, {
    nodes: [
      { id: 'start_1', type: 'start', data: { text: 'Hola' }, position: { x: 250, y: 40 } },
      { id: 'msg_1', type: 'message', data: { text: 'Mensaje' }, position: { x: 250, y: 220 } },
    ],
  });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await openEditor(page, flow.id);
  await expect(page.locator('.react-flow__node-message')).toBeVisible();

  await page.locator('.react-flow__node-message').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__node-message')).toHaveCount(0);
});

test('FE-FLW-17: reordenar asignados con ↓ persiste el nuevo orden en el nodo', async ({ page }) => {
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['flows:read'] });
  const u1 = await createUser(admin, { memberships: [{ tenantId: tenant.id, roleId: role.id }] });
  const u2 = await createUser(admin, { memberships: [{ tenantId: tenant.id, roleId: role.id }] });
  const id1 = await findUserIdByEmail(admin, u1.email);
  const id2 = await findUserIdByEmail(admin, u2.email);
  expect(id1 && id2).toBeTruthy();

  const flow = await createFlow(admin, {
    nodes: [
      { id: 'start_1', type: 'start', data: { text: 'Hola' }, position: { x: 250, y: 40 } },
      {
        id: 'ta_1',
        type: 'transfer_agent',
        data: { methods: ['ticket'], assignees: [id1, id2] },
        position: { x: 250, y: 220 },
      },
    ],
    assignments: [{ tenantId: tenant.id, roleIds: [role.id] }],
  });

  page.on('dialog', (d) => d.accept());
  await injectSession(page, { token: admin.token, activeTenant: tenant.id });
  await openEditor(page, flow.id);
  await page.locator('.react-flow__node-transfer_agent').click();
  await expect(page.getByText('Asignados (orden = round robin)')).toBeVisible();

  // Bajar el primer asignado: el orden pasa de [u1,u2] a [u2,u1].
  await page.getByRole('button', { name: '↓' }).first().click();

  const [patchReq] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && /\/flows\/[^/]+$/.test(r.url())),
    page.getByRole('button', { name: 'Guardar' }).click(),
  ]);
  const body = JSON.parse(patchReq.postData() ?? '{}');
  const ta = body.nodes.find((n: { type: string }) => n.type === 'transfer_agent');
  expect(ta.data.assignees).toEqual([id2, id1]);
});

test('FE-FLW-18: el selector de Skill lista sólo las activas y vincula/desvincula el flujo', async ({
  page,
}) => {
  const activa = await createSkill(admin, { tenantId: admin.systemTenantId, isActive: true });
  const inactiva = await createSkill(admin, { tenantId: admin.systemTenantId, isActive: false });
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['flows:read'] });
  const flow = await createFlow(admin, { assignments: [{ tenantId: tenant.id, roleIds: [role.id] }] });

  page.on('dialog', (d) => d.accept());
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await openEditor(page, flow.id);

  // El dropdown filtra por isActive: la activa está, la inactiva no.
  await expect(page.locator('#flow-skill')).toContainText(activa.name);
  await expect(page.locator('#flow-skill')).not.toContainText(inactiva.name);

  // Elegir la skill → PATCH con skillId; "Sin skill" → PATCH con skillId null.
  await page.locator('#flow-skill').selectOption({ label: activa.name });
  const [patchVincula] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && /\/flows\/[^/]+$/.test(r.url())),
    page.getByRole('button', { name: 'Guardar' }).click(),
  ]);
  expect(JSON.parse(patchVincula.postData() ?? '{}').skillId).toBe(activa.id);

  await page.locator('#flow-skill').selectOption('');
  const [patchDesvincula] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && /\/flows\/[^/]+$/.test(r.url())),
    page.getByRole('button', { name: 'Guardar' }).click(),
  ]);
  expect(JSON.parse(patchDesvincula.postData() ?? '{}').skillId).toBeNull();
});

// Reclasificado a EXCLUIDO por el plan (el caso es el nodo SMS en la paleta: hereda el drag nativo,
// ver FE-FLW-05). El chequeo del panel (message + destinatarios) era estable, pero el plan excluye el
// caso; antes corría y se deja como `test.skip` para dejar constancia de la reclasificación.
test.skip('FE-FLW-19: el nodo SMS tiene mensaje y selector de destinatarios', async ({ page }) => {
  const flow = await createFlow(admin, {
    nodes: [
      { id: 'start_1', type: 'start', data: { text: 'Hola' }, position: { x: 250, y: 40 } },
      { id: 'sms_1', type: 'sms', data: { message: 'Aviso' }, position: { x: 250, y: 220 } },
    ],
  });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await openEditor(page, flow.id);
  await page.locator('.react-flow__node-sms').click();
  await expect(page.getByRole('heading', { name: 'Propiedades' })).toBeVisible();

  // Scopear al panel de propiedades: "Mensaje" también es el label del nodo Mensaje en la paleta.
  const panel = page.locator('div.w-72.border-l');
  await expect(panel.getByText('Mensaje', { exact: true })).toBeVisible();
  await expect(panel.getByText('Destinatarios')).toBeVisible();
});

test('FE-FLW-20: el nodo Crear Ticket cae a texto libre cuando el catálogo InvGate no cargó', async ({
  page,
}) => {
  const flow = await createFlow(admin, {
    nodes: [
      { id: 'start_1', type: 'start', data: { text: 'Hola' }, position: { x: 250, y: 40 } },
      { id: 'tk_1', type: 'ticket_create', data: {}, position: { x: 250, y: 220 } },
    ],
  });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await openEditor(page, flow.id);
  await page.locator('.react-flow__node-ticket_create').click();
  await expect(page.getByRole('heading', { name: 'Propiedades' })).toBeVisible();

  // InvGate sin configurar en el entorno efímero → los campos caen a input de texto libre.
  await expect(page.getByPlaceholder('Nombre exacto de la categoría en InvGate')).toBeVisible();
  await expect(page.getByPlaceholder('Nombre exacto de la prioridad en InvGate')).toBeVisible();
  await expect(page.getByText('Descripción')).toBeVisible();
});

test('FE-FLW-21: el nodo llm_query ofrece el toggle reemplaza/agrega del prompt base', async ({
  page,
}) => {
  const flow = await createFlow(admin, {
    nodes: [
      { id: 'start_1', type: 'start', data: { text: 'Hola' }, position: { x: 250, y: 40 } },
      {
        id: 'llm_1',
        type: 'llm_query',
        data: { systemPrompt: 'Sos un asistente de soporte.' },
        position: { x: 250, y: 220 },
      },
    ],
  });

  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await openEditor(page, flow.id);
  await page.locator('.react-flow__node-llm_query').click();
  await expect(page.getByRole('heading', { name: 'Propiedades' })).toBeVisible();

  // Con systemPrompt cargado aparece el toggle; el default es "Reemplaza".
  const reemplaza = page.locator('label', { hasText: 'Reemplaza' }).locator('input[type="radio"]');
  const agrega = page.locator('label', { hasText: 'Agrega' }).locator('input[type="radio"]');
  await expect(reemplaza).toBeChecked();
  await expect(agrega).not.toBeChecked();
});

// --- Casos invertidos (comportamiento seguro/robusto deseado; hoy fallan a propósito) ---

test.fail(
  'FE-FLW-22: cambiar de empresa en el editor debería devolver al listado (SEC-03) @invertido',
  async ({ page }) => {
    // El flujo abierto puede ser de otra empresa: al cambiar la empresa activa, lo seguro es sacar al
    // usuario del editor. Hoy el reload lo deja adentro, editando el mismo flujo (ver SEC-03).
    const tenant = await createTenant(admin);
    const role = await createRole(admin, { tenantId: tenant.id, permissions: ['flows:read'] });
    const flow = await createFlow(admin, { assignments: [{ tenantId: tenant.id, roleIds: [role.id] }] });

    await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
    await openEditor(page, flow.id);

    // Cambiar la empresa activa desde el selector del sidebar (dispara un reload).
    await page.locator('aside select').selectOption(ALL_TENANTS);
    await page.waitForLoadState('domcontentloaded');

    // SEGURO: debería haber vuelto al listado. Hoy sigue en el editor del flujo.
    await expect(page).toHaveURL(/\/dashboard\/flows\/?$/);
  },
);

test.fail(
  'FE-FLW-23: los dropdowns deberían poblarse con la empresa del flujo, no con la activa @invertido',
  async ({ page }) => {
    // Un flujo de la empresa B tiene una fuente de verdad de B. Abriéndolo con otra empresa activa, el
    // dropdown "Fuente de verdad" debería listar la de B. Hoy usa la empresa activa y la deja fuera.
    const empresaB = await createTenant(admin);
    const fuenteB = await createContextSource(admin, { tenantId: empresaB.id, type: 'n8n' });
    const role = await createRole(admin, { tenantId: empresaB.id, permissions: ['flows:read'] });
    const flow = await createFlow(admin, {
      contextSourceId: fuenteB.id,
      assignments: [{ tenantId: empresaB.id, roleIds: [role.id] }],
    });

    // Empresa activa = sistema (≠ B).
    await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
    await openEditor(page, flow.id);

    // SEGURO: la fuente de la empresa del flujo debería estar en el dropdown. Hoy no aparece.
    await expect(page.locator('#flow-context-source')).toContainText(fuenteB.name);
  },
);

test.fail(
  'FE-FLW-24: los catálogos de InvGate no deberían responder 500 al abrir el editor @invertido',
  async ({ page }) => {
    // InvGate sin configurar debería devolver lista vacía o un 4xx controlado, no un 500.
    await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
    const respPromise = page.waitForResponse((r) =>
      r.url().includes('/invgate/catalog/priorities'),
    );
    await page.goto('/dashboard/flows/edit/?id=new');
    const resp = await respPromise;

    // SEGURO: no debería ser 500. Hoy lo es.
    expect(resp.status()).not.toBe(500);
  },
);

test.fail(
  'FE-FLW-25: sin flows:read la pantalla debería avisar "Permiso denegado", no simular lista vacía @invertido',
  async ({ page }) => {
    // Flujos es la única de su clase que oculta el 403: muestra "No hay flujos configurados." igual que
    // una empresa sin flujos. Lo seguro es distinguirlo, como Áreas/Roles/Usuarios.
    const tenant = await createTenant(admin);
    const user = await createUserWithPermissions(admin, ['areas:read'], { tenantId: tenant.id });

    await injectSession(page, await sessionForUser(user.email, user.password, tenant.id));
    await page.goto('/dashboard/flows');

    // SEGURO: debería mostrar el aviso de permiso. Hoy muestra "No hay flujos configurados.".
    await expect(page.getByText(/Permiso denegado.*flows:read/)).toBeVisible();
  },
);

// ===================== DUPLICAR / EXPORTAR / IMPORTAR =====================

test('FE-FLW-26: "Duplicar" clona vía GET+POST con "(copia)" y redirige al editor del nuevo', async ({
  page,
}) => {
  const source = await createContextSource(admin, { tenantId: admin.systemTenantId, type: 'n8n' });
  const skill = await createSkill(admin, { tenantId: admin.systemTenantId, isActive: true });
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['flows:read'] });
  const flow = await createFlow(admin, {
    contextSourceId: source.id,
    skillId: skill.id,
    assignments: [{ tenantId: tenant.id, roleIds: [role.id] }],
  });

  // Gateado por flows:create: un usuario sólo-lectura ve la card pero NO el botón "Duplicar".
  const reader = await createUserWithPermissions(admin, ['flows:read'], { tenantId: tenant.id });
  await injectSession(page, await sessionForUser(reader.email, reader.password, tenant.id));
  await page.goto('/dashboard/flows');
  await expect(flowCard(page, flow.name)).toBeVisible();
  await expect(flowCard(page, flow.name).getByRole('button', { name: 'Duplicar' })).toHaveCount(0);

  // Con flows:create (superadmin): "Duplicar" hace GET /flows/:id y luego POST /flows con "(copia)".
  await injectSession(page, { token: admin.token, activeTenant: ALL_TENANTS });
  await page.goto('/dashboard/flows');
  const [getReq, postReq] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === 'GET' && new RegExp(`/flows/${flow.id}$`).test(r.url()),
    ),
    page.waitForRequest((r) => r.method() === 'POST' && /\/flows$/.test(r.url())),
    flowCard(page, flow.name).getByRole('button', { name: 'Duplicar' }).click(),
  ]);
  expect(getReq).toBeTruthy();

  const body = JSON.parse(postReq.postData() ?? '{}');
  expect(body.name).toBe(`${flow.name} (copia)`);
  expect(body.contextSourceId).toBe(source.id);
  expect(body.skillId).toBe(skill.id);
  // Nace sin empresas: el POST de duplicado no manda assignments (se asignan luego desde el editor).
  expect(body.assignments).toBeUndefined();

  // Redirige al editor del flujo nuevo.
  await expect(page).toHaveURL(/\/dashboard\/flows\/edit\/?\?id=/);
});

test('FE-FLW-27: "Exportar" descarga un .flow.json con name/description/nodes/edges/contextSourceId/skillId', async ({
  page,
}) => {
  const source = await createContextSource(admin, { tenantId: admin.systemTenantId, type: 'n8n' });
  const skill = await createSkill(admin, { tenantId: admin.systemTenantId, isActive: true });
  const tenant = await createTenant(admin);
  const role = await createRole(admin, { tenantId: tenant.id, permissions: ['flows:read'] });
  const flow = await createFlow(admin, {
    description: 'Flujo para exportar',
    contextSourceId: source.id,
    skillId: skill.id,
    assignments: [{ tenantId: tenant.id, roleIds: [role.id] }],
  });

  // Gateado por flows:read: un usuario sólo-lectura SÍ ve "Exportar".
  const reader = await createUserWithPermissions(admin, ['flows:read'], { tenantId: tenant.id });
  await injectSession(page, await sessionForUser(reader.email, reader.password, tenant.id));
  await page.goto('/dashboard/flows');
  const exportBtn = flowCard(page, flow.name).getByRole('button', { name: 'Exportar' });
  await expect(exportBtn).toBeVisible();

  // La descarga se dispara desde el navegador (Blob + <a download>): la captura Playwright.
  const [download] = await Promise.all([page.waitForEvent('download'), exportBtn.click()]);
  expect(download.suggestedFilename()).toMatch(/\.flow\.json$/);

  const path = await download.path();
  const payload = JSON.parse(readFileSync(path, 'utf-8'));
  expect(Object.keys(payload).sort()).toEqual(
    ['contextSourceId', 'description', 'edges', 'name', 'nodes', 'skillId'].sort(),
  );
  expect(payload.name).toBe(flow.name);
  expect(payload.contextSourceId).toBe(source.id);
  expect(payload.skillId).toBe(skill.id);
  expect(Array.isArray(payload.nodes)).toBe(true);
  expect(Array.isArray(payload.edges)).toBe(true);
});

test('FE-FLW-28: "Importar" valida superficialmente y hace POST; un JSON inválido sólo alerta', async ({
  page,
}) => {
  await injectSession(page, { token: admin.token, activeTenant: admin.systemTenantId });
  await page.goto('/dashboard/flows');

  const fileInput = page.locator('input[type="file"]');

  // --- Inválido: sin name/nodes/edges → alert de formato y NO llama a la API ---
  let posted = false;
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/flows$/.test(r.url())) posted = true;
  });
  let alertMsg = '';
  page.once('dialog', async (d) => {
    alertMsg = d.message();
    await d.accept();
  });
  await fileInput.setInputFiles({
    name: 'malformado.flow.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ foo: 'bar' })),
  });
  await expect
    .poll(() => alertMsg)
    .toBe('El archivo no tiene el formato esperado (falta name, nodes o edges).');
  expect(posted).toBe(false);

  // --- Válido: name + nodes[] + edges[] → POST /flows y redirige al editor ---
  const validName = `Importado ${Date.now()}`;
  const [postReq] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && /\/flows$/.test(r.url())),
    fileInput.setInputFiles({
      name: 'valido.flow.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          name: validName,
          description: 'Importado por e2e',
          nodes: [
            { id: 'start_1', type: 'start', data: { text: 'Hola' }, position: { x: 250, y: 40 } },
          ],
          edges: [],
        }),
      ),
    }),
  ]);
  expect(JSON.parse(postReq.postData() ?? '{}').name).toBe(validName);
  await expect(page).toHaveURL(/\/dashboard\/flows\/edit\/?\?id=/);
});

// --- Caso invertido (comportamiento seguro/robusto deseado; hoy falla a propósito) ---

test.fail(
  'FE-FLW-29: importar en otra empresa debería sanear los ids embebidos ajenos (robustez/seguridad) @invertido',
  async ({ page }) => {
    // Un .flow.json exportado en la empresa A trae ids que sólo existen en A (acá, la fuente de verdad
    // de A vía `contextSourceId`; igual valdría para `skillId`, el `userId` de assignees/recipients o el
    // `flowId` de un nodo `subflow`). Importándolo con la empresa B activa, lo SEGURO es que el backend
    // saneé o rechace ese id ajeno. Hoy `POST /flows` lo guarda como blob sin validar: el flujo nuevo
    // queda apuntando a un recurso de A.
    const empresaA = await createTenant(admin);
    const fuenteA = await createContextSource(admin, { tenantId: empresaA.id, type: 'n8n' });
    const empresaB = await createTenant(admin);

    await injectSession(page, { token: admin.token, activeTenant: empresaB.id });
    await page.goto('/dashboard/flows');

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && /\/flows$/.test(r.url())),
      page.locator('input[type="file"]').setInputFiles({
        name: 'de-empresa-a.flow.json',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            name: `Cruzado ${Date.now()}`,
            description: 'Exportado de A, importado en B',
            nodes: [
              { id: 'start_1', type: 'start', data: { text: 'Hola' }, position: { x: 250, y: 40 } },
            ],
            edges: [],
            contextSourceId: fuenteA.id,
          }),
        ),
      }),
    ]);
    const created = await resp.json();

    // SEGURO: el flujo importado en B NO debería quedar con la fuente de verdad de A. Hoy sí queda.
    expect(created.contextSourceId).not.toBe(fuenteA.id);
  },
);
