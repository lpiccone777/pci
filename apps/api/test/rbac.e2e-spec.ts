/**
 * 1.2 RBAC dinámico — roles y permisos (BE-RBAC-*)
 *
 * Vía: endpoints REST reales (`/roles/*`, `/auth/me`) con supertest, sobre la base efímera.
 * No hay frontera externa que mockear: `RolesGuard`, `RoleService` y `PermissionService` son
 * lógica pura de la app con acceso a Prisma, y se ejercitan tal cual corren en producción.
 *
 * BE-RBAC-04 es la única excepción: la cadena real de TODOS los controladores con
 * `RolesGuard` incluye `TenantGuard` antes (`@UseGuards(JwtAuthGuard, TenantGuard,
 * RolesGuard)`), así que no existe un endpoint HTTP real donde `TenantGuard` esté ausente.
 * Se instancia `RolesGuard` desde el `moduleRef` y se lo llama con un `ExecutionContext`
 * armado a mano — mismo criterio que BE-AUTH-21 en `auth.e2e-spec.ts`, que instancia
 * `SmtpEmailService` directo para llegar a un path que ningún endpoint dispara igual.
 *
 * RBAC no tiene casos invertidos en este bloque: los 24 casos son comportamiento real, sin
 * `it.failing`.
 */
import { ExecutionContext } from '@nestjs/common';
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
  uniqueSlug,
  DEFAULT_PASSWORD,
} from './support';
import { RolesGuard } from '../src/modules/rbac/guards/roles.guard';
import { AreasController } from '../src/modules/areas/areas.controller';

