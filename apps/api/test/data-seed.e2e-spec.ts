/**
 * 1.15 Datos, seed y migraciones (BE-DAT-*)
 *
 * Vía: la base efímera que arma `global-setup.ts` (migrate deploy + seed) antes de correr
 * cualquier spec, más `prisma/seed.ts` re-ejecutado a mano desde estos tests (mismo mecanismo
 * que `global-setup.ts`, `execSync('npx prisma db seed', ...)`) y Prisma directo para las
 * comprobaciones de baja lógica / borrado físico.
 *
 * Nada se mockea: son consultas reales contra la base de test y, en BE-DAT-02/03, una corrida
 * real del script de seed.
 *
 * ## Por qué el `beforeAll` vuelve a correr el seed (leer antes de tocar)
 *
 * `Setting.key` es único GLOBAL y varios specs (`settings.e2e-spec.ts`) crean y BORRAN en su
 * propio `afterEach` las dos keys que siembra el seed (`OTP_TTL_SECONDS`,
 * `DEVICE_FINGERPRINT_TTL_DAYS`). Como todos los specs comparten la misma base y corren
 * serialmente (`maxWorkers: 1`) pero SIN un orden garantizado entre archivos, para cuando este
 * spec corre esas filas pueden no estar (las borró un `afterEach` ajeno). Volver a correr el
 * seed acá (idempotente, `update: {}`) deja un punto de partida determinístico para BE-DAT-01/02
 * sin depender de qué archivo corrió antes. Tenant/rol/admin nunca los toca ni borra ningún otro
 * spec, así que esos sí son estables de por sí.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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
  createFlow,
  setSetting,
  uniqueEmail,
  uniquePhone,
  uniqueSlug,
} from './support';
import { PERMISSION_TOTAL } from '../src/modules/rbac/permissions.catalog';

const API_DIR = path.resolve(__dirname, '..');

/** Corre el seed real contra la base de test (misma DATABASE_URL que ya usa este proceso). */
function runSeed(): void {
  execSync('npx prisma db seed', { cwd: API_DIR, env: process.env, stdio: 'pipe' });
}

