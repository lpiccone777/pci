/**
 * 1.5 Usuarios — multiempresa, baja lógica, datos únicos globales (BE-USR-*)
 *
 * Vía: endpoints REST reales (`/users/*`) con supertest, sobre la base efímera. Nada de la
 * lógica de `UsersService`/`UsersController` se mockea.
 *
 * Nota de guards: `UsersController` lleva la cadena de clase completa
 * `@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)`. Eso corre en TODAS las rutas, incluidas
 * las que autorizan "por empresa dentro del servicio" (`/users/multi`, `/users/:id/full`,
 * `/users/mine`, `/users/check-availability`, `/users/:id/memberships`): aunque esas rutas no
 * llevan `@RequirePermission`, igual necesitan que `TenantGuard` resuelva ALGÚN tenant activo
 * para el solicitante (su propia membresía, vía header `X-Tenant-Id` si tiene más de una). Por
 * eso casi todos los `withAuth(...)` de este spec pasan un tenant explícito, aunque la lógica
 * bajo prueba no lo use.
 */
import {
  createTestApp,
  TestApp,
  tokenFor,
  withAuth,
  http,
  createTenant,
  createRole,
  createArea,
  createUser,
  getSystemContext,
  uniqueEmail,
  uniquePhone,
  uniqueSlug,
  uid,
} from './support';
import * as bcrypt from 'bcrypt';

/** Réplica exacta del sufijo de baja lógica (`UsersService` → `deletionSuffix`), para PRECOMPUTAR
 *  qué email va a generar una baja en un instante dado (BE-USR-16). Los asserts son siempre
 *  sobre comportamiento del código real, no sobre esta réplica. */
function deletionSuffix(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `_${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`
  );
}