describe('1.2 RBAC dinámico (BE-RBAC-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  /** Tenant + rol con los permisos dados + un usuario con ese vínculo. Atajo repetido en casi
   *  todo el bloque: la mayoría de los casos solo necesitan "alguien con/sin tal permiso". */
  async function scenario(permissions: string[], roleName = 'Rol de prueba') {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('rbac') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: roleName, permissions });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('rbac'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, user);
    return { tenant, role, user, token };
  }

  it('BE-RBAC-01: acceder a un endpoint con el permiso requerido devuelve 200', async () => {
    const { tenant, token } = await scenario(['areas:read']);

    const res = await withAuth(http(t).get('/areas'), token, tenant.id);

    expect(res.status).toBe(200);
  });

  it('BE-RBAC-02: acceder sin el permiso requerido devuelve 403 "Permiso denegado: recurso:acción"', async () => {
    const { tenant, token } = await scenario([]); // sin permisos

    const res = await withAuth(http(t).get('/areas'), token, tenant.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Permiso denegado: areas:read');
  });

  it('BE-RBAC-03: el SuperAdmin del tenant de sistema pasa sin mirar la lista de permisos guardada', async () => {
    const { admin, tenant } = await getSystemContext(t.prisma);
    const membership = await t.prisma.userTenant.findFirstOrThrow({
      where: { userId: admin.id, tenantId: tenant.id },
    });
    const stored = await t.prisma.rolePermission.findFirst({
      where: { roleId: membership.roleId, resource: 'areas', action: 'read' },
    });
    expect(stored).not.toBeNull(); // el seed le dio el catálogo completo (60 permisos)
    await t.prisma.rolePermission.delete({ where: { id: stored!.id } });

    try {
      const token = tokenFor(t, admin);
      const res = await withAuth(http(t).get('/areas'), token, tenant.id);

      // `RolesGuard` evalúa `isProtectedRole` ANTES de mirar `role.permissions`: el
      // SuperAdmin de sistema entra aunque la fila puntual no exista en la base.
      expect(res.status).toBe(200);
    } finally {
      // Restaurar: no dejar el rol de sistema con un permiso de menos para el resto de la
      // corrida (otros specs comparten esta misma base efímera).
      await t.prisma.rolePermission.create({
        data: { roleId: membership.roleId, resource: 'areas', action: 'read' },
      });
    }
  });

  it('BE-RBAC-04: sin TenantGuard en la cadena, RolesGuard corta con 403 "Tenant no resuelto"', async () => {
    const rolesGuard = t.moduleRef.get(RolesGuard, { strict: false });
    // Simula lo que ve RolesGuard si TenantGuard no corrió antes: hay `user` (JwtAuthGuard sí
    // corrió) pero no `tenantId` ni `userTenant`.
    const fakeRequest: any = { user: { userId: 'x' } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => fakeRequest }),
      getHandler: () => AreasController.prototype.findAll, // trae la metadata @RequirePermission('areas','read')
      getClass: () => AreasController,
    } as unknown as ExecutionContext;

    await expect(rolesGuard.canActivate(ctx)).rejects.toThrow(
      'Tenant no resuelto: falta TenantGuard en el controlador',
    );
  });

  it('BE-RBAC-05: crear un rol y asignarle un permiso del catálogo surte efecto en la siguiente request sin reiniciar', async () => {
    const { tenant, token } = await scenario(['roles:create', 'permissions:create']);

    const createRes = await withAuth(
      http(t).post('/roles').send({ name: 'Recién creado' }),
      token,
      tenant.id,
    );
    expect(createRes.status).toBe(201);
    const newRoleId = createRes.body.id;

    const addPermRes = await withAuth(
      http(t).post(`/roles/${newRoleId}/permissions`).send({ resource: 'areas', action: 'read' }),
      token,
      tenant.id,
    );
    expect(addPermRes.status).toBe(201);

    const newUser = await createUser(t.prisma, {
      email: uniqueEmail('rbac05'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: tenant.id, roleId: newRoleId }],
    });
    const newToken = tokenFor(t, newUser);

    const res = await withAuth(http(t).get('/areas'), newToken, tenant.id);
    expect(res.status).toBe(200); // el permiso agregado recién ya surte efecto
  });

  it('BE-RBAC-06: asignar a un rol un permiso fuera del catálogo devuelve 400', async () => {
    const { tenant, role, token } = await scenario(['permissions:create']);

    const res = await withAuth(
      http(t).post(`/roles/${role.id}/permissions`).send({ resource: 'bogus', action: 'read' }),
      token,
      tenant.id,
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Permiso desconocido: bogus:read');
  });

  it('BE-RBAC-07: PUT /roles/:id/permissions reemplaza en bloque y solo toca permisos del catálogo', async () => {
    const { tenant, role, token } = await scenario(['permissions:update']);
    // Fuera de catálogo, cargado directo (simula una fila vieja que la pantalla no controla).
    await t.prisma.rolePermission.create({ data: { roleId: role.id, resource: 'custom', action: 'foo' } });
    await t.prisma.rolePermission.create({ data: { roleId: role.id, resource: 'areas', action: 'read' } });

    const res = await withAuth(
      http(t)
        .put(`/roles/${role.id}/permissions`)
        .send({ permissions: [{ resource: 'users', action: 'read' }] }),
      token,
      tenant.id,
    );
    expect(res.status).toBe(200);

    const stored = await t.prisma.rolePermission.findMany({ where: { roleId: role.id } });
    const pairs = stored.map((p) => `${p.resource}:${p.action}`);
    expect(pairs).toContain('users:read'); // se creó
    expect(pairs).not.toContain('areas:read'); // se quitó: no estaba en el conjunto nuevo
    expect(pairs).toContain('custom:foo'); // fuera de catálogo: el reemplazo no lo toca
  });

  it('BE-RBAC-08: modificar los permisos del rol protegido (SuperAdmin de sistema) se rechaza', async () => {
    const { admin, tenant } = await getSystemContext(t.prisma);
    const membership = await t.prisma.userTenant.findFirstOrThrow({
      where: { userId: admin.id, tenantId: tenant.id },
    });
    const token = tokenFor(t, admin);

    const res = await withAuth(
      http(t)
        .put(`/roles/${membership.roleId}/permissions`)
        .send({ permissions: [{ resource: 'areas', action: 'read' }] }),
      token,
      tenant.id,
    );

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('es el rol de superusuario del sistema');
  });

  it('BE-RBAC-09: cambiar los permisos de un rol se refleja en la siguiente /auth/me (sin caché)', async () => {
    const { tenant, role, token } = await scenario(['areas:read']);

    const before = await withAuth(http(t).get('/auth/me'), token);
    const beforeMembership = before.body.tenants.find((m: any) => m.tenant.id === tenant.id);
    expect(beforeMembership.role.permissions).toEqual([
      expect.objectContaining({ resource: 'areas', action: 'read' }),
    ]);

    await t.prisma.rolePermission.deleteMany({
      where: { roleId: role.id, resource: 'areas', action: 'read' },
    });

    const after = await withAuth(http(t).get('/auth/me'), token);
    const afterMembership = after.body.tenants.find((m: any) => m.tenant.id === tenant.id);
    expect(afterMembership.role.permissions).toEqual([]); // se lee de BD en cada request
  });

  it('BE-RBAC-10: GET /roles/all y /roles/by-tenant/:id desde un tenant que no es el de sistema devuelven 403', async () => {
    const { tenant, token } = await scenario(['roles:read']);
    const other = await createTenant(t.prisma, { slug: uniqueSlug('rbac10-other') });

    const all = await withAuth(http(t).get('/roles/all'), token, tenant.id);
    expect(all.status).toBe(403);

    const byTenant = await withAuth(http(t).get(`/roles/by-tenant/${other.id}`), token, tenant.id);
    expect(byTenant.status).toBe(403);
  });

  it.skip(
    'BE-RBAC-11: el menú y los botones del frontend se arman según los permisos de /auth/me ' +
      '[BLOQUEADO: renderizado de Next.js — no verificable con supertest contra la API; cubierto en la Sección 3 del plan]',
    () => {},
  );

  it('BE-RBAC-12: GET /roles parado en un tenant devuelve userCount, permissionCount e isProtected', async () => {
    const { tenant, role, token } = await scenario(['roles:read']);

    const res = await withAuth(http(t).get('/roles'), token, tenant.id);

    expect(res.status).toBe(200);
    const found = res.body.find((r: any) => r.id === role.id);
    expect(found).toBeDefined();
    expect(found.userCount).toBe(1); // el usuario de la fixture
    expect(found.permissionCount).toBe(1); // 'roles:read'
    expect(found.isProtected).toBe(false);
  });

  it('BE-RBAC-13: GET /roles/:id del propio tenant devuelve 200; de otro tenant, 404 "Rol no encontrado"', async () => {
    const { tenant, role, token } = await scenario(['roles:read']);
    const other = await createTenant(t.prisma, { slug: uniqueSlug('rbac13-other') });
    const otherRole = await createRole(t.prisma, { tenantId: other.id, name: 'Rol ajeno' });

    const own = await withAuth(http(t).get(`/roles/${role.id}`), token, tenant.id);
    expect(own.status).toBe(200);

    const foreign = await withAuth(http(t).get(`/roles/${otherRole.id}`), token, tenant.id);
    expect(foreign.status).toBe(404);
    expect(foreign.body.message).toBe('Rol no encontrado');
  });

  it('BE-RBAC-14: GET /roles/:id/users lista a quienes tienen ese rol', async () => {
    const { tenant, role, user, token } = await scenario(['roles:read']);

    const res = await withAuth(http(t).get(`/roles/${role.id}/users`), token, tenant.id);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].email).toBe(user.email);
  });

  it('BE-RBAC-15: desde el tenant de sistema, /roles/all trae todas las empresas (sin las de baja) y /roles/by-tenant/:id solo la del path', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('rbac15-a') });
    const roleA = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Rol A' });
    const deletedTenant = await createTenant(t.prisma, {
      slug: uniqueSlug('rbac15-baja'),
      deletedAt: new Date(),
    });
    const roleDeleted = await createRole(t.prisma, { tenantId: deletedTenant.id, name: 'Rol de baja' });

    const all = await withAuth(http(t).get('/roles/all'), token, systemTenant.id);
    expect(all.status).toBe(200);
    const allIds = all.body.map((r: any) => r.id);
    expect(allIds).toContain(roleA.id);
    expect(allIds).not.toContain(roleDeleted.id); // empresa dada de baja: excluida

    const byTenant = await withAuth(http(t).get(`/roles/by-tenant/${tenantA.id}`), token, systemTenant.id);
    expect(byTenant.status).toBe(200);
    expect(byTenant.body.map((r: any) => r.id)).toEqual([roleA.id]);
  });

  it('BE-RBAC-16: GET /roles/mine trae los roles de las empresas donde el usuario tiene roles:read; [] si no tiene ninguna', async () => {
    const tenantA = await createTenant(t.prisma, { slug: uniqueSlug('rbac16-a') });
    const roleWithRead = await createRole(t.prisma, {
      tenantId: tenantA.id,
      name: 'Con lectura',
      permissions: ['roles:read'],
    });
    const tenantB = await createTenant(t.prisma, { slug: uniqueSlug('rbac16-b') });
    const roleWithoutRead = await createRole(t.prisma, {
      tenantId: tenantB.id,
      name: 'Sin lectura',
      permissions: ['areas:read'],
    });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('rbac16'),
      password: DEFAULT_PASSWORD,
      memberships: [
        { tenantId: tenantA.id, roleId: roleWithRead.id },
        { tenantId: tenantB.id, roleId: roleWithoutRead.id },
      ],
    });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/roles/mine'), token, tenantA.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(roleWithRead.id);
    expect(ids).not.toContain(roleWithoutRead.id); // esa empresa no tiene roles:read

    const noneUser = await createUser(t.prisma, {
      email: uniqueEmail('rbac16b'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: tenantB.id, roleId: roleWithoutRead.id }],
    });
    const noneToken = tokenFor(t, noneUser);
    const noneRes = await withAuth(http(t).get('/roles/mine'), noneToken, tenantB.id);
    expect(noneRes.status).toBe(200);
    expect(noneRes.body).toEqual([]);
  });

  it('BE-RBAC-17: GET /roles/catalog devuelve 15 recursos x 4 acciones (60), con "skills" como 15º recurso', async () => {
    const { tenant, token } = await scenario(['roles:read']);

    const res = await withAuth(http(t).get('/roles/catalog'), token, tenant.id);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(60);
    expect(res.body.resources).toHaveLength(15);
    expect(res.body.resources[14].key).toBe('skills');
    expect(res.body.actions).toHaveLength(4);
  });

  it('BE-RBAC-18: PATCH /roles/:id renombra un rol común; el nombre repetido en la empresa da 409', async () => {
    const { tenant, role, token } = await scenario(['roles:update']);
    await createRole(t.prisma, { tenantId: tenant.id, name: 'Ya existe' });

    const renamed = await withAuth(
      http(t).patch(`/roles/${role.id}`).send({ name: 'Nuevo nombre' }),
      token,
      tenant.id,
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Nuevo nombre');

    const conflict = await withAuth(
      http(t).patch(`/roles/${role.id}`).send({ name: 'Ya existe' }),
      token,
      tenant.id,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.message).toBe('Ya existe un rol llamado Ya existe en esta empresa.');
  });

  it('BE-RBAC-19: PATCH /roles/:id sobre el rol protegido (SuperAdmin de sistema) devuelve 409', async () => {
    const { admin, tenant } = await getSystemContext(t.prisma);
    const membership = await t.prisma.userTenant.findFirstOrThrow({
      where: { userId: admin.id, tenantId: tenant.id },
    });
    const token = tokenFor(t, admin);

    const res = await withAuth(
      http(t).patch(`/roles/${membership.roleId}`).send({ name: 'Otro nombre' }),
      token,
      tenant.id,
    );

    expect(res.status).toBe(409);
  });

  it('BE-RBAC-20: DELETE /roles/:id sin usuarios asignados lo elimina', async () => {
    const { tenant, token } = await scenario(['roles:delete']);
    const toDelete = await createRole(t.prisma, { tenantId: tenant.id, name: 'Para borrar' });

    const res = await withAuth(http(t).delete(`/roles/${toDelete.id}`), token, tenant.id);
    expect(res.status).toBe(200);

    const stillThere = await t.prisma.role.findUnique({ where: { id: toDelete.id } });
    expect(stillThere).toBeNull();
  });

  it('BE-RBAC-21: DELETE /roles/:id con usuarios asignados devuelve 409', async () => {
    const { tenant, role, token } = await scenario(['roles:delete']);
    // `role` ya tiene un usuario asignado: el propio de la fixture.

    const res = await withAuth(http(t).delete(`/roles/${role.id}`), token, tenant.id);

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('usuario lo tiene asignado');
  });

  it('BE-RBAC-22: DELETE /roles/:id del rol protegido (SuperAdmin de sistema) devuelve 409', async () => {
    const { admin, tenant } = await getSystemContext(t.prisma);
    const membership = await t.prisma.userTenant.findFirstOrThrow({
      where: { userId: admin.id, tenantId: tenant.id },
    });
    const token = tokenFor(t, admin);

    const res = await withAuth(http(t).delete(`/roles/${membership.roleId}`), token, tenant.id);

    expect(res.status).toBe(409);
  });

  it('BE-RBAC-23: DELETE /roles/permissions/:id quita esa fila y se refleja sin reiniciar', async () => {
    const { tenant, role, token } = await scenario(['permissions:delete', 'areas:read']);
    const permRow = await t.prisma.rolePermission.findFirstOrThrow({
      where: { roleId: role.id, resource: 'areas', action: 'read' },
    });

    const del = await withAuth(http(t).delete(`/roles/permissions/${permRow.id}`), token, tenant.id);
    expect(del.status).toBe(200);

    // Otro usuario con el mismo rol, para no depender de un token viejo con caché de ningún tipo.
    const user2 = await createUser(t.prisma, {
      email: uniqueEmail('rbac23'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token2 = tokenFor(t, user2);

    const res = await withAuth(http(t).get('/areas'), token2, tenant.id);
    expect(res.status).toBe(403); // ya no tiene areas:read
  });

  it('BE-RBAC-24: GET /roles/:roleId/permissions lista los pares resource/action del rol', async () => {
    const { tenant, role, token } = await scenario(['permissions:read', 'areas:read']);

    const res = await withAuth(http(t).get(`/roles/${role.id}/permissions`), token, tenant.id);

    expect(res.status).toBe(200);
    const pairs = res.body.map((p: any) => `${p.resource}:${p.action}`).sort();
    expect(pairs).toEqual(['areas:read', 'permissions:read']);
  });
});
