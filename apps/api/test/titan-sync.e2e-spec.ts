/**
 * Módulo titan-sync: importación de usuarios desde TitanHR (BE-TS-*)
 *
 * Vía: endpoints REST reales `/titan-sync/*` con supertest, sobre la base efímera.
 *
 * Frontera mockeada: SOLO el HTTP de TitanHR (`installFetchMock`, base `TITAN_URL`). El
 * servicio, los guards, el cifrado y Prisma corren de verdad. El Titan simulado implementa
 * el contrato relevado en `docs/titanhr-rbac.md`: login → accessToken, `GET /api/users` con
 * roles/persona/empresa, contactos por persona y logout.
 *
 * `TITAN_SYNC_ENABLED` es un setting global: se prende en `beforeAll` y se borra en
 * `afterAll` (BE-TS-01 lo apaga y lo vuelve a prender adentro de su propio try/finally).
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
  setSetting,
  deleteSetting,
  installFetchMock,
} from './support';

const TITAN_URL = 'https://titan-e2e.test';
const IT_EMAIL = 'it.tecnico@titan.test';
const IT_PASSWORD = 'contraseña-del-IT-e2e';
const TITAN_TOKEN = 'titan-access-token-e2e';

let seq = 0;
/** Número nacional único (área 11 + 8 dígitos) y cómo lo devuelve WhatsApp. */
function uniqueTitanPhone() {
  const n = String((Date.now() % 100000000) + seq++)
    .padStart(8, '0')
    .slice(-8);
  return {
    raw: `011 15 ${n.slice(0, 4)}-${n.slice(4)}`,
    whatsapp: `+54911${n}`,
  };
}

interface FakeTitanUser {
  userId: number;
  email: string;
  name: string;
  locked?: boolean;
  personId?: string | null;
  person?: { firstName: string; lastName: string } | null;
  roles: { roleId: number; name: string }[];
  companyId?: string;
  companyName?: string;
  password?: string;
  mfaSecret?: string;
}

/** Titan simulado. `users`/`contacts` son mutables por test. */
function fakeTitan(
  users: FakeTitanUser[],
  contacts: Record<string, unknown[]>,
  opts: { mfa?: boolean } = {},
) {
  return installFetchMock((url, init) => {
    if (!url.startsWith(TITAN_URL)) return { status: 404 };
    const path = url.slice(TITAN_URL.length);
    const auth = (init?.headers as Record<string, string> | undefined)
      ?.Authorization;
    if (path === '/api/auth/login') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.email !== IT_EMAIL || body.password !== IT_PASSWORD) {
        return { status: 401, body: { message: 'Credenciales inválidas' } };
      }
      if (opts.mfa)
        return {
          status: 200,
          body: { requiresMfaVerification: true, mfaTokenId: 'x' },
        };
      return {
        status: 200,
        body: { requiresMfaVerification: false, accessToken: TITAN_TOKEN },
      };
    }
    if (auth !== `Bearer ${TITAN_TOKEN}`)
      return { status: 401, body: { message: 'Token no proporcionado' } };
    if (path === '/api/auth/logout')
      return { status: 200, body: { success: true } };
    if (path === '/api/users') return { status: 200, body: users };
    const m = path.match(/^\/api\/person-contacts\/by-person\/(.+)$/);
    if (m)
      return { status: 200, body: contacts[decodeURIComponent(m[1])] ?? [] };
    return { status: 404, body: { message: 'not found' } };
  });
}

function titanUser(
  userId: number,
  roles: string[],
  extra: Partial<FakeTitanUser> = {},
): FakeTitanUser {
  return {
    userId,
    email: uniqueEmail(),
    name: `Nombre${userId} Apellido${userId}`,
    personId: `person-${userId}-${seq++}`,
    person: { firstName: `Nombre${userId}`, lastName: `Apellido${userId}` },
    roles: roles.map((name, i) => ({ roleId: 20 + i, name })),
    companyId: 'company-1',
    companyName: 'Empresa Titan SA',
    // Lo que Titan expone de más en GET /api/users: nunca debe llegar a PCI.
    password: '$2b$10$hash-que-no-debe-viajar',
    mfaSecret: 'secreto-mfa-que-no-debe-viajar',
    ...extra,
  };
}

