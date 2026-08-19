/**
 * 1.6 Áreas — CRUD por empresa y aislamiento (BE-ARE-*)
 *
 * Vía: endpoints REST reales (`/areas/*`) con supertest, sobre la base efímera.
 * Sin frontera externa que mockear: guard + service + Prisma real.
 *
 * Nota de guards: el controlador es `@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)` a nivel
 * clase, y algunas rutas (`/areas/all`, `/areas/by-tenant/:id`) suman `SystemTenantGuard` a nivel
 * método. Por orden de ejecución de Nest, `RolesGuard` corre ANTES que `SystemTenantGuard`; para
 * aislar el candado de `SystemTenantGuard` (BE-ARE-04, BE-ARE-08) el usuario de prueba SÍ tiene
 * `areas:read` pero está parado en una empresa común, así el primer candado no interfiere.
 *
 * `/areas/mine` NO lleva `SystemTenantGuard` ni `@RequirePermission` (autorización por-empresa
 * adentro del servicio), pero SIGUE bajo `TenantGuard` a nivel clase: con más de una membresía,
 * `TenantGuard` exige igual un `X-Tenant-Id` válido para resolver *algún* tenant activo, aunque
 * `AreasService.findMine` no lo use (ignora `tenantId`, arma la lista desde `req.user.userId`).
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
  uniquePhone,
  uniqueSlug,
} from './support';

describe('1.6 Áreas (BE-ARE-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  /** Empresa + rol con los permisos pedidos + usuario con esa única membresía. */
  async function scenario(label: string, perms: string[] = ['areas:read']) {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug(label) });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: `Rol ${label}`,
      permissions: perms,
    });
    const user = await createUser(t.prisma, {
      email: uniqueEmail(label),
      phone: uniquePhone(),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    return { tenant, role, user, token: tokenFor(t, user) };
  }

  it('BE-ARE-01: GET /areas parado en un tenant devuelve sólo las áreas de ese tenant, con userCount', async () => {
    const { tenant, token } = await scenario('are01');
    const otroTenant = await createTenant(t.prisma, { slug: uniqueSlug('are01-otro') });
    const conUsuarios = await createArea(t.prisma, { tenantId: tenant.id, name: 'Con Usuarios' });
    const sinUsuarios = await createArea(t.prisma, { tenantId: tenant.id, name: 'Sin Usuarios' });
    await createArea(t.prisma, { tenantId: otroTenant.id, name: 'De Otra Empresa' });
    const rol2 = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol2 ARE01' });
    await createUser(t.prisma, {
      email: uniqueEmail('are01-miembro'),
      phone: uniquePhone(),
      memberships: [{ tenantId: tenant.id, roleId: rol2.id, areaId: conUsuarios.id }],
    });

    const res = await withAuth(http(t).get('/areas'), token, tenant.id);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((a: any) => a.tenantId === tenant.id)).toBe(true);
    const con = res.body.find((a: any) => a.id === conUsuarios.id);
    const sin = res.body.find((a: any) => a.id === sinUsuarios.id);
    expect(con.userCount).toBe(1);
    expect(sin.userCount).toBe(0);
  });

  it('BE-ARE-02: GET /areas sin el permiso areas:read devuelve 403 "Permiso denegado: areas:read"', async () => {
    const { tenant, token } = await scenario('are02', []); // rol sin ningún permiso

    const res = await withAuth(http(t).get('/areas'), token, tenant.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Permiso denegado: areas:read');
  });

  it('BE-ARE-03: GET /areas/all desde el tenant de sistema trae todas las áreas de todas las empresas, y excluye las de empresas dadas de baja', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('are03-a') });
    const tenantBajaEmpresa = await createTenant(t.prisma, {
      slug: uniqueSlug('are03-baja'),
      deletedAt: new Date(),
    });
    const areaA = await createArea(t.prisma, { tenantId: tenantA.id, name: 'Área A' });
    const areaEnBaja = await createArea(t.prisma, { tenantId: tenantBajaEmpresa.id, name: 'Área Baja' });

    const res = await withAuth(http(t).get('/areas/all'), token, systemTenant.id);

    expect(res.status).toBe(200);
    const ids = res.body.map((a: any) => a.id);
    expect(ids).toContain(areaA.id);
    expect(ids).not.toContain(areaEnBaja.id);
    const row = res.body.find((a: any) => a.id === areaA.id);
    expect(row.tenant.id).toBe(tenantA.id);
  });

  it('BE-ARE-04: GET /areas/all desde un tenant que no es el de sistema devuelve 403', async () => {
    const { tenant, token } = await scenario('are04', ['areas:read']);

    const res = await withAuth(http(t).get('/areas/all'), token, tenant.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Esta operación solo puede realizarse desde el tenant de sistema');
  });

  it('BE-ARE-05: GET /areas/mine de un usuario con areas:read en varias empresas devuelve las áreas de todas ellas', async () => {
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('are05-a') });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('are05-b') });
    const roleA = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Rol A', permissions: ['areas:read'] });
    const roleB = await createRole(t.prisma, { tenantId: tenantB.id, name: 'Rol B', permissions: ['areas:read'] });
    const areaA = await createArea(t.prisma, { tenantId: tenantA.id, name: 'Área en A' });
    const areaB = await createArea(t.prisma, { tenantId: tenantB.id, name: 'Área en B' });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('are05'),
      phone: uniquePhone(),
      memberships: [
        { tenantId: tenantA.id, roleId: roleA.id },
        { tenantId: tenantB.id, roleId: roleB.id },
      ],
    });
    const token = tokenFor(t, user);

    // TenantGuard exige un X-Tenant-Id válido porque el usuario tiene 2 membresías, aunque
    // AreasService.findMine no lo use para nada: arma la lista a partir del userId.
    const res = await withAuth(http(t).get('/areas/mine'), token, tenantA.id);

    expect(res.status).toBe(200);
    const ids = res.body.map((a: any) => a.id);
    expect(ids).toContain(areaA.id);
    expect(ids).toContain(areaB.id); // incluye la OTRA empresa, no sólo la del header
  });

  it('BE-ARE-06: GET /areas/mine de un usuario sin areas:read en ninguna empresa devuelve [] (no 403)', async () => {
    const { token } = await scenario('are06', ['users:read']); // permiso de otro recurso, no areas

    const res = await withAuth(http(t).get('/areas/mine'), token); // 1 sola membresía: header opcional

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('BE-ARE-07: GET /areas/by-tenant/:tenantId desde el tenant de sistema trae las áreas de la empresa indicada', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('are07') });
    const area = await createArea(t.prisma, { tenantId: tenant.id, name: 'Área ARE-07' });

    const res = await withAuth(
      http(t).get(`/areas/by-tenant/${tenant.id}`),
      token,
      systemTenant.id,
    );

    expect(res.status).toBe(200);
    expect(res.body.map((a: any) => a.id)).toContain(area.id);
  });

  it('BE-ARE-08: GET /areas/by-tenant/:tenantId desde un tenant que no es el de sistema devuelve 403', async () => {
    const { tenant, token } = await scenario('are08', ['areas:read']);
    const otro = await createTenant(t.prisma, { slug: uniqueSlug('are08-otro') });

    const res = await withAuth(http(t).get(`/areas/by-tenant/${otro.id}`), token, tenant.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Esta operación solo puede realizarse desde el tenant de sistema');
  });

  it('BE-ARE-09: GET /areas/:id de un área del tenant activo devuelve 200', async () => {
    const { tenant, token } = await scenario('are09');
    const area = await createArea(t.prisma, { tenantId: tenant.id, name: 'Área ARE-09' });

    const res = await withAuth(http(t).get(`/areas/${area.id}`), token, tenant.id);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(area.id);
  });

  it('BE-ARE-10: GET /areas/:id de un área de otra empresa devuelve 404 "El área no existe en este tenant"', async () => {
    const { tenant, token } = await scenario('are10');
    const otro = await createTenant(t.prisma, { slug: uniqueSlug('are10-otro') });
    const areaAjena = await createArea(t.prisma, { tenantId: otro.id, name: 'Área Ajena' });

    const res = await withAuth(http(t).get(`/areas/${areaAjena.id}`), token, tenant.id);

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('El área no existe en este tenant');
  });

  it('BE-ARE-11: GET /areas/:id/users devuelve los usuarios asignados y pide areas:read, no users:read', async () => {
    const { tenant, token } = await scenario('are11', ['areas:read']); // sin users:read
    const area = await createArea(t.prisma, { tenantId: tenant.id, name: 'Área ARE-11' });
    const rol2 = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol2 ARE11' });
    const miembro = await createUser(t.prisma, {
      email: uniqueEmail('are11-miembro'),
      phone: uniquePhone(),
      firstName: 'Ana',
      lastName: 'Gómez',
      memberships: [{ tenantId: tenant.id, roleId: rol2.id, areaId: area.id }],
    });

    const res = await withAuth(http(t).get(`/areas/${area.id}/users`), token, tenant.id);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: miembro.id, email: miembro.email, firstName: 'Ana', lastName: 'Gómez' });
  });

  it('BE-ARE-12: POST /areas con un nombre nuevo devuelve 201, el nombre se guarda trim()-eado', async () => {
    const { tenant, token } = await scenario('are12', ['areas:create']);

    const res = await withAuth(http(t).post('/areas'), token, tenant.id).send({
      name: '  Soporte con espacios  ',
    });

    // `@Post()` sin `@HttpCode` → 201.
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Soporte con espacios');
    // El tenant sale del header, nunca del body: no hay forma de pasar otro (DTO no lo admite).
    expect(res.body.tenantId).toBe(tenant.id);
  });

  it('BE-ARE-13: POST /areas con un nombre ya usado en la empresa (case-insensitive) devuelve 409', async () => {
    const { tenant, token } = await scenario('are13', ['areas:create']);
    await createArea(t.prisma, { tenantId: tenant.id, name: 'Soporte' });

    const res = await withAuth(http(t).post('/areas'), token, tenant.id).send({ name: 'soporte' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Ya existe un área con ese nombre en este tenant');
  });

  it('BE-ARE-14: POST /areas con el mismo nombre en otra empresa devuelve 201 (único sólo dentro de la empresa)', async () => {
    const { tenant: tenantA, token: tokenA } = await scenario('are14-a', ['areas:create']);
    const { tenant: tenantB, token: tokenB } = await scenario('are14-b', ['areas:create']);
    const nombre = 'Soporte Compartido';
    const resA = await withAuth(http(t).post('/areas'), tokenA, tenantA.id).send({ name: nombre });
    expect(resA.status).toBe(201);

    const resB = await withAuth(http(t).post('/areas'), tokenB, tenantB.id).send({ name: nombre });

    expect(resB.status).toBe(201);
    expect(resB.body.tenantId).toBe(tenantB.id);
  });

  it('BE-ARE-15: POST /areas sin name (o vacío) devuelve 400 "El nombre del área es obligatorio"', async () => {
    const { tenant, token } = await scenario('are15', ['areas:create']);

    const sinName = await withAuth(http(t).post('/areas'), token, tenant.id).send({});
    expect(sinName.status).toBe(400);
    expect(sinName.body.message).toContain('El nombre del área es obligatorio');

    const vacio = await withAuth(http(t).post('/areas'), token, tenant.id).send({ name: '' });
    expect(vacio.status).toBe(400);
    expect(vacio.body.message).toContain('El nombre del área es obligatorio');
  });

  it('BE-ARE-16: POST /areas con name de más de 80 caracteres, o un campo fuera del DTO, devuelve 400', async () => {
    const { tenant, token } = await scenario('are16', ['areas:create']);

    const largo = await withAuth(http(t).post('/areas'), token, tenant.id).send({
      name: 'A'.repeat(81),
    });
    expect(largo.status).toBe(400);

    const campoExtra = await withAuth(http(t).post('/areas'), token, tenant.id).send({
      name: 'Nombre Válido',
      campoQueNoExiste: 'x',
    });
    expect(campoExtra.status).toBe(400); // forbidNonWhitelisted
  });

  it('BE-ARE-17: PATCH /areas/:id cambiando el nombre a uno libre devuelve 200; el chequeo se excluye a sí mismo', async () => {
    const { tenant, token } = await scenario('are17', ['areas:update']);
    const area = await createArea(t.prisma, { tenantId: tenant.id, name: 'Nombre Original' });

    const res = await withAuth(http(t).patch(`/areas/${area.id}`), token, tenant.id).send({
      name: 'Nombre Nuevo',
    });

    // `@Patch()` sin `@HttpCode` → 200.
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Nombre Nuevo');

    // Volver a guardar el MISMO nombre no debe chocar contra sí misma.
    const resMismo = await withAuth(http(t).patch(`/areas/${area.id}`), token, tenant.id).send({
      name: 'Nombre Nuevo',
    });
    expect(resMismo.status).toBe(200);
  });

  it('BE-ARE-18: PATCH /areas/:id a un nombre ya usado por otra área de la empresa devuelve 409', async () => {
    const { tenant, token } = await scenario('are18', ['areas:update']);
    const areaOcupada = await createArea(t.prisma, { tenantId: tenant.id, name: 'Ocupada' });
    const areaAEditar = await createArea(t.prisma, { tenantId: tenant.id, name: 'A Editar' });

    const res = await withAuth(http(t).patch(`/areas/${areaAEditar.id}`), token, tenant.id).send({
      name: 'Ocupada',
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Ya existe un área con ese nombre en este tenant');
    expect(areaOcupada.name).toBe('Ocupada'); // sigue existiendo, no se tocó
  });

  it('BE-ARE-19: PATCH /areas/:id de un área de otra empresa devuelve 404 (valida pertenencia antes de tocar)', async () => {
    const { tenant, token } = await scenario('are19', ['areas:update']);
    const otro = await createTenant(t.prisma, { slug: uniqueSlug('are19-otro') });
    const areaAjena = await createArea(t.prisma, { tenantId: otro.id, name: 'Ajena' });

    const res = await withAuth(http(t).patch(`/areas/${areaAjena.id}`), token, tenant.id).send({
      name: 'Intento De Robo',
    });

    expect(res.status).toBe(404);
    const fresh = await t.prisma.area.findUniqueOrThrow({ where: { id: areaAjena.id } });
    expect(fresh.name).toBe('Ajena'); // no se tocó
  });

  it('BE-ARE-20: DELETE /areas/:id de un área sin usuarios asignados devuelve 200 { deleted:true } y borra físico', async () => {
    const { tenant, token } = await scenario('are20', ['areas:delete']);
    const area = await createArea(t.prisma, { tenantId: tenant.id, name: 'A Borrar' });

    const res = await withAuth(http(t).delete(`/areas/${area.id}`), token, tenant.id);

    // `@Delete()` sin `@HttpCode` → 200.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true });
    const fresh = await t.prisma.area.findUnique({ where: { id: area.id } });
    expect(fresh).toBeNull(); // borrado físico, no baja lógica
  });

  it('BE-ARE-21: DELETE /areas/:id de un área con usuarios asignados devuelve 409 y no borra', async () => {
    const { tenant, token } = await scenario('are21', ['areas:delete']);
    const area = await createArea(t.prisma, { tenantId: tenant.id, name: 'Con Gente' });
    const rol2 = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol2 ARE21' });
    await createUser(t.prisma, {
      email: uniqueEmail('are21-miembro'),
      phone: uniquePhone(),
      memberships: [{ tenantId: tenant.id, roleId: rol2.id, areaId: area.id }],
    });

    const res = await withAuth(http(t).delete(`/areas/${area.id}`), token, tenant.id);

    expect(res.status).toBe(409);
    expect(res.body.message).toBe(
      'El área "Con Gente" tiene 1 usuario asignado. Reasignalos antes de eliminarla.',
    );
    const fresh = await t.prisma.area.findUnique({ where: { id: area.id } });
    expect(fresh).not.toBeNull(); // no se borró
  });

  it('BE-ARE-22: DELETE /areas/:id de un área de otra empresa devuelve 404 (aislamiento)', async () => {
    const { tenant, token } = await scenario('are22', ['areas:delete']);
    const otro = await createTenant(t.prisma, { slug: uniqueSlug('are22-otro') });
    const areaAjena = await createArea(t.prisma, { tenantId: otro.id, name: 'Ajena 22' });

    const res = await withAuth(http(t).delete(`/areas/${areaAjena.id}`), token, tenant.id);

    expect(res.status).toBe(404);
    const fresh = await t.prisma.area.findUnique({ where: { id: areaAjena.id } });
    expect(fresh).not.toBeNull(); // no se borró
  });

  it('BE-ARE-23: crear/editar/borrar parado en la empresa A nunca afecta las áreas de la empresa B', async () => {
    const { tenant: tenantA, token: tokenA } = await scenario('are23-a', [
      'areas:create',
      'areas:update',
      'areas:delete',
    ]);
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('are23-b') });
    const areaB1 = await createArea(t.prisma, { tenantId: tenantB.id, name: 'B Uno' });
    const areaB2 = await createArea(t.prisma, { tenantId: tenantB.id, name: 'B Dos' });

    // Crear en A con el mismo nombre que una de B: no choca (ya cubierto en ARE-14, acá solo
    // para armar el escenario de aislamiento).
    const create = await withAuth(http(t).post('/areas'), tokenA, tenantA.id).send({ name: 'B Uno' });
    expect(create.status).toBe(201);

    // Editar/borrar apuntando a IDs de B mientras se está parado en A: 404, sin efecto.
    const edit = await withAuth(http(t).patch(`/areas/${areaB1.id}`), tokenA, tenantA.id).send({
      name: 'Intento Cambiar B',
    });
    expect(edit.status).toBe(404);
    const del = await withAuth(http(t).delete(`/areas/${areaB2.id}`), tokenA, tenantA.id);
    expect(del.status).toBe(404);

    // B queda intacta.
    const freshB1 = await t.prisma.area.findUniqueOrThrow({ where: { id: areaB1.id } });
    const freshB2 = await t.prisma.area.findUniqueOrThrow({ where: { id: areaB2.id } });
    expect(freshB1.name).toBe('B Uno');
    expect(freshB2.name).toBe('B Dos');
  });
});
