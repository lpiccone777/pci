/**
 * 1.27 Métricas del panel de inicio (BE-MET-*)
 *
 * Vía: `GET /metrics/dashboard` real con supertest sobre la base efímera. Sin mocks: los cuatro
 * conteos salen de la base de verdad.
 *
 * Ojo con `tenants`: es un conteo GLOBAL del sistema a propósito (un total, no datos de otras
 * empresas), así que los asserts sobre esa cifra son relativos —cuánto sube al crear una
 * empresa— y no absolutos: todos los specs comparten la misma base efímera.
 */
import {
  createTestApp,
  TestApp,
  tokenFor,
  withAuth,
  http,
  createTenant,
  createRole,
  createUser,
  uniqueEmail,
  uniqueSlug,
} from './support';

describe('1.27 Métricas del panel de inicio (BE-MET-*)', () => {
  let t: TestApp;

  let tenantA: { id: string };
  let tenantB: { id: string };
  let roleA: { id: string };
  let roleSinPermiso: { id: string };
  let tokenA: string;
  let tokenSinPermiso: string;

  beforeAll(async () => {
    t = await createTestApp();

    tenantA = await createTenant(t.prisma, { slug: uniqueSlug('met-a') });
    tenantB = await createTenant(t.prisma, { slug: uniqueSlug('met-b') });
    roleA = await createRole(t.prisma, {
      tenantId: tenantA.id,
      name: 'Métricas A',
      permissions: ['metrics:read'],
    });
    roleSinPermiso = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Sin métricas' });
    const roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Métricas B' });

    const userA = await createUser(t.prisma, {
      email: uniqueEmail('met-a'),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const userSinPermiso = await createUser(t.prisma, {
      email: uniqueEmail('met-sp'),
      memberships: [{ tenantId: tenantA.id, roleId: roleSinPermiso.id }],
    });
    tokenA = tokenFor(t, userA);
    tokenSinPermiso = tokenFor(t, userSinPermiso);

    // Datos de la empresa A: 2 membresías más (userA y userSinPermiso ya cuentan), una dada de baja.
    const dadoDeBaja = await createUser(t.prisma, {
      email: uniqueEmail('met-baja'),
      deletedAt: new Date(),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const conversador = await createUser(t.prisma, {
      email: uniqueEmail('met-conv'),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });

    await t.prisma.conversation.createMany({
      data: [
        { userId: conversador.id, tenantId: tenantA.id, channel: 'whatsapp' },
        { userId: conversador.id, tenantId: tenantA.id, channel: 'sms' },
      ],
    });
    await t.prisma.ticket.create({
      data: { userId: conversador.id, tenantId: tenantA.id, subject: 'Ticket de A' },
    });

    // Datos de la empresa B, que NO deben sumar en los conteos de A.
    const userB = await createUser(t.prisma, {
      email: uniqueEmail('met-b'),
      memberships: [{ tenantId: tenantB.id, roleId: roleB.id }],
    });
    await t.prisma.conversation.createMany({
      data: [
        { userId: userB.id, tenantId: tenantB.id, channel: 'whatsapp' },
        { userId: userB.id, tenantId: tenantB.id, channel: 'whatsapp' },
        { userId: userB.id, tenantId: tenantB.id, channel: 'whatsapp' },
      ],
    });
    await t.prisma.ticket.createMany({
      data: [
        { userId: userB.id, tenantId: tenantB.id, subject: 'Ticket 1 de B' },
        { userId: userB.id, tenantId: tenantB.id, subject: 'Ticket 2 de B' },
      ],
    });
    void dadoDeBaja; // el fixture existe solo para verificar que una baja no suma en `users`
  });

  afterAll(async () => {
    await t.close();
  });

  it('BE-MET-01: devuelve los cuatro conteos con metrics:read', async () => {
    const res = await withAuth(http(t).get('/metrics/dashboard'), tokenA, tenantA.id);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['conversations', 'tenants', 'tickets', 'users']);
    // users = membresías de la empresa activa excluyendo personas dadas de baja
    // (userA + userSinPermiso + conversador; el dado de baja no cuenta).
    expect(res.body.users).toBe(3);
    expect(res.body.conversations).toBe(2);
    expect(res.body.tickets).toBe(1);
    expect(res.body.tenants).toBeGreaterThanOrEqual(2);
  });

  it('BE-MET-01: tenants es un total global del sistema, no de la empresa activa', async () => {
    const antes = await withAuth(http(t).get('/metrics/dashboard'), tokenA, tenantA.id);

    const nueva = await createTenant(t.prisma, { slug: uniqueSlug('met-extra') });
    const despues = await withAuth(http(t).get('/metrics/dashboard'), tokenA, tenantA.id);
    expect(despues.body.tenants).toBe(antes.body.tenants + 1);

    // Y una empresa dada de baja deja de sumar.
    await t.prisma.tenant.update({ where: { id: nueva.id }, data: { deletedAt: new Date() } });
    const conBaja = await withAuth(http(t).get('/metrics/dashboard'), tokenA, tenantA.id);
    expect(conBaja.body.tenants).toBe(antes.body.tenants);
  });

  it('BE-MET-02: parado en la empresa A, ningún conteo por empresa incluye datos de B', async () => {
    const res = await withAuth(http(t).get('/metrics/dashboard'), tokenA, tenantA.id);

    // B tiene 3 conversaciones, 2 tickets y 1 membresía: nada de eso aparece acá.
    expect(res.body.conversations).toBe(2);
    expect(res.body.tickets).toBe(1);
    expect(res.body.users).toBe(3);
  });

  it('BE-MET-02: sin metrics:read devuelve 403', async () => {
    const res = await withAuth(http(t).get('/metrics/dashboard'), tokenSinPermiso, tenantA.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('metrics:read');
  });

  it('BE-MET-02: con un X-Tenant-Id que no es del usuario corta antes, en TenantGuard', async () => {
    // El usuario pertenece a una sola empresa, así que el header es opcional: para forzar el
    // corte se manda una empresa donde no es miembro.
    const res = await withAuth(http(t).get('/metrics/dashboard'), tokenA, tenantB.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('No tenés acceso a este tenant');
  });
});
