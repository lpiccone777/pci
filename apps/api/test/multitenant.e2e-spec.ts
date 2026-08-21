/**
 * 1.3 Multitenant — aislamiento y resolución de tenant (BE-MT-*)
 *
 * Vía: endpoints REST reales con supertest, ejercitando `TenantGuard` y `SystemTenantGuard`
 * (`src/common/guards/`) tal cual corren en producción — son lógica pura contra Prisma, sin
 * ninguna frontera externa que mockear.
 *
 * BE-MT-12 comprueba que el superusuario parado en una empresa común sigue viendo la config
 * global y todas las empresas. Intervienen dos cortes distintos:
 *  - `TenantGuard.resolveAsSystemUser` decide quién puede pararse en una empresa de la que no
 *    es miembro: SOLO el superusuario real (rol SuperAdmin en el tenant de sistema, ver
 *    `isSystemSuperAdmin`). Un usuario común que además pertenece al tenant de sistema NO.
 *  - `SystemTenantGuard` corta por el VÍNCULO resuelto (`request.userTenant`, que para el
 *    superusuario parado en otra empresa sigue siendo el de sistema), no por la empresa activa
 *    (`request.tenantId`). Ese corte es por membresía en el tenant de sistema + permiso RBAC,
 *    no por nombre de rol.
 *
 * BE-MT-13 es el complemento adversarial: comprueba que un miembro del tenant de sistema con un
 * rol COMÚN (no SuperAdmin) NO hereda el poder de pararse en cualquier empresa. El corte de
 * `TenantGuard.resolveAsSystemUser` es por rol (`isProtectedRole`), no por mera pertenencia.
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
  createArea,
  getSystemContext,
  uniqueEmail,
  uniqueSlug,
  DEFAULT_PASSWORD,
} from './support';

describe('1.3 Multitenant (BE-MT-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  /** Tenant + rol con `areas:read`. Atajo repetido: la mayoría de los casos solo necesitan
   *  "una empresa donde el usuario pueda leer algo". */
  async function tenantWithReader(slugLabel: string) {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug(slugLabel) });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Lector',
      permissions: ['areas:read'],
    });
    return { tenant, role };
  }

  it('BE-MT-01: usuario con 1 tenant, sin header, opera con el único tenant', async () => {
    const { tenant, role } = await tenantWithReader('mt01');
    const user = await createUser(t.prisma, {
      email: uniqueEmail('mt01'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/areas'), token); // sin X-Tenant-Id

    expect(res.status).toBe(200);
  });

  it('BE-MT-02: usuario con 1 tenant, header que coincide, responde OK', async () => {
    const { tenant, role } = await tenantWithReader('mt02');
    const user = await createUser(t.prisma, {
      email: uniqueEmail('mt02'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/areas'), token, tenant.id);

    expect(res.status).toBe(200);
  });

  it('BE-MT-03: usuario con varios tenants, sin header, devuelve 400 pidiendo el header X-Tenant-Id', async () => {
    const { tenant: t1, role: r1 } = await tenantWithReader('mt03-a');
    const { tenant: t2, role: r2 } = await tenantWithReader('mt03-b');
    const user = await createUser(t.prisma, {
      email: uniqueEmail('mt03'),
      password: DEFAULT_PASSWORD,
      memberships: [
        { tenantId: t1.id, roleId: r1.id },
        { tenantId: t2.id, roleId: r2.id },
      ],
    });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/areas'), token); // sin header

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('indicá cuál usar en el header X-Tenant-Id');
  });

  it('BE-MT-04: usuario con varios tenants, header de uno al que pertenece, opera sobre ese tenant', async () => {
    const { tenant: t1, role: r1 } = await tenantWithReader('mt04-a');
    const { tenant: t2, role: r2 } = await tenantWithReader('mt04-b');
    await createArea(t.prisma, { tenantId: t2.id, name: 'Área de B' });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('mt04'),
      password: DEFAULT_PASSWORD,
      memberships: [
        { tenantId: t1.id, roleId: r1.id },
        { tenantId: t2.id, roleId: r2.id },
      ],
    });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/areas'), token, t2.id);

    expect(res.status).toBe(200);
    expect(res.body.every((a: any) => a.tenantId === t2.id)).toBe(true);
    expect(res.body.some((a: any) => a.name === 'Área de B')).toBe(true);
  });

  it('BE-MT-05: header de un tenant al que no pertenece (usuario común) devuelve 403 "No tenés acceso a este tenant"', async () => {
    const { tenant, role } = await tenantWithReader('mt05');
    const other = await createTenant(t.prisma, { slug: uniqueSlug('mt05-other') });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('mt05'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/areas'), token, other.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('No tenés acceso a este tenant');
  });

  it('BE-MT-06: header de un tenant al que no pertenece, pero el usuario es de sistema, opera con el rol de sistema sobre esa empresa', async () => {
    const { admin } = await getSystemContext(t.prisma);
    const common = await createTenant(t.prisma, { slug: uniqueSlug('mt06') });
    const token = tokenFor(t, admin);

    const res = await withAuth(http(t).get('/areas'), token, common.id);

    // El SuperAdmin no tiene membresía en `common`, pero `TenantGuard.resolveAsSystemUser` lo
    // deja pasar con el vínculo del tenant de sistema, y `RolesGuard` bypassea el chequeo de
    // permiso puntual por tratarse del rol protegido (ver BE-RBAC-03).
    expect(res.status).toBe(200);
  });

  it('BE-MT-07: usuario de sistema con header de una empresa inexistente o dada de baja devuelve 404 "La empresa indicada no existe"', async () => {
    const { admin } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const deleted = await createTenant(t.prisma, {
      slug: uniqueSlug('mt07-baja'),
      deletedAt: new Date(),
    });

    const inexistente = await withAuth(
      http(t).get('/areas'),
      token,
      '00000000-0000-0000-0000-000000000000',
    );
    expect(inexistente.status).toBe(404);
    expect(inexistente.body.message).toBe('La empresa indicada no existe');

    const baja = await withAuth(http(t).get('/areas'), token, deleted.id);
    expect(baja.status).toBe(404);
    expect(baja.body.message).toBe('La empresa indicada no existe');
  });

  it('BE-MT-08: usuario sin ninguna membresía activa devuelve 403 "El usuario no pertenece a ningún tenant"', async () => {
    const user = await createUser(t.prisma, { email: uniqueEmail('mt08'), password: DEFAULT_PASSWORD });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/areas'), token);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('El usuario no pertenece a ningún tenant');
  });

  it('BE-MT-09: listar recursos parado en el tenant A nunca devuelve datos del tenant B (áreas, usuarios, roles)', async () => {
    const { tenant: tenantA, role: roleA } = await tenantWithReader('mt09-a');
    const { tenant: tenantB, role: roleB } = await tenantWithReader('mt09-b');
    await createArea(t.prisma, { tenantId: tenantA.id, name: 'Área A' });
    await createArea(t.prisma, { tenantId: tenantB.id, name: 'Área B' });
    const userA = await createUser(t.prisma, {
      email: uniqueEmail('mt09-a'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const userB = await createUser(t.prisma, {
      email: uniqueEmail('mt09-b'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: tenantB.id, roleId: roleB.id }],
    });
    // roleA necesita también users:read y roles:read para las otras dos consultas de este caso.
    await t.prisma.rolePermission.createMany({
      data: [
        { roleId: roleA.id, resource: 'users', action: 'read' },
        { roleId: roleA.id, resource: 'roles', action: 'read' },
      ],
    });
    const token = tokenFor(t, userA);

    const areas = await withAuth(http(t).get('/areas'), token, tenantA.id);
    expect(areas.status).toBe(200);
    expect(areas.body.every((a: any) => a.tenantId === tenantA.id)).toBe(true);
    expect(areas.body.some((a: any) => a.name === 'Área B')).toBe(false);

    const users = await withAuth(http(t).get('/users'), token, tenantA.id);
    expect(users.status).toBe(200);
    const emails = users.body.map((u: any) => u.email);
    expect(emails).toContain(userA.email);
    expect(emails).not.toContain(userB.email);

    const roles = await withAuth(http(t).get('/roles'), token, tenantA.id);
    expect(roles.status).toBe(200);
    const roleIds = roles.body.map((r: any) => r.id);
    expect(roleIds).toContain(roleA.id);
    expect(roleIds).not.toContain(roleB.id);
  });

  it('BE-MT-10: una membresía contra un tenant dado de baja no cuenta como pertenencia', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('mt10') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Lector',
      permissions: ['areas:read'],
    });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('mt10'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    // Baja la empresa DESPUÉS de crear la membresía.
    await t.prisma.tenant.update({ where: { id: tenant.id }, data: { deletedAt: new Date() } });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/areas'), token); // sin header

    // `TenantGuard` filtra `tenant: { deletedAt: null }` al listar membresías: la fila queda
    // afuera y el usuario aparece igual que si no perteneciera a ningún tenant (mismo mensaje
    // que BE-MT-08), no como "un solo tenant, sin header".
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('El usuario no pertenece a ningún tenant');
  });

  it('BE-MT-11: enviar tenantId en el body no lo reemplaza: el tenant sale siempre del header', async () => {
    const { tenant, role } = await tenantWithReader('mt11');
    const other = await createTenant(t.prisma, { slug: uniqueSlug('mt11-other') });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('mt11'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    await t.prisma.rolePermission.create({ data: { roleId: role.id, resource: 'areas', action: 'create' } });
    const token = tokenFor(t, user);

    // Camino real: sin tenantId en el body, la creación queda bajo el tenant del header.
    const ok = await withAuth(http(t).post('/areas').send({ name: 'Área legítima MT-11' }), token, tenant.id);
    expect(ok.status).toBe(201);
    expect(ok.body.tenantId).toBe(tenant.id);

    // `CreateAreaDto` no declara `tenantId` (ver `area.dto.ts`: el único campo es `name`).
    // Con el `ValidationPipe` global (`whitelist` + `forbidNonWhitelisted`) mandarlo en el body
    // no lo "ignora en silencio" — lo RECHAZA de plano, antes de que el controlador llegue a
    // leer nada. Es una forma más fuerte de la misma garantía que pide el caso: el tenant no
    // puede viajar por el body de ninguna manera. Se deja documentada la discrepancia con la
    // redacción del plan ("se ignora"): el código, más estricto, corta con 400.
    const rejected = await withAuth(
      http(t).post('/areas').send({ name: 'Intento con tenantId', tenantId: other.id }),
      token,
      tenant.id,
    );
    expect(rejected.status).toBe(400);

    const leaked = await t.prisma.area.findFirst({ where: { name: 'Intento con tenantId' } });
    expect(leaked).toBeNull(); // no se creó en NINGÚN tenant, ni en el del header ni en `other`
  });

  // --- BE-MT-12: el candado de superusuario lee el vínculo de sistema, no la empresa activa ---
  it('BE-MT-12: el superusuario parado en una empresa común sigue viendo la configuración global y todas las empresas', async () => {
    const { admin } = await getSystemContext(t.prisma);
    const common = await createTenant(t.prisma, { slug: uniqueSlug('mt12') });
    const token = tokenFor(t, admin);

    // `SystemTenantGuard` mira `request.userTenant` (el vínculo de sistema que dejó
    // `TenantGuard.resolveAsSystemUser`), igual que `RolesGuard` — no `request.tenantId`
    // (la empresa pedida en el header). `/settings` es la config global, única en toda la
    // base: responde igual sin importar en qué empresa esté parado el superusuario.
    const settingsRes = await withAuth(http(t).get('/settings'), token, common.id);
    expect(settingsRes.status).toBe(200);

    // Mismo mecanismo en la otra pantalla cross-tenant: `GET /tenants/all`.
    const tenantsRes = await withAuth(http(t).get('/tenants/all'), token, common.id);
    expect(tenantsRes.status).toBe(200);
  });

  // --- BE-MT-13: ser miembro del tenant de sistema NO alcanza; hace falta el rol SuperAdmin ---
  it('BE-MT-13: un miembro común del tenant de sistema (rol distinto de SuperAdmin) NO puede pararse en otra empresa (403)', async () => {
    // Complemento adversarial de BE-MT-06: mismo escenario (header de una empresa de la que no
    // se es miembro), pero el usuario tiene en el tenant de sistema un rol COMÚN, no SuperAdmin.
    // `TenantGuard.resolveAsSystemUser` corta por el rol, no por la mera pertenencia al tenant de
    // sistema (ver `isProtectedRole`): un rol común no hereda el poder de operar cualquier
    // empresa, así que recibe el mismo 403 que un usuario ajeno (BE-MT-05).
    const { tenant: systemTenant } = await getSystemContext(t.prisma);
    const commonRole = await createRole(t.prisma, {
      tenantId: systemTenant.id,
      name: 'Miembro común de sistema',
      permissions: ['areas:read'],
    });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('mt13'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: systemTenant.id, roleId: commonRole.id }],
    });
    const otra = await createTenant(t.prisma, { slug: uniqueSlug('mt13-otra') });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/areas'), token, otra.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('No tenés acceso a este tenant');
  });
});