describe('1.5 Usuarios (BE-USR-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  // --- BE-USR-01: alta en el tenant activo ---

  it('BE-USR-01: alta de usuario en el tenant activo (POST /users) devuelve 201 con rol y área válidos', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr01') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const area = await createArea(t.prisma, { tenantId: tenant.id, name: 'Área 01' });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr01-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);
    const email = uniqueEmail('usr01-nuevo');

    const res = await withAuth(http(t).post('/users'), token, tenant.id).send({
      email,
      firstName: 'Nueva',
      lastName: 'Persona',
      password: 'password123',
      roleId: role.id,
      areaId: area.id,
    });

    expect(res.status).toBe(201); // @Post() sin @HttpCode → default de Nest
    expect(res.body.email).toBe(email);
    expect(res.body.role).toEqual({ id: role.id, name: role.name });
    expect(res.body.area).toEqual({ id: area.id, name: area.name });
    expect(res.body.passwordHash).toBeUndefined();
  });

  // --- BE-USR-02: alta multiempresa ---

  it('BE-USR-02: alta multiempresa (POST /users/multi) crea la persona + N membresías atómicamente', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);

    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr02-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('usr02-b') });
    const roleA = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Rol A' });
    const roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol B' });
    const email = uniqueEmail('usr02');

    const res = await withAuth(http(t).post('/users/multi'), token, systemTenant.id).send({
      email,
      firstName: 'Multi',
      lastName: 'Empresa',
      password: 'password123',
      memberships: [
        { tenantId: tenantA.id, roleId: roleA.id },
        { tenantId: tenantB.id, roleId: roleB.id },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email, created: true, memberships: 2 });

    const rows = await t.prisma.userTenant.findMany({ where: { userId: res.body.userId } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tenantId).sort()).toEqual([tenantA.id, tenantB.id].sort());
  });

  it('BE-USR-03: alta multiempresa con una empresa repetida en el body devuelve 400', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr03-a') });
    const roleA1 = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Rol A1' });
    const roleA2 = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Rol A2' });

    const res = await withAuth(http(t).post('/users/multi'), token, systemTenant.id).send({
      email: uniqueEmail('usr03'),
      firstName: 'Repetido',
      lastName: 'Empresa',
      password: 'password123',
      memberships: [
        { tenantId: tenantA.id, roleId: roleA1.id },
        { tenantId: tenantA.id, roleId: roleA2.id },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Hay empresas repetidas en la selección');
  });

  it('BE-USR-04: alta multiempresa en una empresa donde el solicitante no puede gestionar usuarios devuelve 403', async () => {
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr04-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('usr04-b') });
    const roleA = await createRole(t.prisma, {
      tenantId: tenantA.id,
      name: 'Con permiso',
      permissions: ['users:create'],
    });
    // El solicitante SÍ es miembro de B, pero su rol ahí no tiene `users:create`: es el caso
    // "es miembro pero no puede gestionar", distinto del caso "ni siquiera es miembro" (que
    // el servicio también corta, con un mensaje distinto: "No pertenecés a alguna de las
    // empresas seleccionadas").
    const roleB = await createRole(t.prisma, {
      tenantId: tenantB.id,
      name: 'Sin permiso',
      permissions: ['areas:read'],
    });
    const roleBTarget = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol destino B' });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr04'),
      memberships: [
        { tenantId: tenantA.id, roleId: roleA.id },
        { tenantId: tenantB.id, roleId: roleB.id },
      ],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).post('/users/multi'), token, tenantA.id).send({
      email: uniqueEmail('usr04-nuevo'),
      firstName: 'Sin',
      lastName: 'Permiso',
      password: 'password123',
      memberships: [
        { tenantId: tenantA.id, roleId: roleA.id },
        { tenantId: tenantB.id, roleId: roleBTarget.id },
      ],
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe(
      'No tenés permiso para administrar usuarios en alguna de las empresas seleccionadas',
    );
  });

  // --- BE-USR-05/06: conflictos de datos únicos globales ---

  it('BE-USR-05: alta con un email ya en uso por un usuario activo devuelve 409 { field, conflict }', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr05') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const existing = await createUser(t.prisma, {
      email: uniqueEmail('usr05-existente'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr05-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).post('/users'), token, tenant.id).send({
      email: existing.email,
      firstName: 'Choca',
      lastName: 'Email',
      password: 'password123',
      roleId: role.id,
    });

    expect(res.status).toBe(409);
    expect(res.body.field).toBe('email');
    expect(res.body.conflict).toBeDefined();
  });

  it('BE-USR-06: alta con phone ya en uso por un usuario activo devuelve 409', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr06-phone') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('usr06-phone-existente'),
      phone,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr06-phone-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).post('/users'), token, tenant.id).send({
      email: uniqueEmail('usr06-phone-nuevo'),
      firstName: 'Choca',
      lastName: 'Phone',
      password: 'password123',
      roleId: role.id,
      phone,
    });

    expect(res.status).toBe(409);
    expect(res.body.field).toBe('phone');
  });

  it('BE-USR-06: alta con internalPhone ya en uso por un usuario activo devuelve 409', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr06-int') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const internalPhone = `int-${uid()}`;
    await createUser(t.prisma, {
      email: uniqueEmail('usr06-int-existente'),
      internalPhone,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr06-int-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).post('/users'), token, tenant.id).send({
      email: uniqueEmail('usr06-int-nuevo'),
      firstName: 'Choca',
      lastName: 'Interno',
      password: 'password123',
      roleId: role.id,
      internalPhone,
    });

    expect(res.status).toBe(409);
    expect(res.body.field).toBe('internalPhone');
  });

  it('BE-USR-06: alta con invgateUserId ya en uso por un usuario activo devuelve 409', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr06-inv') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const invgateUserId = `inv-${uid()}`;
    await createUser(t.prisma, {
      email: uniqueEmail('usr06-inv-existente'),
      invgateUserId,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr06-inv-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).post('/users'), token, tenant.id).send({
      email: uniqueEmail('usr06-inv-nuevo'),
      firstName: 'Choca',
      lastName: 'Invgate',
      password: 'password123',
      roleId: role.id,
      invgateUserId,
    });

    expect(res.status).toBe(409);
    expect(res.body.field).toBe('invgateUserId');
  });

  it('BE-USR-07: conflicto de dato único que el solicitante SÍ puede ver revela { canView:true, userId, name }', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr07') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create', 'users:read'],
    });
    const owner = await createUser(t.prisma, {
      email: uniqueEmail('usr07-owner'),
      firstName: 'Dueño',
      lastName: 'Del Dato',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    // El solicitante comparte con el dueño la MISMA empresa con `users:read`: puede verlo.
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr07-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).post('/users'), token, tenant.id).send({
      email: owner.email,
      firstName: 'Otra',
      lastName: 'Persona',
      password: 'password123',
      roleId: role.id,
    });

    expect(res.status).toBe(409);
    expect(res.body.conflict).toEqual({ canView: true, userId: owner.id, name: 'Dueño Del Dato' });
  });

  it('BE-USR-08: conflicto de dato único que el solicitante NO puede ver revela solo canView:false', async () => {
    const tenantOwner = await createTenant(t.prisma, { slug: uniqueSlug('usr08-owner') });
    const tenantReq = await createTenant(t.prisma, { slug: uniqueSlug('usr08-req') });
    const roleOwner = await createRole(t.prisma, { tenantId: tenantOwner.id, name: 'Rol dueño' });
    const roleReq = await createRole(t.prisma, {
      tenantId: tenantReq.id,
      name: 'Rol solicitante',
      permissions: ['users:create'],
    });
    const owner = await createUser(t.prisma, {
      email: uniqueEmail('usr08-owner'),
      memberships: [{ tenantId: tenantOwner.id, roleId: roleOwner.id }],
    });
    // El solicitante NO es miembro de la empresa del dueño (ni tiene `users:read` ahí): no
    // comparte ninguna empresa visible con él.
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr08-req'),
      memberships: [{ tenantId: tenantReq.id, roleId: roleReq.id }],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).post('/users'), token, tenantReq.id).send({
      email: owner.email,
      firstName: 'Otra',
      lastName: 'Persona',
      password: 'password123',
      roleId: roleReq.id,
    });

    expect(res.status).toBe(409);
    expect(res.body.conflict).toEqual({ canView: false, userId: null, name: null });
  });

  // --- BE-USR-09/10/11: check-availability ---

  it('BE-USR-09: GET /users/check-availability de un dato libre devuelve { available:true }', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr09') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr09-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);
    const freeEmail = uniqueEmail('usr09-libre');

    const res = await withAuth(http(t).get('/users/check-availability'), token, tenant.id).query({
      field: 'email',
      value: freeEmail,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, field: 'email', conflict: null });
  });

  it('BE-USR-10: check-availability de un dato en uso devuelve { available:false, conflict } según visibilidad', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr10') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create', 'users:read'],
    });
    const owner = await createUser(t.prisma, {
      email: uniqueEmail('usr10-owner'),
      phone: uniquePhone(),
      firstName: 'Ocupante',
      lastName: 'Visible',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    // Comparte la empresa con `users:read`: lo ve.
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr10-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).get('/users/check-availability'), token, tenant.id).query({
      field: 'phone',
      value: owner.phone!,
    });

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.conflict).toEqual({ canView: true, userId: owner.id, name: 'Ocupante Visible' });
  });

  it('BE-USR-11: check-availability sin permiso de gestión en ninguna empresa devuelve 403', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr11') });
    // `canManageUsersAnywhere` exige `create` o `update`; `read` NO alcanza.
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Solo lectura',
      permissions: ['users:read'],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr11-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).get('/users/check-availability'), token, tenant.id).query({
      field: 'email',
      value: uniqueEmail('usr11-cualquiera'),
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('No tenés permiso para verificar datos de usuarios');
  });

  // --- BE-USR-12/13/14/15/16: baja lógica ---

  it('BE-USR-12: baja lógica de un usuario con una sola membresía sufija los campos únicos y los libera', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr12') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:delete'],
    });
    const admin = await createUser(t.prisma, {
      email: uniqueEmail('usr12-admin'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr12-target'),
      phone: uniquePhone(),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const originalEmail = target.email;
    const token = tokenFor(t, admin);

    const res = await withAuth(http(t).delete(`/users/${target.id}`), token, tenant.id);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const updated = await t.prisma.user.findUnique({ where: { id: target.id } });
    expect(updated!.deletedAt).not.toBeNull();
    expect(updated!.email).toMatch(/^.+_\d{8}-\d{6}(-.+)?$/);
    expect(updated!.email).not.toBe(originalEmail);
    expect(updated!.email.startsWith(originalEmail)).toBe(true);

    // El valor original quedó libre.
    const freeAgain = await t.prisma.user.findFirst({ where: { email: originalEmail } });
    expect(freeAgain).toBeNull();
  });

  it('BE-USR-13: dar de baja a un usuario de un tenant cuando tiene otras membresías lo deja activo en las demás', async () => {
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr13-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('usr13-b') });
    const roleA = await createRole(t.prisma, {
      tenantId: tenantA.id,
      name: 'Gestor A',
      permissions: ['users:delete'],
    });
    const roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol B' });
    const admin = await createUser(t.prisma, {
      email: uniqueEmail('usr13-admin'),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr13-target'),
      memberships: [
        { tenantId: tenantA.id, roleId: roleA.id },
        { tenantId: tenantB.id, roleId: roleB.id },
      ],
    });
    const token = tokenFor(t, admin);

    const res = await withAuth(http(t).delete(`/users/${target.id}`), token, tenantA.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      deleted: false,
      message: 'Usuario dado de baja de este tenant. Sigue activo en otros tenants.',
    });

    const stillMember = await t.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId: target.id, tenantId: tenantB.id } },
    });
    expect(stillMember).not.toBeNull();
    const stillActive = await t.prisma.user.findUnique({ where: { id: target.id } });
    expect(stillActive!.deletedAt).toBeNull();
  });

  it('BE-USR-14: intentar darse de baja a uno mismo devuelve 400', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr14') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:delete'],
    });
    const self = await createUser(t.prisma, {
      email: uniqueEmail('usr14'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, self);

    const res = await withAuth(http(t).delete(`/users/${self.id}`), token, tenant.id);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('No podés darte de baja a vos mismo');
  });

  it('BE-USR-15: reusar un email liberado por una baja está permitido y entra como persona nueva sin historial', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr15') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create', 'users:delete', 'users:read'],
    });
    const admin = await createUser(t.prisma, {
      email: uniqueEmail('usr15-admin'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, admin);
    const originalEmail = uniqueEmail('usr15-reusado');
    const original = await createUser(t.prisma, {
      email: originalEmail,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });

    await withAuth(http(t).delete(`/users/${original.id}`), token, tenant.id);

    const res = await withAuth(http(t).post('/users'), token, tenant.id).send({
      email: originalEmail,
      firstName: 'Persona',
      lastName: 'Nueva',
      password: 'password123',
      roleId: role.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe(originalEmail);
    expect(res.body.id).not.toBe(original.id);

    // La persona vieja (dada de baja) no aparece más en este tenant.
    const oldLookup = await withAuth(http(t).get(`/users/${original.id}`), token, tenant.id);
    expect(oldLookup.status).toBe(404);
  });

  it('BE-USR-16: dos bajas que colisionarían en el mismo segundo — el sufijo incorpora el userId para no chocar', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr16') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:delete'],
    });
    const admin = await createUser(t.prisma, {
      email: uniqueEmail('usr16-admin'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr16-target'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, admin);

    // "Envenenamos" de antemano las filas que el sufijo de baja podría llegar a usar: la
    // resolución del sufijo es de UN SEGUNDO, así que precomputamos el sufijo para varios
    // segundos consecutivos a partir de ahora y ocupamos esos emails con usuarios ya
    // existentes. Cuando el DELETE dispare `softDeleteUser` (en algún instante dentro de esta
    // ventana), el sufijo natural va a chocar seguro, y `availableSuffix` tiene que agregar
    // "-{userId}" para resolver el choque.
    const base = Date.now();
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const suffix = deletionSuffix(new Date(base + i * 1000));
      const poisonedEmail = `${target.email}${suffix}`;
      if (seen.has(poisonedEmail)) continue;
      seen.add(poisonedEmail);
      await createUser(t.prisma, { email: poisonedEmail });
    }

    const res = await withAuth(http(t).delete(`/users/${target.id}`), token, tenant.id);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const updated = await t.prisma.user.findUnique({ where: { id: target.id } });
    // El choque forzado obliga a `availableSuffix` a agregar el id del usuario al final.
    expect(updated!.email.endsWith(`-${target.id}`)).toBe(true);
  });

  // --- BE-USR-17/18/19: listados ---

  it('BE-USR-17: GET /users/all desde el tenant de sistema devuelve una fila por membresía, cross-tenant', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);

    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr17-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('usr17-b') });
    const roleA = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Rol A' });
    const roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol B' });
    const multi = await createUser(t.prisma, {
      email: uniqueEmail('usr17-multi'),
      memberships: [
        { tenantId: tenantA.id, roleId: roleA.id },
        { tenantId: tenantB.id, roleId: roleB.id },
      ],
    });

    const res = await withAuth(http(t).get('/users/all'), token, systemTenant.id);

    expect(res.status).toBe(200);
    const rows = (res.body as any[]).filter((r) => r.id === multi.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tenant.id).sort()).toEqual([tenantA.id, tenantB.id].sort());
  });

  it('BE-USR-18: GET /users sin el permiso users:read devuelve 403', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr18-403') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Sin permiso',
      permissions: ['areas:read'],
    });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('usr18-403'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/users'), token, tenant.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Permiso denegado: users:read');
  });

  it('BE-USR-18: GET /users parado en un tenant devuelve sus usuarios con rol y área, y excluye a los dados de baja', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr18') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Lector',
      permissions: ['users:read'],
    });
    const area = await createArea(t.prisma, { tenantId: tenant.id, name: 'Área 18' });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr18-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const active = await createUser(t.prisma, {
      email: uniqueEmail('usr18-activo'),
      memberships: [{ tenantId: tenant.id, roleId: role.id, areaId: area.id }],
    });
    // Estado inconsistente A PROPÓSITO: una membresía contra un usuario que YA tiene
    // `deletedAt`. El flujo real (`remove`/`updateFull`) nunca deja este estado —primero
    // borra la membresía, después marca la baja—, pero sirve para probar que el filtro
    // `user:{deletedAt:null}` de `findAll()` no es solo decorativo (el propio comentario del
    // código lo llama "redundante en la práctica").
    const ghost = await createUser(t.prisma, {
      email: uniqueEmail('usr18-ghost'),
      deletedAt: new Date(),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).get('/users'), token, tenant.id);

    expect(res.status).toBe(200);
    const ids = (res.body as any[]).map((r) => r.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(ghost.id);
    const activeRow = (res.body as any[]).find((r) => r.id === active.id);
    expect(activeRow.role).toEqual({ id: role.id, name: role.name });
    expect(activeRow.area).toEqual({ id: area.id, name: area.name });
  });

  it('BE-USR-19: GET /users/mine devuelve una fila por membresía en las empresas donde tiene users:read', async () => {
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr19-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('usr19-b') });
    const roleA = await createRole(t.prisma, {
      tenantId: tenantA.id,
      name: 'Lector A',
      permissions: ['users:read'],
    });
    const roleB = await createRole(t.prisma, {
      tenantId: tenantB.id,
      name: 'Lector B',
      permissions: ['users:read'],
    });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('usr19'),
      memberships: [
        { tenantId: tenantA.id, roleId: roleA.id },
        { tenantId: tenantB.id, roleId: roleB.id },
      ],
    });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/users/mine'), token, tenantA.id);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect((res.body as any[]).map((r) => r.tenant.id).sort()).toEqual(
      [tenantA.id, tenantB.id].sort(),
    );
  });

  it('BE-USR-19: GET /users/mine sin users:read en ninguna empresa devuelve [] (no 403)', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr19-sin') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Sin lectura',
      permissions: ['areas:read'],
    });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('usr19-sin'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/users/mine'), token, tenant.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  // --- BE-USR-20: GET /users/:id ---

  it('BE-USR-20: GET /users/:id de una membresía del tenant devuelve datos + rol + área', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr20') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Lector',
      permissions: ['users:read'],
    });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr20-target'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr20-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).get(`/users/${target.id}`), token, tenant.id);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(target.id);
    expect(res.body.role).toEqual({ id: role.id, name: role.name });
  });

  it('BE-USR-20: GET /users/:id de un usuario de OTRO tenant devuelve 404', async () => {
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr20-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('usr20-b') });
    const roleA = await createRole(t.prisma, {
      tenantId: tenantA.id,
      name: 'Lector A',
      permissions: ['users:read'],
    });
    const roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol B' });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr20-req-otro'),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const otherTenantUser = await createUser(t.prisma, {
      email: uniqueEmail('usr20-otro-tenant'),
      memberships: [{ tenantId: tenantB.id, roleId: roleB.id }],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).get(`/users/${otherTenantUser.id}`), token, tenantA.id);

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('El usuario no existe en este tenant');
  });

  it('BE-USR-20: GET /users/:id de una persona dada de baja devuelve 404', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr20-baja') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Lector',
      permissions: ['users:read'],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr20-req-baja'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    // Baja lógica manual directa (no vía endpoint): equivalente a "ya fue dado de baja".
    const deleted = await createUser(t.prisma, {
      email: uniqueEmail('usr20-dado-de-baja'),
      deletedAt: new Date(),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    const res = await withAuth(http(t).get(`/users/${deleted.id}`), token, tenant.id);

    expect(res.status).toBe(404);
  });

  // --- BE-USR-21/22: GET /users/:id/memberships ---

  it('BE-USR-21: GET /users/:id/memberships como editor devuelve datos + solo las empresas que administra', async () => {
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr21-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('usr21-b') });
    const roleA = await createRole(t.prisma, {
      tenantId: tenantA.id,
      name: 'Lector A',
      permissions: ['users:read'],
    });
    const roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol B (sin acceso)' });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr21-target'),
      firstName: 'Objetivo',
      lastName: 'Editado',
      memberships: [
        { tenantId: tenantA.id, roleId: roleA.id },
        { tenantId: tenantB.id, roleId: roleB.id },
      ],
    });
    // El editor solo tiene `users:read` en A: no ve la membresía de B, aunque exista.
    const editor = await createUser(t.prisma, {
      email: uniqueEmail('usr21-editor'),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const token = tokenFor(t, editor);

    const res = await withAuth(http(t).get(`/users/${target.id}/memberships`), token, tenantA.id);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(target.email);
    expect(res.body.memberships).toHaveLength(1);
    expect(res.body.memberships[0].tenantId).toBe(tenantA.id);
  });

  it('BE-USR-21: el superusuario del sistema ve TODAS las membresías en GET /users/:id/memberships', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr21super-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('usr21super-b') });
    const roleA = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Rol A' });
    const roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol B' });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr21super-target'),
      memberships: [
        { tenantId: tenantA.id, roleId: roleA.id },
        { tenantId: tenantB.id, roleId: roleB.id },
      ],
    });

    const res = await withAuth(
      http(t).get(`/users/${target.id}/memberships`),
      token,
      systemTenant.id,
    );

    expect(res.status).toBe(200);
    expect(res.body.memberships).toHaveLength(2);
  });

  it('BE-USR-22: GET /users/:id/memberships sin compartir ninguna empresa visible devuelve 403', async () => {
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr22-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('usr22-b') });
    const roleA = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Rol A' });
    const roleB = await createRole(t.prisma, {
      tenantId: tenantB.id,
      name: 'Rol B',
      permissions: ['users:read'],
    });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr22-target'),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    // El solicitante no comparte NINGUNA empresa con el objetivo.
    const stranger = await createUser(t.prisma, {
      email: uniqueEmail('usr22-stranger'),
      memberships: [{ tenantId: tenantB.id, roleId: roleB.id }],
    });
    const token = tokenFor(t, stranger);

    const res = await withAuth(http(t).get(`/users/${target.id}/memberships`), token, tenantB.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('No tenés permiso para ver a este usuario');
  });

  // --- BE-USR-23/24/25: PATCH /users/:id ---

  it('BE-USR-23: PATCH /users/:id cambia rol y área de la membresía en el tenant activo', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr23') });
    const roleOld = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Rol viejo',
      permissions: ['users:update'],
    });
    const roleNew = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol nuevo' });
    const areaNew = await createArea(t.prisma, { tenantId: tenant.id, name: 'Área nueva 23' });
    const admin = await createUser(t.prisma, {
      email: uniqueEmail('usr23-admin'),
      memberships: [{ tenantId: tenant.id, roleId: roleOld.id }],
    });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr23-target'),
      memberships: [{ tenantId: tenant.id, roleId: roleOld.id }],
    });
    const token = tokenFor(t, admin);

    const res = await withAuth(http(t).patch(`/users/${target.id}`), token, tenant.id).send({
      roleId: roleNew.id,
      areaId: areaNew.id,
    });

    expect(res.status).toBe(200); // @Patch() sin @HttpCode → default de Nest (200, no 201)
    expect(res.body.role).toEqual({ id: roleNew.id, name: roleNew.name });
    expect(res.body.area).toEqual({ id: areaNew.id, name: areaNew.name });
  });

  it('BE-USR-23: PATCH /users/:id con un rol de OTRO tenant devuelve 400', async () => {
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr23b-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('usr23b-b') });
    const roleA = await createRole(t.prisma, {
      tenantId: tenantA.id,
      name: 'Rol A',
      permissions: ['users:update'],
    });
    const roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol B (ajeno)' });
    const admin = await createUser(t.prisma, {
      email: uniqueEmail('usr23b-admin'),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr23b-target'),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const token = tokenFor(t, admin);

    const res = await withAuth(http(t).patch(`/users/${target.id}`), token, tenantA.id).send({
      roleId: roleB.id,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('El rol no existe o no pertenece a este tenant');
  });

  it('BE-USR-24: PATCH /users/:id con un teléfono ya usado por otro usuario activo devuelve 409', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr24') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:update'],
    });
    const admin = await createUser(t.prisma, {
      email: uniqueEmail('usr24-admin'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const takenPhone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('usr24-dueño'),
      phone: takenPhone,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr24-target'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, admin);

    const res = await withAuth(http(t).patch(`/users/${target.id}`), token, tenant.id).send({
      phone: takenPhone,
    });

    expect(res.status).toBe(409);
    expect(res.body.field).toBe('phone');
  });

  it('BE-USR-24: PATCH /users/:id reguardando su propio teléfono actual no choca contra sí mismo', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr24b') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:update'],
    });
    const admin = await createUser(t.prisma, {
      email: uniqueEmail('usr24b-admin'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const ownPhone = uniquePhone();
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr24b-target'),
      phone: ownPhone,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, admin);

    const res = await withAuth(http(t).patch(`/users/${target.id}`), token, tenant.id).send({
      phone: ownPhone,
      firstName: 'Sin Cambios Reales',
    });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe(ownPhone);
  });

  it('BE-USR-25: PATCH areaId vacío o null deja al usuario sin área; que la clave no venga no la toca', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr25') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:update'],
    });
    const area = await createArea(t.prisma, { tenantId: tenant.id, name: 'Área 25' });
    const admin = await createUser(t.prisma, {
      email: uniqueEmail('usr25-admin'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr25-target'),
      memberships: [{ tenantId: tenant.id, roleId: role.id, areaId: area.id }],
    });
    const token = tokenFor(t, admin);

    // areaId: '' → sin área.
    const resEmpty = await withAuth(http(t).patch(`/users/${target.id}`), token, tenant.id).send({
      areaId: '',
    });
    expect(resEmpty.status).toBe(200);
    expect(resEmpty.body.area).toBeNull();

    // Volvemos a asignarle área para probar el caso `null`.
    await withAuth(http(t).patch(`/users/${target.id}`), token, tenant.id).send({
      areaId: area.id,
    });

    const resNull = await withAuth(http(t).patch(`/users/${target.id}`), token, tenant.id).send({
      areaId: null,
    });
    expect(resNull.status).toBe(200);
    expect(resNull.body.area).toBeNull();

    // Volvemos a asignarle área para probar que OMITIR la clave no la toca.
    await withAuth(http(t).patch(`/users/${target.id}`), token, tenant.id).send({
      areaId: area.id,
    });

    const resOmitted = await withAuth(
      http(t).patch(`/users/${target.id}`),
      token,
      tenant.id,
    ).send({ firstName: 'Sin Tocar Área' });
    expect(resOmitted.status).toBe(200);
    expect(resOmitted.body.area).toEqual({ id: area.id, name: area.name });
  });

  // --- BE-USR-26: PATCH /users/:id/full (edición multiempresa) ---

  it('BE-USR-26: PATCH /users/:id/full aplica el diff atómico — agrega una empresa y cambia rol en otra', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const tenantP = await createTenant(t.prisma, { slug: uniqueSlug('usr26a-p') });
    const tenantQ = await createTenant(t.prisma, { slug: uniqueSlug('usr26a-q') });
    const roleP1 = await createRole(t.prisma, { tenantId: tenantP.id, name: 'Rol P1' });
    const roleP2 = await createRole(t.prisma, { tenantId: tenantP.id, name: 'Rol P2' });
    const roleQ = await createRole(t.prisma, { tenantId: tenantQ.id, name: 'Rol Q' });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr26a-target'),
      memberships: [{ tenantId: tenantP.id, roleId: roleP1.id }],
    });

    const res = await withAuth(
      http(t).patch(`/users/${target.id}/full`),
      token,
      systemTenant.id,
    ).send({
      memberships: [
        { tenantId: tenantP.id, roleId: roleP2.id },
        { tenantId: tenantQ.id, roleId: roleQ.id },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: false, message: 'Usuario guardado.' });

    const membershipP = await t.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId: target.id, tenantId: tenantP.id } },
    });
    expect(membershipP!.roleId).toBe(roleP2.id);
    const membershipQ = await t.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId: target.id, tenantId: tenantQ.id } },
    });
    expect(membershipQ).not.toBeNull();
    expect(membershipQ!.roleId).toBe(roleQ.id);
  });

  it('BE-USR-26: PATCH /users/:id/full con memberships:[] da de baja lógica cuando la persona queda sin ninguna empresa', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr26b') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol único' });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr26b-target'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });

    const res = await withAuth(
      http(t).patch(`/users/${target.id}/full`),
      token,
      systemTenant.id,
    ).send({ memberships: [] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.message).toContain('No se puede reactivar');

    const updated = await t.prisma.user.findUnique({ where: { id: target.id } });
    expect(updated!.deletedAt).not.toBeNull();
  });

  it('BE-USR-26: PATCH /users/:id/full quitándose a uno mismo de una empresa devuelve 400', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr26c') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Con permisos',
      permissions: ['users:update', 'users:delete'],
    });
    const self = await createUser(t.prisma, {
      email: uniqueEmail('usr26c-self'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, self);

    const res = await withAuth(http(t).patch(`/users/${self.id}/full`), token, tenant.id).send({
      memberships: [],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('No podés darte de baja a vos mismo');
  });

  it('BE-USR-26: PATCH /users/:id/full agregando una empresa sin permiso de create ahí devuelve 403', async () => {
    const tenantY = await createTenant(t.prisma, { slug: uniqueSlug('usr26d-y') });
    const tenantZ = await createTenant(t.prisma, { slug: uniqueSlug('usr26d-z') });
    // El editor solo tiene `users:update` (no `create`) en Y, y ni siquiera es miembro de Z.
    const roleY = await createRole(t.prisma, {
      tenantId: tenantY.id,
      name: 'Solo update',
      permissions: ['users:update'],
    });
    const roleZ = await createRole(t.prisma, { tenantId: tenantZ.id, name: 'Rol Z' });
    const target = await createUser(t.prisma, {
      email: uniqueEmail('usr26d-target'),
      memberships: [{ tenantId: tenantY.id, roleId: roleY.id }],
    });
    const editor = await createUser(t.prisma, {
      email: uniqueEmail('usr26d-editor'),
      memberships: [{ tenantId: tenantY.id, roleId: roleY.id }],
    });
    const token = tokenFor(t, editor);

    const res = await withAuth(
      http(t).patch(`/users/${target.id}/full`),
      token,
      tenantY.id,
    ).send({
      memberships: [
        { tenantId: tenantY.id, roleId: roleY.id }, // sin cambios, se mantiene
        { tenantId: tenantZ.id, roleId: roleZ.id }, // alta nueva sin permiso
      ],
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('No pertenecés a alguna de las empresas seleccionadas');
  });

  // --- BE-USR-27..35: carga masiva (POST /users/bulk-import) ---
  //
  // Contrato del servicio (`UsersService.bulkImport`, users.service.ts L380-582):
  //   respuesta = {
  //     summary: { total, created, failed },   // NÚMEROS (created.length / failed.length)
  //     created: [{ email, firstName, lastName, tempPassword }],
  //     failed:  [{ row, email, reason }],
  //   }
  // El endpoint es `@Post('bulk-import')` sin `@HttpCode`, así que un lote aceptado da 201.
  // Hereda la cadena de clase `@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)` + a nivel de
  // ruta `@RequirePermission('users','create')`, y opera sobre el tenant del header (como
  // `create`), NO cross-tenant (users.controller.ts L128-136).

  /** Fila mínima válida del Excel ya mapeada (email + nombre + apellido). */
  const validRow = (label: string) => ({
    email: uniqueEmail(label),
    firstName: 'Nombre',
    lastName: 'Apellido',
  });

  it('BE-USR-27: bulk-import de un lote válido devuelve 201 y crea persona + membresía con tempPassword por fila', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr27') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr27-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);
    const rows = [validRow('usr27-a'), validRow('usr27-b'), validRow('usr27-c')];

    const res = await withAuth(http(t).post('/users/bulk-import'), token, tenant.id).send({
      defaultRoleId: role.id,
      rows,
    });

    expect(res.status).toBe(201); // @Post() sin @HttpCode → default de Nest
    // summary.created / failed son NÚMEROS (users.service.ts L578: created.length / failed.length)
    expect(res.body.summary).toEqual({ total: 3, created: 3, failed: 0 });
    expect(res.body.created).toHaveLength(3);
    expect(res.body.failed).toEqual([]);

    // Cada creado trae su contraseña temporal autogenerada (users.service.ts L484,555-562).
    for (const c of res.body.created as any[]) {
      expect(typeof c.tempPassword).toBe('string');
      expect(c.tempPassword.length).toBeGreaterThan(0);
    }

    // Persona + membresía en el TENANT ACTIVO con el rol default (createMany de User + UserTenant,
    // users.service.ts L516-548).
    for (const row of rows) {
      const created = await t.prisma.user.findFirst({ where: { email: row.email } });
      expect(created).not.toBeNull();
      const membership = await t.prisma.userTenant.findUnique({
        where: { userId_tenantId: { userId: created!.id, tenantId: tenant.id } },
      });
      expect(membership).not.toBeNull();
      expect(membership!.roleId).toBe(role.id);
    }
  });

  it('BE-USR-28: bulk-import con defaultAreaId deja todas las membresías del lote con esa área', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr28') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const area = await createArea(t.prisma, { tenantId: tenant.id, name: 'Área 28' });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr28-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);
    const rows = [validRow('usr28-a'), validRow('usr28-b')];

    const res = await withAuth(http(t).post('/users/bulk-import'), token, tenant.id).send({
      defaultRoleId: role.id,
      defaultAreaId: area.id,
      rows,
    });

    expect(res.status).toBe(201);
    expect(res.body.summary).toEqual({ total: 2, created: 2, failed: 0 });

    // `areaId` es único para todo el lote (users.service.ts L382,544-546).
    for (const row of rows) {
      const created = await t.prisma.user.findFirst({ where: { email: row.email } });
      const membership = await t.prisma.userTenant.findUnique({
        where: { userId_tenantId: { userId: created!.id, tenantId: tenant.id } },
      });
      expect(membership!.areaId).toBe(area.id);
    }
  });

  it('BE-USR-29: bulk-import con un email ya activo en la empresa reporta esa fila en failed y crea el resto', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr29') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr29-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    // Un usuario ACTIVO cuyo email ya existe (uniqueEmail siempre devuelve minúsculas).
    const dupEmail = uniqueEmail('usr29-dup');
    await createUser(t.prisma, {
      email: dupEmail,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const fresh = validRow('usr29-nueva');

    const res = await withAuth(http(t).post('/users/bulk-import'), token, tenant.id).send({
      defaultRoleId: role.id,
      rows: [{ email: dupEmail, firstName: 'Choca', lastName: 'Email' }, fresh],
    });

    // Reporte parcial: la fila del email tomado va a failed, la nueva se crea.
    expect(res.status).toBe(201);
    expect(res.body.summary).toEqual({ total: 2, created: 1, failed: 1 });
    expect(res.body.created[0].email).toBe(fresh.email);
    // NOTA: en la práctica esta fila la corta el pre-check de disponibilidad contra la base
    // (users.service.ts L471-472), NO el `skipDuplicates` del createMany (ese es solo el
    // fallback TOCTOU, L508-513). El motivo real es el del pre-check:
    expect(res.body.failed[0]).toMatchObject({
      email: dupEmail,
      reason: 'Ya existe un usuario con ese email',
    });
  });

  it('BE-USR-30: bulk-import con filas duplicadas DENTRO del archivo — la primera se crea, la segunda va a failed', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr30') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr30-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    // Email repetido en el archivo (users.service.ts L400-403).
    const email = uniqueEmail('usr30-mismo');
    const resEmail = await withAuth(http(t).post('/users/bulk-import'), token, tenant.id).send({
      defaultRoleId: role.id,
      rows: [
        { email, firstName: 'Primera', lastName: 'Fila' },
        { email, firstName: 'Segunda', lastName: 'Fila' },
      ],
    });
    expect(resEmail.status).toBe(201);
    expect(resEmail.body.summary).toEqual({ total: 2, created: 1, failed: 1 });
    // La fila 1 del Excel son los headers, así que la 2da fila de datos es `row: 3`
    // (users.service.ts L392-394).
    expect(resEmail.body.failed[0]).toMatchObject({
      row: 3,
      email,
      reason: 'Email duplicado en el archivo',
    });

    // Teléfono repetido en el archivo (users.service.ts L404-407).
    const phone = uniquePhone();
    const resPhone = await withAuth(http(t).post('/users/bulk-import'), token, tenant.id).send({
      defaultRoleId: role.id,
      rows: [
        { email: uniqueEmail('usr30-p1'), firstName: 'Con', lastName: 'Tel', phone },
        { email: uniqueEmail('usr30-p2'), firstName: 'Choca', lastName: 'Tel', phone },
      ],
    });
    expect(resPhone.status).toBe(201);
    expect(resPhone.body.summary).toEqual({ total: 2, created: 1, failed: 1 });
    expect(resPhone.body.failed[0].reason).toBe('Teléfono duplicado en el archivo');
  });

  it('BE-USR-31: bulk-import con filas sin email o sin nombre/apellido devuelve 400 del lote entero (ValidationPipe)', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr31') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr31-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    const asMessages = (m: unknown): string[] => (Array.isArray(m) ? m : [m]) as string[];

    // Fila con email inválido → `@IsEmail` de BulkImportUserRowDto (user.dto.ts L259) corta el
    // lote ENTERO vía `@ValidateNested` (L305). El ValidationPipe global (whitelist+transform)
    // ya está aplicado por createTestApp. El mensaje llega prefijado con la ruta anidada
    // (`rows.<i>.<mensaje>`).
    const resEmail = await withAuth(http(t).post('/users/bulk-import'), token, tenant.id).send({
      defaultRoleId: role.id,
      rows: [{ email: '', firstName: 'Nombre', lastName: 'Apellido' }],
    });
    expect(resEmail.status).toBe(400);
    const emailMsgs = asMessages(resEmail.body.message);
    expect(emailMsgs.some((m) => m.includes('El email no es válido'))).toBe(true);
    expect(emailMsgs.some((m) => /^rows\.\d+\./.test(m))).toBe(true);

    // Fila con nombre vacío → `@IsNotEmpty` (user.dto.ts L263).
    const resName = await withAuth(http(t).post('/users/bulk-import'), token, tenant.id).send({
      defaultRoleId: role.id,
      rows: [{ email: uniqueEmail('usr31-ok'), firstName: '', lastName: 'Apellido' }],
    });
    expect(resName.status).toBe(400);
    expect(asMessages(resName.body.message).some((m) => m.includes('El nombre es obligatorio'))).toBe(
      true,
    );
  });

  it('BE-USR-32: bulk-import con >10.000 filas o con formato inválido devuelve 400 del lote entero', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr32') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr32-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);

    const asMessages = (m: unknown): string[] => (Array.isArray(m) ? m : [m]) as string[];

    // >10.000 filas → `@ArrayMaxSize(10000)` (user.dto.ts L304). Las filas van VÁLIDAS A PROPÓSITO:
    // si estuvieran incompletas (`{}`), cada una dispararía además los errores anidados de
    // `@ValidateNested` (email/nombre/apellido), y el ValidationPipe devuelve esos mensajes por
    // fila en vez del de `@ArrayMaxSize` — el mensaje de tamaño solo queda garantizado cuando es
    // la ÚNICA restricción que falla. Con filas válidas el lote pesa ~1mb: el test app replica el
    // `json({ limit:'10mb' })` de main.ts (ver support/app.ts), así que no lo corta un 413.
    const tooMany = await withAuth(http(t).post('/users/bulk-import'), token, tenant.id).send({
      defaultRoleId: role.id,
      rows: Array.from({ length: 10001 }, (_, i) => validRow(`usr32-many-${i}`)),
    });
    expect(tooMany.status).toBe(400);
    expect(
      asMessages(tooMany.body.message).some((m) => m.includes('Máximo 10000 filas por importación')),
    ).toBe(true);

    // Formato inválido de una fila (`@MaxLength(80)` en firstName, user.dto.ts L264) → 400.
    const tooLong = await withAuth(http(t).post('/users/bulk-import'), token, tenant.id).send({
      defaultRoleId: role.id,
      rows: [{ email: uniqueEmail('usr32-long'), firstName: 'x'.repeat(81), lastName: 'Apellido' }],
    });
    expect(tooLong.status).toBe(400);
    expect(asMessages(tooLong.body.message).some((m) => m.includes('80'))).toBe(true);
  });

  it('BE-USR-33: bulk-import con defaultRoleId o defaultAreaId de OTRO tenant devuelve 400', async () => {
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr33-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('usr33-b') });
    const roleA = await createRole(t.prisma, {
      tenantId: tenantA.id,
      name: 'Gestor A',
      permissions: ['users:create'],
    });
    const roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol ajeno B' });
    const areaB = await createArea(t.prisma, { tenantId: tenantB.id, name: 'Área ajena B' });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr33-req'),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const token = tokenFor(t, requester);

    // Rol de otro tenant → assertRoleBelongsToTenant (users.service.ts L381,1096-1101).
    const resRole = await withAuth(http(t).post('/users/bulk-import'), token, tenantA.id).send({
      defaultRoleId: roleB.id,
      rows: [validRow('usr33-r')],
    });
    expect(resRole.status).toBe(400);
    expect(resRole.body.message).toBe('El rol no existe o no pertenece a este tenant');

    // Área de otro tenant → assertAreaBelongsToTenant (users.service.ts L383,1104-1109).
    const resArea = await withAuth(http(t).post('/users/bulk-import'), token, tenantA.id).send({
      defaultRoleId: roleA.id,
      defaultAreaId: areaB.id,
      rows: [validRow('usr33-ar')],
    });
    expect(resArea.status).toBe(400);
    expect(resArea.body.message).toBe('El área no existe o no pertenece a este tenant');
  });

  it('BE-USR-34: bulk-import parado en una empresa donde el solicitante NO es miembro devuelve 403 (TenantGuard)', async () => {
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('usr34-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('usr34-b') });
    const roleA = await createRole(t.prisma, {
      tenantId: tenantA.id,
      name: 'Gestor A',
      permissions: ['users:create'],
    });
    const roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol B' });
    // El solicitante es miembro de A, pero NO de B (y no es superusuario de sistema).
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr34-req'),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const token = tokenFor(t, requester);

    // El header apunta a B: TenantGuard corta antes que ValidationPipe y RolesGuard
    // (tenant.guard.ts L82-88). La excepción "salvo superusuario del sistema" (L85-93) no aplica.
    const res = await withAuth(http(t).post('/users/bulk-import'), token, tenantB.id).send({
      defaultRoleId: roleB.id,
      rows: [validRow('usr34')],
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('No tenés acceso a este tenant');
  });

  it('BE-USR-35: la respuesta bulk-import devuelve created[].tempPassword en texto plano (verificable contra el hash)', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('usr35') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Gestor',
      permissions: ['users:create'],
    });
    const requester = await createUser(t.prisma, {
      email: uniqueEmail('usr35-req'),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, requester);
    const row = validRow('usr35');

    const res = await withAuth(http(t).post('/users/bulk-import'), token, tenant.id).send({
      defaultRoleId: role.id,
      rows: [row],
    });

    expect(res.status).toBe(201);
    const createdRow = (res.body.created as any[]).find((c) => c.email === row.email);
    expect(createdRow).toBeDefined();

    // La contraseña temporal viaja EN CLARO (dato sensible acotado a la carga inicial). Se
    // verifica que es la contraseña REAL: el hash bcrypt guardado en la base valida contra ella.
    expect(typeof createdRow.tempPassword).toBe('string');
    const persisted = await t.prisma.user.findFirst({ where: { email: row.email } });
    expect(persisted).not.toBeNull();
    expect(await bcrypt.compare(createdRow.tempPassword, persisted!.passwordHash)).toBe(true);
  });
});