const CELULAR = { value: 'Telefono celular', code: 'CEL' };
const FIJO = { value: 'Telefono', code: 'TEL' };

describe('Módulo titan-sync (BE-TS-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await setSetting(t.prisma, 'TITAN_SYNC_ENABLED', 'true');
  });

  afterAll(async () => {
    await deleteSetting(t.prisma, 'TITAN_SYNC_ENABLED');
    await t.close();
  });

  async function scenario(permissions: string[]) {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('titan') });
    const role = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Admin Titan',
      permissions,
    });
    const user = await createUser(t.prisma, {
      email: uniqueEmail(),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const empleado = await createRole(t.prisma, {
      tenantId: tenant.id,
      name: 'Empleado',
      permissions: [],
    });
    return { tenant, role, empleado, token: tokenFor(t, user) };
  }

  const ALL = ['titan-sync:read', 'titan-sync:create', 'titan-sync:update'];

  async function connect(token: string, tenantId: string) {
    const res = await withAuth(
      http(t)
        .put('/titan-sync/connection')
        .send({
          baseUrl: `${TITAN_URL}/api/`,
          itEmail: IT_EMAIL,
          itPassword: IT_PASSWORD,
        }),
      token,
      tenantId,
    );
    expect(res.status).toBe(200);
    return res;
  }

  it('BE-TS-01: con TITAN_SYNC_ENABLED apagado, status dice enabled:false y el resto responde 404', async () => {
    const { tenant, token } = await scenario(ALL);
    await setSetting(t.prisma, 'TITAN_SYNC_ENABLED', 'false');
    try {
      const status = await withAuth(
        http(t).get('/titan-sync/status'),
        token,
        tenant.id,
      );
      expect(status.status).toBe(200);
      expect(status.body).toEqual({ enabled: false, connection: null });

      const put = await withAuth(
        http(t)
          .put('/titan-sync/connection')
          .send({ baseUrl: TITAN_URL, itEmail: IT_EMAIL }),
        token,
        tenant.id,
      );
      expect(put.status).toBe(404);
      expect(
        (await withAuth(http(t).get('/titan-sync/users'), token, tenant.id))
          .status,
      ).toBe(404);
    } finally {
      await setSetting(t.prisma, 'TITAN_SYNC_ENABLED', 'true');
    }
  });

  it('BE-TS-02: sin el permiso titan-sync correspondiente devuelve 403', async () => {
    const { tenant, token } = await scenario(['titan-sync:read']);
    const res = await withAuth(
      http(t)
        .put('/titan-sync/connection')
        .send({ baseUrl: TITAN_URL, itEmail: IT_EMAIL }),
      token,
      tenant.id,
    );
    expect(res.status).toBe(403);
    const imp = await withAuth(
      http(t)
        .post('/titan-sync/import')
        .send({ titanUserIds: [1], roleId: 'x' }),
      token,
      tenant.id,
    );
    expect(imp.status).toBe(403);
  });

  it('BE-TS-03: la contraseña del usuario técnico se guarda cifrada y nunca vuelve por la API; ausente = no tocar, vacía = borrar', async () => {
    const { tenant, token } = await scenario(ALL);
    const saved = await connect(token, tenant.id);
    expect(saved.body).toMatchObject({
      baseUrl: TITAN_URL,
      itEmail: IT_EMAIL,
      itPasswordIsSet: true,
      configured: true,
    });
    expect(JSON.stringify(saved.body)).not.toContain(IT_PASSWORD);

    const row = await t.prisma.titanConnection.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    });
    expect(row.itPassword).toMatch(/^enc:v1:/);
    expect(row.itPassword).not.toContain(IT_PASSWORD);

    const status = await withAuth(
      http(t).get('/titan-sync/status'),
      token,
      tenant.id,
    );
    expect(status.body.connection.itPasswordIsSet).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain(IT_PASSWORD);

    // Sin itPassword: conserva la guardada.
    await withAuth(
      http(t)
        .put('/titan-sync/connection')
        .send({ baseUrl: TITAN_URL, itEmail: IT_EMAIL }),
      token,
      tenant.id,
    );
    const kept = await t.prisma.titanConnection.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    });
    expect(kept.itPassword).toBe(row.itPassword);

    // itPassword '' la borra.
    const cleared = await withAuth(
      http(t)
        .put('/titan-sync/connection')
        .send({ baseUrl: TITAN_URL, itEmail: IT_EMAIL, itPassword: '' }),
      token,
      tenant.id,
    );
    expect(cleared.body).toMatchObject({
      itPasswordIsSet: false,
      configured: false,
    });
  });

  it('BE-TS-04: probar conexión hace login del usuario técnico, cuenta usuarios y cierra la sesión', async () => {
    const { tenant, token } = await scenario(ALL);
    await connect(token, tenant.id);
    const users = [
      titanUser(1, ['IT']),
      titanUser(2, ['E_PortalEmpleado'], { locked: true }),
    ];
    const mock = fakeTitan(users, {});
    try {
      const res = await withAuth(
        http(t).post('/titan-sync/connection/test'),
        token,
        tenant.id,
      );
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true, totalUsers: 2, eligibleUsers: 1 });
      const paths = mock.requests.map((r) => r.url.slice(TITAN_URL.length));
      expect(paths).toEqual([
        '/api/auth/login',
        '/api/users',
        '/api/auth/logout',
      ]);
    } finally {
      mock.restore();
    }
  });

  it('BE-TS-05: si Titan exige MFA al usuario técnico, probar conexión lo informa sin romper', async () => {
    const { tenant, token } = await scenario(ALL);
    await connect(token, tenant.id);
    const mock = fakeTitan([], {}, { mfa: true });
    try {
      const res = await withAuth(
        http(t).post('/titan-sync/connection/test'),
        token,
        tenant.id,
      );
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('MFA');
    } finally {
      mock.restore();
    }
  });

  it('BE-TS-06: la previsualización marca estado (nuevo / miembro / otra empresa) y elegibilidad, sin filtrar secretos de Titan', async () => {
    const { tenant, empleado, token } = await scenario(ALL);
    await connect(token, tenant.id);
    const other = await createTenant(t.prisma, { slug: uniqueSlug('otra') });
    const otherRole = await createRole(t.prisma, {
      tenantId: other.id,
      name: 'X',
    });

    const nuevo = titanUser(10, ['Manager', 'E_PortalEmpleado']);
    const miembro = titanUser(11, ['E_PortalEmpleado']);
    const ajeno = titanUser(12, ['E_PortalEmpleado']);
    const bloqueado = titanUser(13, ['E_PortalEmpleado'], { locked: true });
    const tecnico = titanUser(14, ['Interfaz_IT'], {
      personId: null,
      person: null,
    });
    await createUser(t.prisma, {
      email: miembro.email,
      memberships: [{ tenantId: tenant.id, roleId: empleado.id }],
    });
    await createUser(t.prisma, {
      email: ajeno.email,
      memberships: [{ tenantId: other.id, roleId: otherRole.id }],
    });

    const mock = fakeTitan([nuevo, miembro, ajeno, bloqueado, tecnico], {});
    try {
      const res = await withAuth(
        http(t).get('/titan-sync/users'),
        token,
        tenant.id,
      );
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(
        res.body.users.map((u: any) => [u.titanUserId, u]),
      );
      expect(byId[10]).toMatchObject({
        status: 'new',
        eligible: true,
        roles: ['E_PortalEmpleado', 'Manager'],
        firstName: 'Nombre10',
      });
      expect(byId[11]).toMatchObject({ status: 'member', eligible: true });
      expect(byId[12]).toMatchObject({
        status: 'other-tenant',
        eligible: true,
      });
      expect(byId[13]).toMatchObject({
        eligible: false,
        ineligibleReason: 'Bloqueado en Titan',
      });
      expect(byId[14].eligible).toBe(false);
      expect(res.body.roles).toEqual([
        'E_PortalEmpleado',
        'Interfaz_IT',
        'Manager',
      ]);
      expect(JSON.stringify(res.body)).not.toContain('no-debe-viajar');
    } finally {
      mock.restore();
    }
  });

  it('BE-TS-07: importar crea usuario + membresía con el rol de PCI elegido + vínculo con TODOS los roles de Titan y el celular normalizado', async () => {
    const { tenant, empleado, token } = await scenario(ALL);
    await connect(token, tenant.id);
    const phone = uniqueTitanPhone();
    const u = titanUser(20, [
      'E_GestionDocumental',
      'E_PortalEmpleado',
      'Manager',
    ]);
    const contacts = {
      [u.personId!]: [
        { value: '4444-5555', isPrimary: true, contactType: FIJO },
        { value: phone.raw, isPrimary: false, contactType: CELULAR },
        {
          value: u.email,
          isPrimary: false,
          contactType: { value: 'E-mail', code: 'MAIL' },
        },
      ],
    };
    const mock = fakeTitan([u], contacts);
    try {
      const res = await withAuth(
        http(t)
          .post('/titan-sync/import')
          .send({ titanUserIds: [20], roleId: empleado.id }),
        token,
        tenant.id,
      );
      expect(res.status).toBe(201);
      expect(res.body.summary).toMatchObject({
        requested: 1,
        created: 1,
        skipped: 0,
      });
      expect(res.body.results[0]).toMatchObject({
        outcome: 'created',
        phone: phone.whatsapp,
        warnings: [],
      });
      expect(mock.requests.at(-1)!.url).toBe(`${TITAN_URL}/api/auth/logout`);
    } finally {
      mock.restore();
    }

    const created = await t.prisma.user.findFirstOrThrow({
      where: { email: u.email },
      include: { tenants: true, titanLinks: true },
    });
    expect(created).toMatchObject({
      firstName: 'Nombre20',
      lastName: 'Apellido20',
      phone: phone.whatsapp,
    });
    expect(created.tenants).toEqual([
      expect.objectContaining({ tenantId: tenant.id, roleId: empleado.id }),
    ]);
    expect(created.titanLinks[0]).toMatchObject({
      tenantId: tenant.id,
      titanUserId: 20,
      titanEmail: u.email,
      titanPersonId: u.personId,
      titanCompanyId: 'company-1',
      titanRoles: ['E_GestionDocumental', 'E_PortalEmpleado', 'Manager'],
    });
    // Nunca el hash de Titan: la contraseña de PCI es propia (y aleatoria).
    expect(created.passwordHash).not.toContain('no-debe-viajar');
  });

  it('BE-TS-08: re-importar refresca los roles de Titan; un miembro existente se vincula; uno de otra empresa se saltea', async () => {
    const { tenant, empleado, token } = await scenario(ALL);
    await connect(token, tenant.id);
    const other = await createTenant(t.prisma, { slug: uniqueSlug('otra') });
    const otherRole = await createRole(t.prisma, {
      tenantId: other.id,
      name: 'X',
    });

    const a = titanUser(30, ['E_PortalEmpleado']);
    const miembro = titanUser(31, ['Manager']);
    const ajeno = titanUser(32, ['Manager']);
    const existingPhone = '+5491100000031';
    await createUser(t.prisma, {
      email: miembro.email,
      phone: existingPhone,
      memberships: [{ tenantId: tenant.id, roleId: empleado.id }],
    });
    await createUser(t.prisma, {
      email: ajeno.email,
      memberships: [{ tenantId: other.id, roleId: otherRole.id }],
    });
    const contacts = {
      [miembro.personId!]: [
        { value: '11 2222-3333', isPrimary: true, contactType: CELULAR },
      ],
    };

    let mock = fakeTitan([a], {});
    try {
      await withAuth(
        http(t)
          .post('/titan-sync/import')
          .send({ titanUserIds: [30], roleId: empleado.id }),
        token,
        tenant.id,
      );
    } finally {
      mock.restore();
    }

    a.roles = [
      { roleId: 6, name: 'Manager' },
      { roleId: 20, name: 'E_PortalEmpleado' },
    ];
    mock = fakeTitan([a, miembro, ajeno], contacts);
    try {
      const res = await withAuth(
        http(t)
          .post('/titan-sync/import')
          .send({ titanUserIds: [30, 31, 32, 999], roleId: empleado.id }),
        token,
        tenant.id,
      );
      const byId = Object.fromEntries(
        res.body.results.map((r: any) => [r.titanUserId, r]),
      );
      expect(byId[30].outcome).toBe('updated');
      expect(byId[31].outcome).toBe('linked');
      expect(byId[31].phone).toBe(existingPhone); // nunca pisa un teléfono cargado
      expect(byId[32]).toMatchObject({ outcome: 'skipped' });
      expect(byId[32].reason).toContain('otra empresa');
      expect(byId[999]).toMatchObject({ outcome: 'skipped' });
      expect(res.body.summary).toMatchObject({
        requested: 4,
        updated: 1,
        linked: 1,
        skipped: 2,
      });
    } finally {
      mock.restore();
    }

    const link = await t.prisma.titanUserLink.findUniqueOrThrow({
      where: { tenantId_titanUserId: { tenantId: tenant.id, titanUserId: 30 } },
    });
    expect(link.titanRoles).toEqual(['E_PortalEmpleado', 'Manager']);
    expect(await t.prisma.user.count({ where: { email: ajeno.email } })).toBe(
      1,
    );
  });

  it('BE-TS-09: un teléfono no reconocido o ya usado por otro usuario importa sin teléfono y lo avisa', async () => {
    const { tenant, empleado, token } = await scenario(ALL);
    await connect(token, tenant.id);
    const taken = uniqueTitanPhone();
    await createUser(t.prisma, {
      email: uniqueEmail(),
      phone: taken.whatsapp,
      memberships: [{ tenantId: tenant.id, roleId: empleado.id }],
    });
    const raro = titanUser(40, ['E_PortalEmpleado']);
    const dup = titanUser(41, ['E_PortalEmpleado']);
    const contacts = {
      [raro.personId!]: [
        { value: 'interno 123', isPrimary: true, contactType: CELULAR },
      ],
      [dup.personId!]: [
        { value: taken.raw, isPrimary: true, contactType: CELULAR },
      ],
    };
    const mock = fakeTitan([raro, dup], contacts);
    try {
      const res = await withAuth(
        http(t)
          .post('/titan-sync/import')
          .send({ titanUserIds: [40, 41], roleId: empleado.id }),
        token,
        tenant.id,
      );
      const byId = Object.fromEntries(
        res.body.results.map((r: any) => [r.titanUserId, r]),
      );
      expect(byId[40]).toMatchObject({ outcome: 'created', phone: null });
      expect(byId[40].warnings[0]).toContain('no reconocido');
      expect(byId[41]).toMatchObject({ outcome: 'created', phone: null });
      expect(byId[41].warnings[0]).toContain('ya lo usa otro usuario');
    } finally {
      mock.restore();
    }
  });

  it('BE-TS-10: no se puede importar con un rol de otra empresa', async () => {
    const { tenant, token } = await scenario(ALL);
    await connect(token, tenant.id);
    const other = await createTenant(t.prisma, { slug: uniqueSlug('otra') });
    const otherRole = await createRole(t.prisma, {
      tenantId: other.id,
      name: 'X',
    });
    const res = await withAuth(
      http(t)
        .post('/titan-sync/import')
        .send({ titanUserIds: [1], roleId: otherRole.id }),
      token,
      tenant.id,
    );
    expect(res.status).toBe(400);
  });
});
