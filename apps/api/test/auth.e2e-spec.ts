/**
 * 1.1 Autenticación — login, JWT, OTP/2FA, fingerprint (BE-AUTH-*)
 *
 * Vía: endpoints REST reales (`/auth/*`) con supertest, sobre la base efímera.
 * Frontera mockeada: el canal de email (`EmailService` → `RecordingEmailService`), que es de
 * donde se lee el código OTP. Nada de la lógica de auth se mockea.
 *
 * Los casos invertidos (SEC-*) van como `it.failing`: verifican el comportamiento SEGURO que
 * hoy no existe, así que hoy fallan (y `it.failing` los da por verdes). Cuando se corrija el
 * hallazgo, el assert pasará y `it.failing` gritará que hay que quitar el marcador.
 */
import {
  createTestApp,
  TestApp,
  tokenFor,
  tokenForWithExpiry,
  withAuth,
  loginViaApi,
  http,
  createTenant,
  createRole,
  createUser,
  createArea,
  getSystemContext,
  setSetting,
  deleteSetting,
  uniqueEmail,
  uniquePhone,
  uniqueSlug,
  DEFAULT_PASSWORD,
} from './support';
import { SmtpEmailService } from '../src/modules/auth/smtp-email.service';
import { AppConfigService } from '../src/config/app-config.service';
import { AuthService } from '../src/modules/auth/auth.service';

const UA = 'jest-e2e-agent';

/** Réplica del algoritmo de fingerprint del código (`DeviceService.computeFingerprint`) para
 *  CONSTRUIR devices de fixture; los asserts son siempre sobre comportamiento, no sobre esto. */
function computeFingerprint(phone: string | null, userAgent: string): string {
  return Buffer.from(`${phone ?? ''}:${userAgent}`).toString('base64');
}