describe('1.15 Datos, seed y migraciones (BE-DAT-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    runSeed();
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  it('BE-DAT-01: las migraciones quedaron todas aplicadas, sin error ni rollback', async () => {
    const migrationsDir = path.join(API_DIR, 'prisma', 'migrations');
    const expectedCount = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length;

    const rows = await t.prisma.$queryRawUnsafe<
      { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
    >('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"');

    expect(rows).toHaveLength(expectedCount);
    expect(rows.every((r) => r.finished_at !== null)).toBe(true);
    expect(rows.every((r) => r.rolled_back_at === null)).toBe(true);
  });

  it('BE-DAT-02: el seed deja el tenant de sistema, SuperAdmin con el catálogo completo, admin@pci.local y los settings base', async () => {
    const systemSlug = process.env.SYSTEM_TENANT_SLUG || 'system';

    const tenant = await t.prisma.tenant.findUniqueOrThrow({ where: { slug: systemSlug } });
    expect(tenant.deletedAt).toBeNull();

    const role = await t.prisma.role.findUniqueOrThrow({
      where: { name_tenantId: { name: 'SuperAdmin', tenantId: tenant.id } },
    });
    const permCount = await t.prisma.rolePermission.count({ where: { roleId: role.id } });
    // 15 recursos × 4 acciones (ver permissions.catalog.ts) — el seed carga las filas como piso,
    // aunque el SuperAdmin no dependa de ellas en runtime (effectivePermissions le da el catálogo
    // completo igual, ver protected-role.ts).
    expect(permCount).toBe(PERMISSION_TOTAL);

    const admin = await t.prisma.user.findUniqueOrThrow({ where: { email: 'admin@pci.local' } });
    expect(admin.deletedAt).toBeNull();
    expect(admin.passwordHash.startsWith('$2')).toBe(true); // bcrypt, no texto plano

    const membership = await t.prisma.userTenant.findUniqueOrThrow({
      where: { userId_tenantId: { userId: admin.id, tenantId: tenant.id } },
    });
    expect(membership.roleId).toBe(role.id);

    const otpTtl = await t.prisma.setting.findUniqueOrThrow({ where: { key: 'OTP_TTL_SECONDS' } });
    expect(otpTtl.value).toBe('300');
    const fingerprintTtl = await t.prisma.setting.findUniqueOrThrow({
      where: { key: 'DEVICE_FINGERPRINT_TTL_DAYS' },
    });
    expect(fingerprintTtl.value).toBe('90');
  });

  it(
    'BE-DAT-03: correr el seed dos veces seguidas es idempotente — no duplica filas ni pisa un cambio hecho a mano',
    async () => {
      const systemSlug = process.env.SYSTEM_TENANT_SLUG || 'system';
      const tenantBefore = await t.prisma.tenant.count({ where: { slug: systemSlug } });
      const roleBefore = await t.prisma.role.count({ where: { name: 'SuperAdmin' } });
      const permBefore = await t.prisma.rolePermission.count();
      const adminBefore = await t.prisma.user.count({ where: { email: 'admin@pci.local' } });

      // Modificamos a mano un registro que el seed toca: si el upsert pisara los cambios manuales
      // (`update: {...}` con datos fijos en vez de `update: {}`), la segunda corrida lo resetearía.
      await setSetting(t.prisma, 'OTP_TTL_SECONDS', '999');

      runSeed();

      const tenantAfter = await t.prisma.tenant.count({ where: { slug: systemSlug } });
      const roleAfter = await t.prisma.role.count({ where: { name: 'SuperAdmin' } });
      const permAfter = await t.prisma.rolePermission.count();
      const adminAfter = await t.prisma.user.count({ where: { email: 'admin@pci.local' } });
      expect(tenantAfter).toBe(tenantBefore); // no duplicó el tenant de sistema
      expect(roleAfter).toBe(roleBefore); // no duplicó el rol SuperAdmin
      expect(permAfter).toBe(permBefore); // no duplicó RolePermission (upsert por (roleId,resource,action))
      expect(adminAfter).toBe(adminBefore); // no duplicó el usuario admin

      const otpTtl = await t.prisma.setting.findUniqueOrThrow({ where: { key: 'OTP_TTL_SECONDS' } });
      expect(otpTtl.value).toBe('999'); // el cambio manual sobrevivió: el upsert usa `update: {}`
    },
    60_000,
  );

  it('BE-DAT-04: dar de baja una empresa es baja lógica — sus filas siguen existiendo pero el acceso a través de ella se corta', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('dat04') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Rol DAT04',
      permissions: ['areas:read'],
    });
    const area = await createArea(t.prisma, { tenantId: tenant.id, name: 'Área DAT04' });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('dat04'),
      phone: uniquePhone(),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, user);

    // Antes de la baja: acceso normal.
    const antes = await withAuth(http(t).get('/areas'), token, tenant.id);
    expect(antes.status).toBe(200);

    await t.prisma.tenant.update({ where: { id: tenant.id }, data: { deletedAt: new Date() } });

    // TenantGuard filtra las membresías contra `tenant: { deletedAt: null }` (ver
    // src/common/guards/tenant.guard.ts): sin ninguna membresía "viva" el usuario queda sin
    // tenant activo y el guard corta ANTES de llegar a ningún controlador — "deja de aparecer en
    // las vistas" se traduce, a nivel API, en este 403.
    const despues = await withAuth(http(t).get('/areas'), token, tenant.id);
    expect(despues.status).toBe(403);
    expect(despues.body.message).toBe('El usuario no pertenece a ningún tenant');

    // Las filas siguen existiendo: es baja lógica, nunca borrado físico.
    const freshTenant = await t.prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(freshTenant.deletedAt).not.toBeNull();
    const freshRole = await t.prisma.role.findUniqueOrThrow({ where: { id: role.id } });
    expect(freshRole).not.toBeNull();
    const freshArea = await t.prisma.area.findUniqueOrThrow({ where: { id: area.id } });
    expect(freshArea).not.toBeNull();
    // El USUARIO no se da de baja junto con la empresa: sigue activo, solo pierde el acceso a
    // ESTA empresa (podría tener membresías en otras que sigan vivas).
    const freshUser = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(freshUser.deletedAt).toBeNull();
  });

  it('BE-DAT-05a: borrar un flujo por Prisma limpia en cascada sus TenantFlow y TenantFlowRole (borrado físico, sin huérfanos)', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('dat05-flow') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol DAT05' });
    const flow = await createFlow(t.prisma, {
      name: `Flujo a borrar ${uniqueSlug()}`,
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });
    const tenantFlow = await t.prisma.tenantFlow.findFirstOrThrow({ where: { flowId: flow.id } });
    const tenantFlowRoles = await t.prisma.tenantFlowRole.findMany({
      where: { tenantFlowId: tenantFlow.id },
    });
    expect(tenantFlowRoles.length).toBeGreaterThan(0); // el escenario tiene algo que podría quedar huérfano

    await t.prisma.flow.delete({ where: { id: flow.id } });

    const orphanFlow = await t.prisma.flow.findUnique({ where: { id: flow.id } });
    const orphanTenantFlow = await t.prisma.tenantFlow.findMany({ where: { flowId: flow.id } });
    const orphanTenantFlowRoles = await t.prisma.tenantFlowRole.findMany({
      where: { id: { in: tenantFlowRoles.map((r) => r.id) } },
    });
    expect(orphanFlow).toBeNull(); // borrado físico
    expect(orphanTenantFlow).toHaveLength(0); // cascada: sin TenantFlow huérfano
    expect(orphanTenantFlowRoles).toHaveLength(0); // cascada: sin TenantFlowRole huérfano
  });

  it('BE-DAT-05b: un área sin dependientes se borra físico; con usuarios asignados, la FK Restrict de la base lo impide (defensa en profundidad, aunque se salte AreasService)', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('dat05-area') });

    const areaVacia = await createArea(t.prisma, { tenantId: tenant.id, name: 'Vacía DAT05' });
    await t.prisma.area.delete({ where: { id: areaVacia.id } });
    expect(await t.prisma.area.findUnique({ where: { id: areaVacia.id } })).toBeNull();

    const areaConGente = await createArea(t.prisma, { tenantId: tenant.id, name: 'Con Gente DAT05' });
    const rol2 = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol2 DAT05' });
    await createUser(t.prisma, {
      email: uniqueEmail('dat05-area'),
      phone: uniquePhone(),
      memberships: [{ tenantId: tenant.id, roleId: rol2.id, areaId: areaConGente.id }],
    });

    // `UserTenant.area` está declarado `onDelete: Restrict` en el schema (ver prisma/schema.prisma):
    // aunque este test salte por completo a AreasService (que ya valida esto con un 409, ver
    // BE-ARE-21), la propia base rechaza el borrado. Ningún UserTenant queda apuntando a un
    // areaId inexistente.
    await expect(t.prisma.area.delete({ where: { id: areaConGente.id } })).rejects.toThrow();
    const fresh = await t.prisma.area.findUnique({ where: { id: areaConGente.id } });
    expect(fresh).not.toBeNull();
  });

  it('BE-DAT-06: la migración de backfill rellena TenantFlowRole en los flujos de inicio sin roles (un rol por cada Role del mismo tenant, sin cruzar tenants) y es idempotente', async () => {
    // Escenario que la migración de backfill busca: un TenantFlow con isStart=true y CERO roles
    // (el estado en que quedaron todos al crearse la tabla TenantFlowRole). La migración ya corrió
    // sobre la base efímera, así que montamos el caso a mano y reejecutamos su MISMO SQL, leído
    // del propio archivo de migración (no una copia), para verificar su efecto y su idempotencia.
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('dat06') });
    const rolA = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol A DAT06' });
    const rolB = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol B DAT06' });

    // Rol de OTRA empresa: la migración NO debe cruzarlo (el JOIN es `r."tenantId" = tf."tenantId"`).
    const otroTenant = await createTenant(t.prisma, { slug: uniqueSlug('dat06-otro') });
    const rolAjeno = await createRole(t.prisma, { tenantId: otroTenant.id, name: 'Rol ajeno DAT06' });

    // Flujo de inicio SIN roles: el que hay que rellenar.
    const flowSinRoles = await createFlow(t.prisma, {
      name: `Inicio sin roles ${uniqueSlug()}`,
      assign: [{ tenantId: tenant.id, isStart: true }], // isStart=true, roleIds vacío
    });
    const tfSinRoles = await t.prisma.tenantFlow.findFirstOrThrow({ where: { flowId: flowSinRoles.id } });
    expect(await t.prisma.tenantFlowRole.count({ where: { tenantFlowId: tfSinRoles.id } })).toBe(0);

    // Flujo de inicio que YA tiene un rol: la migración no debe tocarlo (cláusula `NOT EXISTS`).
    const flowConRol = await createFlow(t.prisma, {
      name: `Inicio con rol ${uniqueSlug()}`,
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [rolA.id] }],
    });
    const tfConRol = await t.prisma.tenantFlow.findFirstOrThrow({ where: { flowId: flowConRol.id } });

    // SQL REAL de la migración de backfill (INSERT ... SELECT ... ON CONFLICT DO NOTHING).
    const backfillSql = fs.readFileSync(
      path.join(
        API_DIR,
        'prisma',
        'migrations',
        '20260824120000_backfill_tenant_flow_role_for_existing_start_flows',
        'migration.sql',
      ),
      'utf8',
    );
    await t.prisma.$executeRawUnsafe(backfillSql);

    // El flujo sin roles quedó con UNA fila por cada Role del MISMO tenant (rolA y rolB) y ninguna
    // del rol ajeno: el JOIN por tenantId no cruza empresas.
    const rolesRellenados = await t.prisma.tenantFlowRole.findMany({ where: { tenantFlowId: tfSinRoles.id } });
    expect(rolesRellenados.map((r) => r.roleId).sort()).toEqual([rolA.id, rolB.id].sort());
    expect(rolesRellenados.map((r) => r.roleId)).not.toContain(rolAjeno.id);

    // El que ya tenía rolA sigue con exactamente ese rol: no se lo tocó.
    const rolesDelConRol = await t.prisma.tenantFlowRole.findMany({ where: { tenantFlowId: tfConRol.id } });
    expect(rolesDelConRol.map((r) => r.roleId)).toEqual([rolA.id]);

    // Idempotente: reejecutar el mismo SQL no duplica (ON CONFLICT (tenantFlowId, roleId) DO NOTHING).
    await t.prisma.$executeRawUnsafe(backfillSql);
    const trasSegunda = await t.prisma.tenantFlowRole.findMany({ where: { tenantFlowId: tfSinRoles.id } });
    expect(trasSegunda.map((r) => r.roleId).sort()).toEqual([rolA.id, rolB.id].sort());
  });
});
