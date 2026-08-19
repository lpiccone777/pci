/**
 * 1.4 Tenants — gestión y doble candado de superusuario (BE-TEN-*)
 *
 * Vía: endpoints REST reales (`/tenants/*`) con supertest, sobre la base efímera.
 * Sin frontera externa que mockear: todo lo que se ejercita es guard + service + Prisma real.
 *
 * Doble candado: las operaciones cross-tenant (`/tenants/all`, alta/edición/baja/restore) piden
 * `SystemTenantGuard` (tenant activo = sistema) **y** el permiso `tenants:*`. La cadena de
 * guards del controlador es `JwtAuthGuard, TenantGuard, RolesGuard` a nivel clase y
 * `SystemTenantGuard` a nivel método — por orden de ejecución de Nest (guards de clase antes que
 * los de método), `RolesGuard` corre ANTES que `SystemTenantGuard`. Por eso, para probar el
 * candado de `SystemTenantGuard` de forma aislada (BE-TEN-03), el usuario de prueba SÍ tiene el
 * permiso `tenants:read` pero está parado en una empresa común: así el primer candado (RBAC) no
 * interfiere y lo que corta es el segundo.
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
  getSystemContext,
  uniqueEmail,
  uniquePhone,
  uniqueSlug,
} from './support';

describe('1.4 Tenants (BE-TEN-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  /** Usuario con `tenants:read` (o los permisos que se pidan) en una empresa COMÚN. */
  async function createRegularAdmin(perms: string[] = ['tenants:read']) {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('ten') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Admin Empresa',
      permissions: perms,
    });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('ten'),
      phone: uniquePhone(),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    return { tenant, role, user, token: tokenFor(t, user) };
  }

  it('BE-TEN-01: GET /tenants parado en un tenant devuelve sólo el tenant activo', async () => {
    const { tenant, token } = await createRegularAdmin(['tenants:read']);

    const res = await withAuth(http(t).get('/tenants'), token, tenant.id);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(tenant.id);
    // Nota: el plan dice "con conteos de usuarios/roles/áreas", pero
    // `TenantsService.findMyTenants` hace un `findMany` SIN el include de `_count` (a
    // diferencia de `findAll`/`create`/`update`, que sí lo traen y lo mapean con `toResponse`).
    // El código real no devuelve `userCount`/`roleCount`/`areaCount` acá. El comentario del
    // propio service lo explica: "el frontend obtiene todos desde /auth/me".
    expect(res.body[0].userCount).toBeUndefined();
    expect(res.body[0].roleCount).toBeUndefined();
  });

  it('BE-TEN-02: GET /tenants/all desde el tenant de sistema con permiso trae todos, y con includeDeleted también los dados de baja', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const active = await createTenant(t.prisma, { slug: uniqueSlug('ten02-activo') });
    const deleted = await createTenant(t.prisma, {
      slug: uniqueSlug('ten02-baja'),
      deletedAt: new Date(),
    });

    const resDefault = await withAuth(http(t).get('/tenants/all'), token, systemTenant.id);
    expect(resDefault.status).toBe(200);
    const idsDefault = resDefault.body.map((x: any) => x.id);
    expect(idsDefault).toContain(active.id);
    expect(idsDefault).not.toContain(deleted.id);
    const activeRow = resDefault.body.find((x: any) => x.id === active.id);
    expect(activeRow.userCount).toBe(0);
    expect(activeRow.roleCount).toBe(0);
    expect(activeRow.areaCount).toBe(0);
    expect(activeRow.isSystem).toBe(false);

    const resAll = await withAuth(
      http(t).get('/tenants/all?includeDeleted=true'),
      token,
      systemTenant.id,
    );
    expect(resAll.status).toBe(200);
    const idsAll = resAll.body.map((x: any) => x.id);
    expect(idsAll).toContain(deleted.id);
  });

  it('BE-TEN-03: GET /tenants/all desde un tenant que no es el de sistema devuelve 403', async () => {
    // El usuario TIENE tenants:read (pasa RolesGuard) pero está parado en una empresa común:
    // lo que corta acá es específicamente SystemTenantGuard.
    const { tenant, token } = await createRegularAdmin(['tenants:read']);

    const res = await withAuth(http(t).get('/tenants/all'), token, tenant.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Esta operación solo puede realizarse desde el tenant de sistema');
  });

  it('BE-TEN-04: crear un tenant desde el tenant de sistema devuelve 201', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const slug = uniqueSlug('ten04');

    const res = await withAuth(http(t).post('/tenants'), token, systemTenant.id).send({
      name: 'Empresa Nueva TEN-04',
      slug,
    });

    // `@Post()` sin `@HttpCode` → 201 (default de Nest).
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe(slug);
    expect(res.body.name).toBe('Empresa Nueva TEN-04');
    expect(res.body.isSystem).toBe(false);
    expect(res.body.userCount).toBe(0);
  });

  it('BE-TEN-05: crear un tenant con un slug ya en uso (aunque el dueño esté de baja) devuelve 409', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const slug = uniqueSlug('ten05');
    await createTenant(t.prisma, { slug, deletedAt: new Date() }); // dueño de baja, sigue ocupando el slug

    const res = await withAuth(http(t).post('/tenants'), token, systemTenant.id).send({
      name: 'Otra Empresa',
      slug,
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe(`Ya existe una empresa con el slug ${slug} (puede estar dada de baja).`);
  });

  it('BE-TEN-06: editar el name de la empresa de sistema está permitido (cosmético)', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const originalName = systemTenant.name;

    try {
      const res = await withAuth(http(t).patch(`/tenants/${systemTenant.id}`), token, systemTenant.id).send({
        name: 'Sistema (renombrado TEN-06)',
        slug: systemTenant.slug, // mismo slug: el slug NO se toca
      });

      // `@Patch()` sin `@HttpCode` → 200 (default de Nest para PATCH).
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Sistema (renombrado TEN-06)');
      expect(res.body.slug).toBe(systemTenant.slug);
      expect(res.body.isSystem).toBe(true);
    } finally {
      // Restaurar: el tenant de sistema es un fixture compartido por toda la corrida (seed),
      // no un fixture propio de este test.
      await t.prisma.tenant.update({ where: { id: systemTenant.id }, data: { name: originalName } });
    }
  });

  it('BE-TEN-07: cambiar el slug de la empresa de sistema devuelve 409', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);

    const res = await withAuth(http(t).patch(`/tenants/${systemTenant.id}`), token, systemTenant.id).send({
      name: systemTenant.name,
      slug: uniqueSlug('nuevo-slug-sistema'),
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('No se puede cambiar el slug de la empresa de sistema');
    // Verifica que el slug no haya cambiado en la base.
    const fresh = await t.prisma.tenant.findUniqueOrThrow({ where: { id: systemTenant.id } });
    expect(fresh.slug).toBe(systemTenant.slug);
  });

  it('BE-TEN-08: la baja lógica de un tenant marca deletedAt sin borrarlo, y el slug queda ocupado', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const slug = uniqueSlug('ten08');
    const tenant = await createTenant(t.prisma, { slug });

    const res = await withAuth(http(t).delete(`/tenants/${tenant.id}`), token, systemTenant.id);

    // `@Delete()` sin `@HttpCode` → 200 (default de Nest).
    expect(res.status).toBe(200);
    const fresh = await t.prisma.tenant.findUnique({ where: { id: tenant.id } });
    expect(fresh).not.toBeNull(); // sigue en la base, no se borró
    expect(fresh!.deletedAt).not.toBeNull();

    // El slug sigue ocupado: un alta nueva con el mismo slug choca.
    const create = await withAuth(http(t).post('/tenants'), token, systemTenant.id).send({
      name: 'Choca con TEN-08',
      slug,
    });
    expect(create.status).toBe(409);
  });

  it('BE-TEN-09: la baja lógica de la empresa de sistema devuelve 409, no se puede', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);

    const res = await withAuth(http(t).delete(`/tenants/${systemTenant.id}`), token, systemTenant.id);

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('es la empresa de sistema: no se puede dar de baja.');
    const fresh = await t.prisma.tenant.findUniqueOrThrow({ where: { id: systemTenant.id } });
    expect(fresh.deletedAt).toBeNull();
  });

  it('BE-TEN-10: restaurar un tenant dado de baja funciona; restaurar uno ya activo o inexistente da 404', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const tenant = await createTenant(t.prisma, {
      slug: uniqueSlug('ten10'),
      deletedAt: new Date(),
    });

    const res = await withAuth(
      http(t).post(`/tenants/${tenant.id}/restore`),
      token,
      systemTenant.id,
    );

    // `@Post()` sin `@HttpCode` → 201 (default de Nest), aunque semánticamente sea una acción.
    expect(res.status).toBe(201);
    const fresh = await t.prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(fresh.deletedAt).toBeNull();

    // Ya está activo: restaurar de nuevo no lo encuentra entre los dados de baja.
    const resYaActivo = await withAuth(
      http(t).post(`/tenants/${tenant.id}/restore`),
      token,
      systemTenant.id,
    );
    expect(resYaActivo.status).toBe(404);

    // Id inexistente.
    const resInexistente = await withAuth(
      http(t).post('/tenants/00000000-0000-0000-0000-000000000000/restore'),
      token,
      systemTenant.id,
    );
    expect(resInexistente.status).toBe(404);
  });

  it('BE-TEN-11: editar name y slug de una empresa común actualiza ambos; slug ya en uso (aunque de baja) da 409', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('ten11-a') });
    const newSlug = uniqueSlug('ten11-nuevo');

    const res = await withAuth(http(t).patch(`/tenants/${tenant.id}`), token, systemTenant.id).send({
      name: 'Empresa Renombrada TEN-11',
      slug: newSlug,
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Empresa Renombrada TEN-11');
    expect(res.body.slug).toBe(newSlug);

    // Slug ya en uso por una empresa dada de baja.
    const bajaSlug = uniqueSlug('ten11-baja');
    await createTenant(t.prisma, { slug: bajaSlug, deletedAt: new Date() });

    const resChoque = await withAuth(http(t).patch(`/tenants/${tenant.id}`), token, systemTenant.id).send({
      name: 'Empresa Renombrada TEN-11 v2',
      slug: bajaSlug,
    });
    expect(resChoque.status).toBe(409);
  });
});
