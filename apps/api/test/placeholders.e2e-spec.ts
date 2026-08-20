/**
 * 1.18 Módulos e integraciones pendientes — placeholders (BE-PH-*)
 *
 * Casos redactados para lo que todavía no está implementado, o que sí lo está pero necesita un
 * tercero real para probarse de punta a punta. No se inventa cobertura: donde no hay lógica que
 * ejercitar, el caso queda `it.skip` documentando el motivo.
 *
 * La única excepción real es BE-PH-05 (nodo `webhook`): es un stub concreto (`case 'webhook'` en
 * `ConversationsService.executeNode`) que SÍ se puede ejercitar de punta a punta vía
 * `/conversations/simulate`, sin ningún tercero — así que ahí hay un test real, no un skip.
 */
import {
  createTestApp,
  TestApp,
  http,
  createTenant,
  createRole,
  createUser,
  createFlow,
  uniqueEmail,
  uniquePhone,
  uniqueSlug,
  startNode,
  webhookNode,
  endNode,
  edge,
} from './support';

describe('1.18 Módulos e integraciones pendientes — placeholders (BE-PH-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it.skip('BE-PH-01: InvGate — validación end-to-end contra una instancia real [BLOQUEADO: requiere un token de API de InvGate real; el cargado resultó ser la contraseña de portal de un usuario]', () => {
    // El módulo InvGate YA está implementado (cobertura funcional real en el bloque BE-IG-*, no
    // en este archivo). Lo único pendiente es esta validación end-to-end.
  });

  it.skip('BE-PH-02: módulo `metrics` — registro y consulta de métricas de conversación [SIN IMPLEMENTAR]', () => {
    // `src/modules/metrics/metrics.module.ts` es `@Module({})`: sin controladores, sin
    // providers, sin nada que ejercitar por REST ni por Prisma. Definir casos cuando se
    // implemente (Hito 4, ver docs/plan-de-trabajo.md).
  });

  it.skip('BE-PH-03: módulo `devices` — endpoints de gestión de dispositivos [SIN IMPLEMENTAR]', () => {
    // `src/modules/devices/devices.module.ts` es `@Module({})` también: la lógica de fingerprint
    // hoy vive enteramente en `auth` (`DeviceService`) y ya está cubierta ahí (BE-AUTH-06/07/08/09
    // en auth.e2e-spec.ts). No hay superficie propia de `devices` para probar.
  });

  it.skip('BE-PH-04: envío end-to-end real contra la Cloud API de Meta [BLOQUEADO: requiere WHATSAPP_API_TOKEN + WHATSAPP_PHONE_NUMBER_ID reales y el sandbox de Meta]', () => {
    // La mecánica del conector (armado de payload, colas, etc.) ya está implementada y cubierta
    // en el bloque BE-WAO-*. Sólo falta la validación de punta a punta contra la Cloud API real.
  });

  it('BE-PH-05: nodo `webhook` — hoy es un stub (sin llamada HTTP real), ejercitado de punta a punta vía /conversations/simulate', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('ph05') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol PH05' });
    const phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('ph05'),
      phone,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    await createFlow(t.prisma, {
      name: `Flujo webhook stub ${uniqueSlug()}`,
      nodes: [startNode('s'), webhookNode('w'), endNode('e')],
      // Dos aristas desde 'start' (conocido/desconocido) al mismo nodo webhook: cubre el ruteo
      // sin importar si `findMembershipByPhone` lo resuelve como conocido o no.
      edges: [edge('s', 'w', 'known'), edge('s', 'w', 'unknown'), edge('w', 'e')],
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });

    const res = await http(t).post('/conversations/simulate').send({ from: phone, body: 'hola', tenantId: tenant.id });

    // `@Post()` sin `@HttpCode` → 201 (default de Nest).
    expect(res.status).toBe(201);
    // `case 'webhook'` en executeNode: "TODO: Implementar llamada HTTP a webhook externo" — hoy
    // sólo devuelve este texto fijo, no hace ningún request real (ver conversations.service.ts).
    expect(res.body.reply).toContain('Acción webhook ejecutada (stub).');
  });

  it.skip('BE-PH-06: envío end-to-end real de SMS por Twilio [BLOQUEADO: falta un número de Twilio habilitado para SMS; el sandbox de WhatsApp no sirve para esto]', () => {
    // La mecánica del conector ya está implementada y cubierta en el bloque BE-SMS-*. Sólo falta
    // la validación de punta a punta con un número real.
  });
});