describe('1.1 Autenticación (BE-AUTH-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  afterEach(async () => {
    // Los settings de OTP son globales: limpiarlos para no contaminar otros tests/specs.
    await deleteSetting(t.prisma, 'OTP_ENABLED');
    await deleteSetting(t.prisma, 'OTP_CODE_LENGTH');
    await deleteSetting(t.prisma, 'OTP_TTL_SECONDS');
    t.email.reset();
  });

  it('BE-AUTH-01: login correcto con OTP deshabilitado devuelve tokens sin passwordHash', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'false');
    const user = await createUser(t.prisma, { email: uniqueEmail('auth01'), password: DEFAULT_PASSWORD });

    const res = await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);

    // Nota: el plan dice "200", pero `@Post('login')` sin `@HttpCode` devuelve 201 (default de
    // Nest para POST). El test refleja el comportamiento REAL del código, no la suposición del
    // plan. Aplica a login y verify-otp en todo este bloque.
    expect(res.status).toBe(201);
    expect(res.body.step).toBe('authenticated');
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('BE-AUTH-02: login con contraseña incorrecta devuelve 401 "Credenciales inválidas"', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'false');
    const user = await createUser(t.prisma, { email: uniqueEmail('auth02'), password: DEFAULT_PASSWORD });

    const res = await loginViaApi(t, user.email, 'contraseña-incorrecta', UA);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Credenciales inválidas');
  });

  it('BE-AUTH-03: login con email inexistente devuelve 401 con el mismo mensaje que 02', async () => {
    const res = await loginViaApi(t, uniqueEmail('noexiste'), DEFAULT_PASSWORD, UA);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Credenciales inválidas');
  });

  it('BE-AUTH-04: login de un usuario dado de baja devuelve 401 aunque la contraseña sea válida', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'false');
    const user = await createUser(t.prisma, {
      email: uniqueEmail('auth04'),
      password: DEFAULT_PASSWORD,
      deletedAt: new Date(),
    });

    const res = await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Credenciales inválidas');
  });

  it('BE-AUTH-05: login sin header User-Agent devuelve 401', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'false');
    const user = await createUser(t.prisma, { email: uniqueEmail('auth05'), password: DEFAULT_PASSWORD });

    const res = await http(t)
      .post('/auth/login')
      .unset('User-Agent')
      .send({ email: user.email, password: DEFAULT_PASSWORD });

    expect(res.status).toBe(401);
  });

  it('BE-AUTH-06: login con OTP habilitado y primer dispositivo emite tokens y registra el fingerprint', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'true');
    const user = await createUser(t.prisma, {
      email: uniqueEmail('auth06'),
      password: DEFAULT_PASSWORD,
      phone: uniquePhone(),
    });

    const res = await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);

    expect(res.status).toBe(201);
    expect(res.body.step).toBe('authenticated');
    expect(typeof res.body.accessToken).toBe('string');
    const devices = await t.prisma.device.count({ where: { userId: user.id } });
    expect(devices).toBe(1);
  });

  it('BE-AUTH-07: login con OTP habilitado desde un device nuevo de un usuario con devices pide OTP', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'true');
    const phone = uniquePhone();
    const user = await createUser(t.prisma, { email: uniqueEmail('auth07'), password: DEFAULT_PASSWORD, phone });
    // Ya tiene un device previo (de OTRO user-agent), así que este login es "device nuevo".
    await t.prisma.device.create({
      data: {
        userId: user.id,
        fingerprint: computeFingerprint(phone, 'user-agent-previo'),
        userAgent: 'user-agent-previo',
        expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      },
    });

    const res = await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);

    expect(res.status).toBe(201);
    expect(res.body.step).toBe('otp_required');
    expect(res.body.accessToken).toBeUndefined();
    expect(t.email.codeFor(user.email)).toMatch(/^\d{6}$/);
  });

  it('BE-AUTH-08: login con OTP habilitado y fingerprint ya válido emite tokens sin pedir OTP', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'true');
    const phone = uniquePhone();
    const user = await createUser(t.prisma, { email: uniqueEmail('auth08'), password: DEFAULT_PASSWORD, phone });
    await t.prisma.device.create({
      data: {
        userId: user.id,
        fingerprint: computeFingerprint(phone, UA), // coincide con el login de abajo
        userAgent: UA,
        expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      },
    });

    const res = await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);

    expect(res.status).toBe(201);
    expect(res.body.step).toBe('authenticated');
    expect(typeof res.body.accessToken).toBe('string');
    expect(t.email.last).toBeUndefined(); // no se envió OTP
  });

  it('BE-AUTH-09: verify-otp con el código correcto dentro del TTL autentica y registra el device', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'true');
    const phone = uniquePhone();
    const user = await createUser(t.prisma, { email: uniqueEmail('auth09'), password: DEFAULT_PASSWORD, phone });
    await t.prisma.device.create({
      data: {
        userId: user.id,
        fingerprint: computeFingerprint(phone, 'otro-ua'),
        userAgent: 'otro-ua',
        expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      },
    });
    await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA); // dispara el OTP
    const code = t.email.codeFor(user.email)!;

    const res = await http(t).post('/auth/verify-otp').set('User-Agent', UA).send({ code });

    expect(res.status).toBe(201);
    expect(res.body.step).toBe('authenticated');
    const device = await t.prisma.device.findUnique({
      where: { fingerprint: computeFingerprint(phone, UA) },
    });
    expect(device).not.toBeNull();
  });

  it('BE-AUTH-10: verify-otp con código vencido devuelve 401 "Código expirado"', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'true');
    await setSetting(t.prisma, 'OTP_TTL_SECONDS', '0'); // el código nace ya vencido
    const phone = uniquePhone();
    const user = await createUser(t.prisma, { email: uniqueEmail('auth10'), password: DEFAULT_PASSWORD, phone });
    await t.prisma.device.create({
      data: {
        userId: user.id,
        fingerprint: computeFingerprint(phone, 'otro-ua'),
        userAgent: 'otro-ua',
        expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      },
    });
    await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);
    const code = t.email.codeFor(user.email)!;

    const res = await http(t).post('/auth/verify-otp').set('User-Agent', UA).send({ code });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Código expirado');
  });

  it('BE-AUTH-11: verify-otp con código inexistente devuelve 401 "Código inválido o expirado"', async () => {
    const res = await http(t).post('/auth/verify-otp').set('User-Agent', UA).send({ code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Código inválido o expirado');
  });

  it('BE-AUTH-12: verify-otp de un usuario dado de baja entre pedir y verificar devuelve 401 "Usuario no encontrado"', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'true');
    const phone = uniquePhone();
    const user = await createUser(t.prisma, { email: uniqueEmail('auth12'), password: DEFAULT_PASSWORD, phone });
    await t.prisma.device.create({
      data: {
        userId: user.id,
        fingerprint: computeFingerprint(phone, 'otro-ua'),
        userAgent: 'otro-ua',
        expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      },
    });
    await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);
    const code = t.email.codeFor(user.email)!;
    // Baja entre el pedido y la verificación.
    await t.prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });

    const res = await http(t).post('/auth/verify-otp').set('User-Agent', UA).send({ code });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Usuario no encontrado');
  });

  it('BE-AUTH-13: GET /auth/me con token válido devuelve tenants y permisos efectivos (catálogo completo si SuperAdmin)', async () => {
    const { admin, tenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);

    const res = await withAuth(http(t).get('/auth/me'), token);

    expect(res.status).toBe(200);
    const membership = res.body.tenants.find((m: any) => m.tenant.id === tenant.id);
    expect(membership).toBeDefined();
    // SuperAdmin recibe el catálogo completo (15 recursos × 4 acciones = 60).
    expect(membership.role.permissions).toHaveLength(60);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('BE-AUTH-14: GET /auth/me sin token o con token inválido devuelve 401', async () => {
    const sinToken = await http(t).get('/auth/me');
    expect(sinToken.status).toBe(401);

    const tokenInvalido = await withAuth(http(t).get('/auth/me'), 'no-es-un-jwt');
    expect(tokenInvalido.status).toBe(401);
  });

  it('BE-AUTH-15: registro con email ya en uso entre activos devuelve 401 "El email ya está registrado"', async () => {
    const existing = await createUser(t.prisma, { email: uniqueEmail('auth15'), password: DEFAULT_PASSWORD });

    const res = await http(t)
      .post('/auth/register')
      .send({ email: existing.email, password: 'password123' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('El email ya está registrado');
  });

  it('BE-AUTH-16: registro con contraseña de menos de 8 caracteres devuelve 400', async () => {
    const res = await http(t)
      .post('/auth/register')
      .send({ email: uniqueEmail('auth16'), password: 'corta7' });

    expect(res.status).toBe(400);
  });

  // --- BE-AUTH-17 (SEC-06): el refresh token NO debe valer como access token ---
  it.failing('BE-AUTH-17: usar el refreshToken como Bearer debe devolver 401 (SEC-06)', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'false');
    const user = await createUser(t.prisma, { email: uniqueEmail('auth17'), password: DEFAULT_PASSWORD });
    const login = await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);
    const refreshToken = login.body.refreshToken as string;

    const res = await withAuth(http(t).get('/auth/me'), refreshToken);

    // Comportamiento SEGURO esperado: el refresh no vale como access → 401.
    // Hoy pasa como válido (200) porque no se diferencia el tipo de token.
    expect(res.status).toBe(401);
  });

  // --- BE-AUTH-18 (SEC-13): la validación de OTP debe usar la longitud configurada, no un fijo de 6 ---
  it.failing('BE-AUTH-18: con OTP_CODE_LENGTH=5 el código de 5 dígitos debe aceptarse (SEC-13)', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'true');
    await setSetting(t.prisma, 'OTP_CODE_LENGTH', '5');
    const phone = uniquePhone();
    const user = await createUser(t.prisma, { email: uniqueEmail('auth18'), password: DEFAULT_PASSWORD, phone });
    await t.prisma.device.create({
      data: {
        userId: user.id,
        fingerprint: computeFingerprint(phone, 'otro-ua'),
        userAgent: 'otro-ua',
        expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      },
    });
    await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);
    const code = t.email.codeFor(user.email)!;
    expect(code).toMatch(/^\d{5}$/); // el código se generó con la longitud configurada

    const res = await http(t).post('/auth/verify-otp').set('User-Agent', UA).send({ code });

    // SEGURO: la validación usa la longitud configurada → acepta el de 5 dígitos.
    // Hoy el DTO exige @Length(6,6) → 400, dejando el 2FA inutilizable con longitud ≠ 6.
    expect(res.status).toBe(200);
  });

  // --- BE-AUTH-19 (SEC-01): la verificación de OTP debe estar acotada (rate limit / lockout) ---
  it.failing('BE-AUTH-19: la fuerza bruta contra verify-otp debe estar acotada con 429 (SEC-01)', async () => {
    const attempts: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await http(t)
        .post('/auth/verify-otp')
        .set('User-Agent', UA)
        .send({ code: String(100000 + i) });
      attempts.push(res.status);
    }

    // SEGURO: tras varios intentos, el exceso recibe 429 (rate limiting).
    // Hoy no hay ningún límite: todos responden 401 y la fuerza bruta es libre.
    expect(attempts.some((s) => s === 429)).toBe(true);
  });

  // --- BE-AUTH-20 (SEC-07): el fingerprint debe ser un hash no reversible (SHA-256) ---
  it.failing('BE-AUTH-20: el fingerprint del dispositivo debe ser un hash SHA-256 no reversible (SEC-07)', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'true');
    const phone = uniquePhone();
    const user = await createUser(t.prisma, { email: uniqueEmail('auth20'), password: DEFAULT_PASSWORD, phone });
    await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA); // primer device → crea fingerprint
    const device = await t.prisma.device.findFirst({ where: { userId: user.id } });

    // SEGURO: el fingerprint es un hash SHA-256 (64 hex), no una codificación reversible.
    // Hoy es base64(phone:userAgent), reversible.
    expect(device!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  // --- BE-AUTH-21 (SEC-10): el cuerpo del OTP no debe escribirse en los logs ---
  it.failing('BE-AUTH-21: sin SMTP, el envío del OTP no debe volcar el código en los logs (SEC-10)', async () => {
    // Directo sobre SmtpEmailService (la frontera de correo real), con el host SIN configurar:
    // ahí corre el path "stub" que hoy loguea el cuerpo del mail —con el código— en consola. Es
    // exactamente el código del hallazgo, sin depender de cómo esté el .env del entorno.
    const noConfig = { get: async () => undefined } as unknown as AppConfigService;
    const smtp = new SmtpEmailService(noConfig);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    let loggedCode: boolean;
    try {
      await smtp.send({
        to: 'persona@e2e.test',
        subject: 'Código de verificación',
        text: 'Tu código de verificación es: 123456. Válido por 300 segundos.',
      });
      // Ojo: leer `mock.calls` ANTES de `mockRestore()`, que resetea el registro de llamadas.
      loggedCode = logSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === 'string' && a.includes('123456')),
      );
    } finally {
      logSpy.mockRestore();
    }

    // SEGURO: el código del OTP no se escribe en los logs. Hoy sí (path stub sin SMTP).
    expect(loggedCode).toBe(false);
  });

  // --- BE-AUTH-22 (SEC-14): la estrategia JWT debe rechazar el token de un usuario dado de baja ---
  it.failing('BE-AUTH-22: un token de un usuario dado de baja debe rechazarse en endpoints protegidos (SEC-14)', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('auth22') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Lector', permissions: ['areas:read'] });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('auth22'),
      password: DEFAULT_PASSWORD,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, user);
    // Baja lógica DESPUÉS de emitir el token.
    await t.prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });

    const res = await withAuth(http(t).get('/areas'), token, tenant.id);

    // SEGURO: defensa en profundidad — la estrategia JWT rechaza al usuario dado de baja (401).
    // Hoy la valida por existencia (findUnique sin filtro de baja) y entra igual (200).
    expect(res.status).toBe(401);
  });

  it('BE-AUTH-23: registro con email nuevo y contraseña ≥8 crea la persona hasheada, sin membresías ni tokens', async () => {
    const email = uniqueEmail('auth23');

    const res = await http(t)
      .post('/auth/register')
      .send({ email, password: 'password123', firstName: 'Nueva', lastName: 'Persona' });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe(email);
    expect(res.body.passwordHash).toBeUndefined();
    expect(res.body.accessToken).toBeUndefined();
    const created = await t.prisma.user.findUnique({
      where: { email },
      include: { tenants: true },
    });
    expect(created!.tenants).toHaveLength(0);
    expect(created!.passwordHash.startsWith('$2')).toBe(true); // bcrypt
  });

  it('BE-AUTH-24: usar un access token vencido en un endpoint protegido devuelve 401', async () => {
    const { admin } = await getSystemContext(t.prisma);
    const expired = tokenForWithExpiry(t, admin, '-10s');

    const res = await withAuth(http(t).get('/auth/me'), expired);

    expect(res.status).toBe(401);
  });

  it('BE-AUTH-25: reiniciar el proceso entre login y verify-otp pierde el OTP (Map en memoria) → 401', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'true');
    const phone = uniquePhone();
    const user = await createUser(t.prisma, { email: uniqueEmail('auth25'), password: DEFAULT_PASSWORD, phone });
    await t.prisma.device.create({
      data: {
        userId: user.id,
        fingerprint: computeFingerprint(phone, 'otro-ua'),
        userAgent: 'otro-ua',
        expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      },
    });
    await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);
    const code = t.email.codeFor(user.email)!;

    // "Reinicio del proceso" (o segunda instancia detrás de un balanceador): el OTP vive en un
    // `Map` en memoria (`otpStore`) de AuthService, no en Redis/BD. Simular el reinicio = vaciar
    // ese Map. Es fiel al mecanismo documentado y determinista (evita bootear una segunda app,
    // que dispara el flake de la promesa flotante de `channel.consume` del broker).
    const authService = t.moduleRef.get(AuthService, { strict: false }) as any;
    authService.otpStore.clear();

    const res = await http(t).post('/auth/verify-otp').set('User-Agent', UA).send({ code });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Código inválido o expirado');
  });

  it('BE-AUTH-26: un request autenticado reemite un JWT fresco en el header X-Access-Token', async () => {
    const { admin } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);

    const res = await withAuth(http(t).get('/auth/me'), token);

    expect(res.status).toBe(200);
    expect(res.headers['x-access-token']).toBeDefined();
    expect(typeof res.headers['x-access-token']).toBe('string');
  });

  it('BE-AUTH-27: en una ruta pública (login) el interceptor no reemite X-Access-Token', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'false');
    const user = await createUser(t.prisma, { email: uniqueEmail('auth27'), password: DEFAULT_PASSWORD });

    const res = await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);

    expect(res.status).toBe(201);
    expect(res.headers['x-access-token']).toBeUndefined();
  });

  // --- BE-AUTH-28 (SEC-19): debe haber revocación server-side (logout que invalida el token) ---
  it.failing('BE-AUTH-28: el logout debe revocar el token server-side (SEC-19)', async () => {
    await setSetting(t.prisma, 'OTP_ENABLED', 'false');
    const user = await createUser(t.prisma, { email: uniqueEmail('auth28'), password: DEFAULT_PASSWORD });
    const login = await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);
    const token = login.body.accessToken as string;

    // "Logout" server-side (hoy no existe el endpoint; el logout sólo limpia el localStorage).
    await withAuth(http(t).post('/auth/logout'), token);

    const res = await withAuth(http(t).get('/auth/me'), token);

    // SEGURO: tras el logout el token queda revocado → 401. Hoy sigue válido (sin blocklist).
    expect(res.status).toBe(401);
  });
});
