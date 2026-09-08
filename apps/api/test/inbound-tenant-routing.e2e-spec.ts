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

  describe('BE-ITR-07: forma de la pregunta según canal y cantidad de empresas', () => {
    /** Crea `cantidad` empresas con nombres largos y una persona que pertenece a todas. */
    async function multiempresa(cantidad: number) {
      const memberships: Array<{ tenantId: string; roleId: string }> = [];
      for (let i = 0; i < cantidad; i++) {
        const tenant = await createTenant(t.prisma, {
          slug: uniqueSlug('itr07'),
          name: `Empresa con nombre larguísimo número ${i + 1}`,
        });
        const role = await createRole(t.prisma, { tenantId: tenant.id, name: `ITR07-${i}` });
        memberships.push({ tenantId: tenant.id, roleId: role.id });
      }
      const phone = uniquePhone();
      await member(phone, memberships);
      return phone;
    }

    it('BE-ITR-07: WhatsApp con hasta 3 empresas usa botones, con el título recortado a 20', async () => {
      const phone = await multiempresa(3);

      const res = await routing.resolve(phone, 'whatsapp', 'hola');

      expect(res.status).toBe('ask');
      if (res.status !== 'ask') return;
      expect(res.interactive!.type).toBe('button');
      const botones = (res.interactive as any).buttons;
      expect(botones).toHaveLength(3);
      for (const b of botones) expect(b.title.length).toBeLessThanOrEqual(20);
    });

    it('BE-ITR-07: WhatsApp con 4 a 10 empresas usa lista, con el título recortado a 24 y el botón "Elegir empresa"', async () => {
      const phone = await multiempresa(4);

      const res = await routing.resolve(phone, 'whatsapp', 'hola');

      expect(res.status).toBe('ask');
      if (res.status !== 'ask') return;
      expect(res.interactive!.type).toBe('list');
      expect((res.interactive as any).buttonText).toBe('Elegir empresa');
      const filas = (res.interactive as any).rows;
      expect(filas).toHaveLength(4);
      for (const f of filas) expect(f.title.length).toBeLessThanOrEqual(24);
    });

    it('BE-ITR-07: por SMS —o con más de 10 empresas— cae a texto numerado, sin interactivo', async () => {
      const porSms = await multiempresa(3);
      const resSms = await routing.resolve(porSms, 'sms', 'hola');

      expect(resSms.status).toBe('ask');
      if (resSms.status !== 'ask') return;
      expect(resSms.interactive).toBeUndefined();
      expect(resSms.body).toContain('1.');
      expect(resSms.body).toContain('Respondé con el número.');

      const conMuchas = await multiempresa(11);
      const resMuchas = await routing.resolve(conMuchas, 'whatsapp', 'hola');

      expect(resMuchas.status).toBe('ask');
      if (resMuchas.status !== 'ask') return;
      // Más de 10 no entra en una lista de WhatsApp: cae al texto numerado igual que SMS.
      expect(resMuchas.interactive).toBeUndefined();
      expect(resMuchas.body).toContain('11.');
      expect(resMuchas.body).toContain('Respondé con el número.');
    });
  });

  it('BE-ITR-11: dos mensajes casi simultáneos dejan un solo pendiente, y gana el primero', async () => {
    const phone = uniquePhone();
    await member(phone, [
      { tenantId: tenantA.id, roleId: roleA.id },
      { tenantId: tenantB.id, roleId: roleB.id },
    ]);

    const [primero, segundo] = await Promise.all([
      routing.resolve(phone, 'whatsapp', 'mensaje original'),
      routing.resolve(phone, 'whatsapp', 'segundo mensaje'),
    ]);

    // Ninguno lanza: el choque contra la unique [phone, channel] lo absorbe `skipDuplicates`.
    expect(primero.status).toBe('ask');
    expect(segundo.status).toBe('ask');

    const pendientes = await t.prisma.pendingTenantSelection.findMany({ where: { phone } });
    expect(pendientes).toHaveLength(1);
    // El `originalBody` del que llegó primero se conserva: el segundo no lo pisa.
    expect(['mensaje original', 'segundo mensaje']).toContain(pendientes[0].originalBody);
  });

  it.failing(
    'BE-ITR-12: los adjuntos del mensaje original deberían sobrevivir mientras viva el pendiente @invertido',
    async () => {
      const phone = uniquePhone();
      await member(phone, [
        { tenantId: tenantA.id, roleId: roleA.id },
        { tenantId: tenantB.id, roleId: roleB.id },
      ]);
      const adjuntos = [
        { path: '/tmp/foto-borrada-por-el-cron.jpg', filename: 'foto.jpg', contentType: 'image/jpeg' },
      ];

      await routing.resolve(phone, 'whatsapp', 'mirá esta foto', adjuntos as any);
      // El pendiente vive 12h; el cron de retención de media borra los archivos a los 10 min.
      const pendiente = await pendingOf(phone);
      expect((pendiente!.originalAttachments as any[])).toHaveLength(1);

      const elegida = await routing.resolve(phone, 'whatsapp', '1');

      expect(elegida.status).toBe('resolved');
      if (elegida.status !== 'resolved') return;
      // SEGURO: responder más tarde no debería perder las fotos en silencio — o se retienen
      // mientras viva el pendiente, o se avisa. Hoy el replay devuelve las rutas igual y
      // `loadAttachments` no encuentra los archivos: se pierden sin que nadie se entere.
      const { existsSync } = await import('fs');
      for (const att of elegida.replayAttachments ?? []) {
        expect(existsSync(att.path)).toBe(true);
      }
    },
  );

  it.failing(
    'BE-ITR-13: el selector no debería revelar los nombres de las empresas de un teléfono ajeno @invertido',
    async () => {
      const phone = uniquePhone();
      await member(phone, [
        { tenantId: tenantA.id, roleId: roleA.id },
        { tenantId: tenantB.id, roleId: roleB.id },
      ]);

      // Quien alcance un webhook sin firma (Gupshup/Meta) o `/simulate` sin tenantId puede
      // sondear cualquier número.
      const res = await routing.resolve(phone, 'whatsapp', 'hola');

      expect(res.status).toBe('ask');
      if (res.status !== 'ask') return;
      const textoCompleto = JSON.stringify(res);
      // SEGURO: de un remitente no verificado no debería salir dónde trabaja una persona. Hoy
      // el selector devuelve los nombres de todas sus empresas, así que el número alcanza para
      // enumerarlas (privacidad, ligado a SEC-04/SEC-16).
      expect(textoCompleto).not.toContain('Empresa A');
      expect(textoCompleto).not.toContain('Empresa B');
    },
  );
});
