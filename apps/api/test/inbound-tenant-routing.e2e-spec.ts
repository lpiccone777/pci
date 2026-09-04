/**
 * 1.24 Ruteo de tenant entrante por membresía (BE-ITR-*)
 *
 * El tenant que atiende un mensaje ENTRANTE ya no sale de configuración por canal
 * (`*_TENANT_ID` + fallback al más viejo, eliminados), sino de la membresía del teléfono:
 * `InboundTenantRoutingService.resolve()`. Se prueba el servicio directo contra la base real
 * (determinista, sin depender del pipeline asíncrono de RabbitMQ): una empresa → directo;
 * varias → se pregunta y se guarda el pendiente; ninguna → se ignora ("no hablamos con
 * desconocidos", pedido 2026-08-27: sin membresía en ningún lado no hay tenant de fallback);
 * y la resolución de la respuesta al selector (válida, inválida) y la continuidad de una
 * charla activa.
 */
import {
  createTestApp,
  TestApp,
  createTenant,
  createRole,
  createUser,
  uniqueSlug,
  uniqueEmail,
  uniquePhone,
} from './support';
import { InboundTenantRoutingService } from '../src/modules/conversations/inbound-tenant-routing.service';

describe('1.24 Ruteo de tenant entrante por membresía (BE-ITR-*)', () => {
  let t: TestApp;
  let routing: InboundTenantRoutingService;
  let tenantA: { id: string };
  let tenantB: { id: string };
  let roleA: { id: string };
  let roleB: { id: string };

  beforeAll(async () => {
    t = await createTestApp();
    routing = t.moduleRef.get(InboundTenantRoutingService);
    // tenantA se crea ANTES que tenantB → en el selector (ordenado por antigüedad) tenantA es la
    // opción 1 y tenantB la 2.
    tenantA = await createTenant(t.prisma, { slug: uniqueSlug('itr-a'), name: 'Empresa A' });
    tenantB = await createTenant(t.prisma, { slug: uniqueSlug('itr-b'), name: 'Empresa B' });
    roleA = await createRole(t.prisma, { tenantId: tenantA.id, name: 'ITR-A' });
    roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'ITR-B' });
  }, 30000);

  afterAll(async () => {
    await t.close();
  });

  afterEach(async () => {
    // Ningún otro spec usa esta tabla: limpiarla entera evita arrastrar pendientes entre casos.
    await t.prisma.pendingTenantSelection.deleteMany({});
  });

  const pendingOf = (phone: string) =>
    t.prisma.pendingTenantSelection.findUnique({ where: { phone_channel: { phone, channel: 'whatsapp' } } });

  async function member(phone: string, memberships: Array<{ tenantId: string; roleId: string }>) {
    return createUser(t.prisma, { email: uniqueEmail('itr'), phone, firstName: 'ITR', memberships });
  }

  it('BE-ITR-01: teléfono en UNA sola empresa → resuelve directo a esa empresa, sin preguntar', async () => {
    const phone = uniquePhone();
    await member(phone, [{ tenantId: tenantA.id, roleId: roleA.id }]);

    const res = await routing.resolve(phone, 'whatsapp', 'hola');

    expect(res).toEqual({ status: 'resolved', tenantId: tenantA.id });
    expect(await pendingOf(phone)).toBeNull();
  });

  it('BE-ITR-02: teléfono SIN ninguna empresa → se ignora (no hablamos con desconocidos)', async () => {
    const phone = uniquePhone(); // sin usuario ni membresía

    const res = await routing.resolve(phone, 'whatsapp', 'hola');

    expect(res).toEqual({ status: 'ignored' });
  });

  it('BE-ITR-03: teléfono multitenant → pregunta (ask) y guarda el pendiente con las 2 opciones', async () => {
    const phone = uniquePhone();
    await member(phone, [
      { tenantId: tenantA.id, roleId: roleA.id },
      { tenantId: tenantB.id, roleId: roleB.id },
    ]);

    const res = await routing.resolve(phone, 'whatsapp', 'necesito ayuda');

    expect(res.status).toBe('ask');
    if (res.status === 'ask') expect(res.body).toContain('empresa');

    const pending = await pendingOf(phone);
    expect(pending).not.toBeNull();
    expect(pending!.originalBody).toBe('necesito ayuda');
    const options = pending!.options as unknown as Array<{ index: number; tenantId: string }>;
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.tenantId)).toEqual([tenantA.id, tenantB.id]); // orden por antigüedad
  });

  it('BE-ITR-04: responde con el número de la empresa → resuelve a esa empresa y reprocesa el mensaje original', async () => {
    const phone = uniquePhone();
    await member(phone, [
      { tenantId: tenantA.id, roleId: roleA.id },
      { tenantId: tenantB.id, roleId: roleB.id },
    ]);

    const ask = await routing.resolve(phone, 'whatsapp', 'necesito ayuda');
    expect(ask.status).toBe('ask');

    const res = await routing.resolve(phone, 'whatsapp', '2'); // 2 = Empresa B (la más nueva)

    expect(res).toEqual({
      status: 'resolved',
      tenantId: tenantB.id,
      replayBody: 'necesito ayuda',
      replayAttachments: [],
    });
    expect(await pendingOf(phone)).toBeNull();
  });

  it('BE-ITR-05: respuesta inválida al selector → vuelve a preguntar y conserva el pendiente', async () => {
    const phone = uniquePhone();
    await member(phone, [
      { tenantId: tenantA.id, roleId: roleA.id },
      { tenantId: tenantB.id, roleId: roleB.id },
    ]);

    await routing.resolve(phone, 'whatsapp', 'hola');
    const res = await routing.resolve(phone, 'whatsapp', 'no-es-un-numero');

    expect(res.status).toBe('ask');
    expect(await pendingOf(phone)).not.toBeNull();
  });

  it('BE-ITR-06: multitenant con una conversación ACTIVA → continúa en esa empresa, sin volver a preguntar', async () => {
    const phone = uniquePhone();
    const user = await member(phone, [
      { tenantId: tenantA.id, roleId: roleA.id },
      { tenantId: tenantB.id, roleId: roleB.id },
    ]);
    await t.prisma.conversation.create({
      data: { userId: user.id, tenantId: tenantB.id, channel: 'whatsapp', status: 'active', externalId: phone },
    });

    const res = await routing.resolve(phone, 'whatsapp', 'hola de nuevo');

    expect(res).toEqual({ status: 'resolved', tenantId: tenantB.id });
    expect(await pendingOf(phone)).toBeNull();
  });

  it('BE-ITR-08: responde al selector con el NOMBRE de la empresa (título del botón de Twilio) → resuelve igual que con el número', async () => {
    const phone = uniquePhone();
    await member(phone, [
      { tenantId: tenantA.id, roleId: roleA.id },
      { tenantId: tenantB.id, roleId: roleB.id },
    ]);
    await routing.resolve(phone, 'whatsapp', 'necesito ayuda');

    const res = await routing.resolve(phone, 'whatsapp', 'empresa b'); // case-insensitive

    expect(res).toEqual({
      status: 'resolved',
      tenantId: tenantB.id,
      replayBody: 'necesito ayuda',
      replayAttachments: [],
    });
  });

  it('BE-ITR-09: la empresa elegida en el selector fue dada de baja en el medio → notice (aviso), pendiente borrado, sin descartar en silencio', async () => {
    const doomed = await createTenant(t.prisma, { slug: uniqueSlug('itr-baja'), name: 'Empresa Por Cerrar' });
    const roleDoomed = await createRole(t.prisma, { tenantId: doomed.id, name: 'ITR-BAJA' });
    const phone = uniquePhone();
    await member(phone, [
      { tenantId: tenantA.id, roleId: roleA.id },
      { tenantId: doomed.id, roleId: roleDoomed.id },
    ]);
    await routing.resolve(phone, 'whatsapp', 'hola');
    await t.prisma.tenant.update({ where: { id: doomed.id }, data: { deletedAt: new Date() } });

    const res = await routing.resolve(phone, 'whatsapp', '2'); // 2 = la empresa recién dada de baja

    expect(res.status).toBe('notice');
    if (res.status === 'notice') expect(res.body).toContain('ya no está disponible');
    expect(await pendingOf(phone)).toBeNull();
  });

  it('BE-ITR-10: conversación ACTIVA en una empresa que un cambio de membresía dejó fuera del ruteo → se cierra y se avisa (notice), no se abandona en silencio', async () => {
    const revoked = await createTenant(t.prisma, { slug: uniqueSlug('itr-rev'), name: 'Empresa Revocada' });
    const roleRevoked = await createRole(t.prisma, { tenantId: revoked.id, name: 'ITR-REV' });
    const phone = uniquePhone();
    const user = await member(phone, [
      { tenantId: revoked.id, roleId: roleRevoked.id },
      { tenantId: tenantA.id, roleId: roleA.id },
    ]);
    const conv = await t.prisma.conversation.create({
      data: { userId: user.id, tenantId: revoked.id, channel: 'whatsapp', status: 'active', externalId: phone },
    });
    await t.prisma.userTenant.deleteMany({ where: { userId: user.id, tenantId: revoked.id } });

    const res = await routing.resolve(phone, 'whatsapp', 'sigo con lo mío');

    expect(res.status).toBe('notice');
    if (res.status === 'notice') expect(res.body).toContain('cambio administrativo');
    const closed = await t.prisma.conversation.findUnique({ where: { id: conv.id } });
    expect(closed!.status).toBe('closed');
  });
});
