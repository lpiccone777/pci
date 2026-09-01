/**
 * 1.7 Configuración y secretos (/settings) — BE-SET-*
 *
 * Vía: endpoints REST reales (`/settings/*`) con supertest, sobre la base efímera.
 * Doble candado (`SystemTenantGuard` + `@RequirePermission('settings', ...)`), catálogo único
 * de claves válidas (`settings.catalog.ts`), secretos cifrados AES-256-GCM y de solo escritura
 * (`SecretsCipher`). Nada de la lógica de settings se mockea.
 *
 * Frontera simulada (no mockeada): para BE-SET-07 (sin `SETTINGS_ENCRYPTION_KEY`) y BE-SET-10
 * (rotación de la clave maestra) se levanta una segunda/tercera instancia de la app con
 * `SecretsCipher` construido a mano contra un `ConfigService` fake que devuelve otra clave (o
 * ninguna) — mismo patrón que `BE-AUTH-21` en `auth.e2e-spec.ts` (instanciar `SmtpEmailService`
 * con un `AppConfigService` fake). Es la única forma de simular "sin la env var" o "la env var
 * cambió" sin tocar el `.env` real del entorno de desarrollo, y no mockea la lógica bajo
 * prueba: `SecretsCipher` sigue siendo la clase real, sólo cambia de qué `ConfigService` lee.
 *
 * `Setting.key` es único GLOBAL: todo lo que este spec toca se limpia en un `afterEach` común
 * (ver `TOUCHED_KEYS` más abajo) para no contaminar otros specs de la misma corrida.
 */
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
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
  setSetting,
  deleteSetting,
  uniqueEmail,
  uniquePhone,
  uniqueSlug,
} from './support';
import { SecretsCipher } from '../src/config/secrets.cipher';
import { SETTINGS_CATALOG } from '../src/modules/settings/settings.catalog';

/** Todas las keys del catálogo que algún `it` de este archivo llega a escribir en BD. */
const TOUCHED_KEYS = [
  'OTP_TTL_SECONDS',
  'LLM_PROVIDER',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'MINIMAX_API_KEY',
  'OTP_CODE_LENGTH',
  'DEVICE_FINGERPRINT_TTL_DAYS',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'TWILIO_AUTH_TOKEN',
  'GUPSHUP_API_KEY',
  'GUPSHUP_SMS_PASSWORD',
  'INVGATE_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'GUPSHUP_SMS_USERID',
  'INVGATE_API_USER',
  'TWILIO_WHATSAPP_FROM',
  'WHATSAPP_PROVIDER',
  'SMS_PROVIDER',
];

/** Construye un `SecretsCipher` real, pero alimentado con un `ConfigService` fake — para
 *  simular "sin SETTINGS_ENCRYPTION_KEY" o "la clave maestra rotó" sin tocar el `.env`. */
function cipherWithMasterKey(masterKey: string | undefined): SecretsCipher {
  const fakeConfig = { get: () => masterKey } as unknown as ConfigService;
  return new SecretsCipher(fakeConfig);
}

describe('1.7 Configuración y secretos (BE-SET-*)', () => {
  let t: TestApp;
  let adminToken: string;
  let systemTenantId: string;

  beforeAll(async () => {
    t = await createTestApp();
    const { admin, tenant } = await getSystemContext(t.prisma);
    adminToken = tokenFor(t, admin);
    systemTenantId = tenant.id;
  });

  afterAll(async () => {
    await t.close();
  });

  afterEach(async () => {
    for (const key of TOUCHED_KEYS) {
      await deleteSetting(t.prisma, key);
    }
    delete process.env.OTP_CODE_LENGTH;
  });

  /** GET/POST/PATCH/DELETE contra /settings autenticado como el SuperAdmin del tenant system. */
  const asAdmin = (req: ReturnType<typeof http>) => withAuth(req, adminToken, systemTenantId);

  it('BE-SET-01: GET /settings como SuperAdmin de sistema devuelve el catálogo resuelto con source y updatedAt', async () => {
    const res = await asAdmin(http(t).get('/settings'));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(SETTINGS_CATALOG.length);

    const catalogKeys = new Set(SETTINGS_CATALOG.map((d) => d.key));
    for (const entry of res.body) {
      expect(catalogKeys.has(entry.key)).toBe(true);
      expect(['db', 'env', 'default']).toContain(entry.source);
      expect(entry).toHaveProperty('updatedAt'); // null si nunca se guardó en BD
    }
  });

  it('BE-SET-02: GET /settings desde un tenant que no es el de sistema devuelve 403', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('set02') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Admin empresa' });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('set02'),
      phone: uniquePhone(),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const token = tokenFor(t, user);

    const res = await withAuth(http(t).get('/settings'), token, tenant.id);

    expect(res.status).toBe(403);
    // Lo corta SystemTenantGuard, antes de mirar ningún permiso RBAC.
    expect(res.body.message).toBe('Esta operación solo puede realizarse desde el tenant de sistema');
  });

  it('BE-SET-03: POST /settings con una key fuera del catálogo devuelve 400 con la lista de keys válidas', async () => {
    const res = await asAdmin(http(t).post('/settings')).send({
      key: 'CLAVE_QUE_NO_EXISTE',
      value: 'algo',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('no es una clave configurable');
    expect(res.body.message).toContain('OTP_ENABLED'); // una key real del catálogo, de muestra
  });

  it('BE-SET-04: fijar un valor number fuera del rango min/max del catálogo devuelve 400', async () => {
    // OTP_TTL_SECONDS: min 60, max 3600 (settings.catalog.ts).
    const res = await asAdmin(http(t).post('/settings')).send({
      key: 'OTP_TTL_SECONDS',
      value: '999999',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('OTP_TTL_SECONDS debe ser <= 3600');

    const row = await t.prisma.setting.findUnique({ where: { key: 'OTP_TTL_SECONDS' } });
    expect(row).toBeNull(); // la validación corta ANTES de escribir en BD
  });

  it('BE-SET-05: fijar un valor enum fuera de allowedValues devuelve 400', async () => {
    // LLM_PROVIDER: allowedValues = openai, gemini, claude, openrouter, opencodego, minimax.
    const res = await asAdmin(http(t).post('/settings')).send({
      key: 'LLM_PROVIDER',
      value: 'chatgpt',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      'LLM_PROVIDER debe ser uno de: openai, gemini, claude, openrouter, opencodego, minimax',
    );
  });

  it('BE-SET-06: guardar una API key (secret:true) con SETTINGS_ENCRYPTION_KEY presente se guarda cifrada, nunca en texto plano', async () => {
    const plain = 'sk-test-be-set-06-1234567890abcdef';

    const res = await asAdmin(http(t).post('/settings')).send({ key: 'OPENAI_API_KEY', value: plain });

    // @Post() sin @HttpCode → 201 (default de Nest), no el 200 "genérico" que uno podría suponer.
    expect(res.status).toBe(201);
    expect(res.body.value).not.toBe(plain);
    expect(res.body.isSet).toBe(true);

    const row = await t.prisma.setting.findUnique({ where: { key: 'OPENAI_API_KEY' } });
    expect(row!.value.startsWith('enc:v1:')).toBe(true); // cifrado, no el plano
    expect(row!.value).not.toContain(plain);
  });

  it('BE-SET-07: guardar un secret sin SETTINGS_ENCRYPTION_KEY se rechaza con 400 (nunca fallback a texto plano)', async () => {
    const t2 = await createTestApp({
      customize: (b) => b.overrideProvider(SecretsCipher).useValue(cipherWithMasterKey(undefined)),
    });
    try {
      const { admin, tenant } = await getSystemContext(t2.prisma);
      const token2 = tokenFor(t2, admin);

      const res = await withAuth(http(t2).post('/settings'), token2, tenant.id).send({
        key: 'OPENROUTER_API_KEY',
        value: 'sk-or-be-set-07',
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('SETTINGS_ENCRYPTION_KEY');

      const row = await t2.prisma.setting.findUnique({ where: { key: 'OPENROUTER_API_KEY' } });
      expect(row).toBeNull(); // nunca se escribió texto plano como fallback
    } finally {
      await t2.close();
    }
  });

  it('BE-SET-08: GET de un setting secreto devuelve el value enmascarado + isSet:true, jamás el valor real', async () => {
    const plain = 'sk-test-be-set-08-abcdef123456';
    await asAdmin(http(t).post('/settings')).send({ key: 'OPENAI_API_KEY', value: plain });

    const res = await asAdmin(http(t).get('/settings/OPENAI_API_KEY'));

    expect(res.status).toBe(200);
    expect(res.body.isSet).toBe(true);
    expect(res.body.value).not.toBe(plain);
    expect(res.body.value).toContain('•'); // SecretsCipher.mask()
    expect(JSON.stringify(res.body)).not.toContain(plain);
  });

  it('BE-SET-09: guardar un secreto vacío devuelve 400 (usar DELETE para limpiarlo)', async () => {
    const res = await asAdmin(http(t).post('/settings')).send({ key: 'OPENAI_API_KEY', value: '' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('está vacío');
    expect(res.body.message).toContain('DELETE /settings/OPENAI_API_KEY');
  });

  it('BE-SET-10: rotar SETTINGS_ENCRYPTION_KEY y leer un secreto viejo devuelve isSet:true + "(no se pudo descifrar)"', async () => {
    const plain = 'minimax-secret-be-set-10-xyz';
    await asAdmin(http(t).post('/settings')).send({ key: 'MINIMAX_API_KEY', value: plain });

    // Misma clave maestra que /settings usa normalmente ES la de apps/api/.env (SETTINGS_ENCRYPTION_KEY).
    // Acá simulamos que la clave ROTÓ: una tercera app con el cipher apuntando a otra clave, que
    // intenta descifrar un valor cifrado con la clave anterior.
    const t3 = await createTestApp({
      customize: (b) =>
        b.overrideProvider(SecretsCipher).useValue(cipherWithMasterKey('otra-clave-maestra-post-rotacion-000')),
    });
    try {
      const { admin, tenant } = await getSystemContext(t3.prisma);
      const token3 = tokenFor(t3, admin);

      const res = await withAuth(http(t3).get('/settings/MINIMAX_API_KEY'), token3, tenant.id);

      expect(res.status).toBe(200);
      expect(res.body.isSet).toBe(true);
      expect(res.body.value).toBe('(no se pudo descifrar)');
      expect(res.body.source).toBe('db');
    } finally {
      await t3.close();
    }
  });

  it('BE-SET-11: cascada de resolución — BD tapa a env; sin BD usa env; sin BD ni env usa default', async () => {
    // OTP_CODE_LENGTH: defaultValue '6', NO está en apps/api/.env (a diferencia de OTP_TTL_SECONDS).
    const KEY = 'OTP_CODE_LENGTH';
    await deleteSetting(t.prisma, KEY);
    delete process.env[KEY];

    const sinNada = await asAdmin(http(t).get(`/settings/${KEY}`));
    expect(sinNada.body.value).toBe('6');
    expect(sinNada.body.source).toBe('default');

    process.env[KEY] = '7';
    const conEnv = await asAdmin(http(t).get(`/settings/${KEY}`));
    expect(conEnv.body.value).toBe('7');
    expect(conEnv.body.source).toBe('env');

    await setSetting(t.prisma, KEY, '8');
    const conBd = await asAdmin(http(t).get(`/settings/${KEY}`));
    expect(conBd.body.value).toBe('8'); // BD tapa a env, aunque process.env siga en '7'
    expect(conBd.body.source).toBe('db');

    delete process.env[KEY];
  });

  it('BE-SET-12: ningún log escribe el valor de un secret, sólo "Secret actualizado: KEY (cifrado)"', async () => {
    const plain = 'sk-or-be-set-12-nunca-en-logs';
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let loggedPlain: boolean;
    let loggedCifrado: boolean;
    try {
      await asAdmin(http(t).post('/settings')).send({ key: 'OPENROUTER_API_KEY', value: plain });

      // Leer mock.calls ANTES de mockRestore() (mockRestore limpia el registro de llamadas).
      loggedPlain = logSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === 'string' && a.includes(plain)),
      );
      loggedCifrado = logSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === 'string' && a.includes('OPENROUTER_API_KEY (cifrado)')),
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(loggedPlain).toBe(false);
    expect(loggedCifrado).toBe(true);
  });

  it('BE-SET-13: DELETE /settings/:key de una key con valor en BD vuelve a resolver por env/default', async () => {
    // DEVICE_FINGERPRINT_TTL_DAYS: `defaultValue` del catálogo es '90' y este caso EXIGE que
    // `apps/api/.env` traiga un valor distinto (30) — si no, el valor devuelto no distingue si
    // resolvió por env o por default, y lo único que quedaría probando eso sería `source`.
    //
    // O sea: que este test falle con `Expected "30", Received "90"` NO es un test desactualizado,
    // es la señal de que el `.env` local perdió ese valor. El arreglo va en el `.env`
    // (DEVICE_FINGERPRINT_TTL_DAYS=30), no acá.
    await setSetting(t.prisma, 'DEVICE_FINGERPRINT_TTL_DAYS', '45');

    const res = await asAdmin(http(t).delete('/settings/DEVICE_FINGERPRINT_TTL_DAYS'));

    // @Delete() sin @HttpCode → 200 (default de Nest).
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('env');
    expect(res.body.value).toBe('30');

    const row = await t.prisma.setting.findUnique({ where: { key: 'DEVICE_FINGERPRINT_TTL_DAYS' } });
    expect(row).toBeNull();
  });

  it('BE-SET-14: GET /settings/providers/status devuelve active, encryptionConfigured y providers[] con ready/missing', async () => {
    await deleteSetting(t.prisma, 'GEMINI_API_KEY');
    await setSetting(t.prisma, 'LLM_PROVIDER', 'gemini');

    const antes = await asAdmin(http(t).get('/settings/providers/status'));
    expect(antes.status).toBe(200);
    expect(antes.body.active).toBe('gemini');
    expect(antes.body.encryptionConfigured).toBe(true); // SETTINGS_ENCRYPTION_KEY está en el .env de test

    const providerNames = antes.body.providers.map((p: { provider: string }) => p.provider);
    expect(providerNames.sort()).toEqual(
      ['openai', 'gemini', 'claude', 'openrouter', 'opencodego', 'minimax'].sort(),
    );
    const geminiAntes = antes.body.providers.find((p: { provider: string }) => p.provider === 'gemini');
    expect(geminiAntes.active).toBe(true);
    expect(geminiAntes.ready).toBe(false);
    expect(geminiAntes.missing).toEqual(['GEMINI_API_KEY']);

    await asAdmin(http(t).post('/settings')).send({ key: 'GEMINI_API_KEY', value: 'gemini-be-set-14-key' });

    const despues = await asAdmin(http(t).get('/settings/providers/status'));
    const geminiDespues = despues.body.providers.find((p: { provider: string }) => p.provider === 'gemini');
    expect(geminiDespues.ready).toBe(true);
    expect(geminiDespues.missing).toEqual([]);
  });

  it('BE-SET-15: GET /settings/:key de una key del catálogo vs. una key inexistente', async () => {
    await deleteSetting(t.prisma, 'OTP_TTL_SECONDS');

    const noSecreto = await asAdmin(http(t).get('/settings/OTP_TTL_SECONDS'));
    expect(noSecreto.status).toBe(200);
    expect(noSecreto.body.value).toBe('300'); // valor de apps/api/.env
    expect(noSecreto.body.source).toBe('env');

    await asAdmin(http(t).post('/settings')).send({ key: 'OPENAI_API_KEY', value: 'sk-be-set-15' });
    const secreto = await asAdmin(http(t).get('/settings/OPENAI_API_KEY'));
    expect(secreto.body.isSet).toBe(true);
    expect(secreto.body.value).not.toBe('sk-be-set-15');

    const inexistente = await asAdmin(http(t).get('/settings/NO_EXISTE_ESTA_KEY'));
    expect(inexistente.status).toBe(400);
    expect(inexistente.body.message).toContain('no es una clave configurable');
  });

  it('BE-SET-16: PATCH /settings/:key equivale a POST /settings (mismas validaciones)', async () => {
    // Número fuera de rango → misma validación que BE-SET-04.
    const fueraDeRango = await asAdmin(http(t).patch('/settings/DEVICE_FINGERPRINT_TTL_DAYS')).send({
      value: '9999',
    });
    expect(fueraDeRango.status).toBe(400);
    // validateSettingValue corta en el primer límite violado: 9999 > max (365) → mensaje del max.
    expect(fueraDeRango.body.message).toBe('DEVICE_FINGERPRINT_TTL_DAYS debe ser <= 365');

    // PATCH con valor válido: upsert real.
    const valido = await asAdmin(http(t).patch('/settings/DEVICE_FINGERPRINT_TTL_DAYS')).send({ value: '120' });
    // @Patch() sin @HttpCode → 200 (default de Nest), NO 201 como el POST.
    expect(valido.status).toBe(200);
    expect(valido.body.value).toBe('120');
    expect(valido.body.source).toBe('db');

    // PATCH sobre un secret: misma cadena de cifrado que POST.
    const plain = 'sk-be-set-16-patch-secret';
    const secreto = await asAdmin(http(t).patch('/settings/OPENAI_API_KEY')).send({ value: plain });
    expect(secreto.status).toBe(200);
    expect(secreto.body.isSet).toBe(true);
    expect(secreto.body.value).not.toBe(plain);
    const row = await t.prisma.setting.findUnique({ where: { key: 'OPENAI_API_KEY' } });
    expect(row!.value.startsWith('enc:v1:')).toBe(true);
  });

  it('BE-SET-17: DELETE /settings/:key de una key sin valor en BD devuelve 404', async () => {
    await deleteSetting(t.prisma, 'GEMINI_MODEL');

    const res = await asAdmin(http(t).delete('/settings/GEMINI_MODEL'));

    expect(res.status).toBe(404);
    expect(res.body.message).toContain('GEMINI_MODEL no tiene valor en BD');
    expect(res.body.message).toContain('usa env var o default');
  });

  it('BE-SET-18: los secretos de canales nuevos e InvGate se guardan cifrados; los identificadores no secretos van en claro', async () => {
    const secretPairs: Array<[string, string]> = [
      ['TWILIO_AUTH_TOKEN', 'twilio-auth-token-be-set-18'],
      // GUPSHUP_API_KEY es el único secreto de Gupshup: SMS ya no tiene settings propios,
      // reusa este mismo (junto con GUPSHUP_WHATSAPP_SOURCE/GUPSHUP_APP_NAME, no secretos)
      // del grupo "Mensajería: WhatsApp (Gupshup)".
      ['GUPSHUP_API_KEY', 'gupshup-api-key-be-set-18'],
      ['INVGATE_API_KEY', 'invgate-api-key-be-set-18'],
    ];
    for (const [key, plain] of secretPairs) {
      const res = await asAdmin(http(t).post('/settings')).send({ key, value: plain });
      expect(res.status).toBe(201);
      expect(res.body.isSet).toBe(true);
      expect(res.body.value).not.toBe(plain);

      const row = await t.prisma.setting.findUnique({ where: { key } });
      expect(row!.value.startsWith('enc:v1:')).toBe(true);

      const get = await asAdmin(http(t).get(`/settings/${key}`));
      expect(get.body.value).not.toBe(plain);
      expect(get.body.isSet).toBe(true);
    }

    const plainPairs: Array<[string, string]> = [
      ['TWILIO_ACCOUNT_SID', 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
      ['TWILIO_WHATSAPP_FROM', '+14155238886'],
      ['GUPSHUP_WHATSAPP_SOURCE', '15553788248'],
      ['INVGATE_API_USER', 'chatbot_test'],
    ];
    for (const [key, plain] of plainPairs) {
      const res = await asAdmin(http(t).post('/settings')).send({ key, value: plain });
      expect(res.status).toBe(201);

      const row = await t.prisma.setting.findUnique({ where: { key } });
      expect(row!.value).toBe(plain); // en claro, no cifrado

      const get = await asAdmin(http(t).get(`/settings/${key}`));
      expect(get.body.value).toBe(plain); // el GET también lo devuelve en claro
      expect(get.body.isSet).toBeUndefined(); // isSet sólo existe para keys secret:true
    }
  });

  it('BE-SET-19: WHATSAPP_PROVIDER y SMS_PROVIDER siguen la cascada estándar; un valor fuera del enum da 400', async () => {
    await deleteSetting(t.prisma, 'WHATSAPP_PROVIDER');
    await deleteSetting(t.prisma, 'SMS_PROVIDER');

    const waDefault = await asAdmin(http(t).get('/settings/WHATSAPP_PROVIDER'));
    expect(waDefault.body.value).toBe('meta');
    expect(waDefault.body.source).toBe('default'); // no está en apps/api/.env

    await setSetting(t.prisma, 'WHATSAPP_PROVIDER', 'twilio');
    const waDb = await asAdmin(http(t).get('/settings/WHATSAPP_PROVIDER'));
    expect(waDb.body.value).toBe('twilio');
    expect(waDb.body.source).toBe('db');

    const waInvalido = await asAdmin(http(t).post('/settings')).send({
      key: 'WHATSAPP_PROVIDER',
      value: 'sms-blaster',
    });
    expect(waInvalido.status).toBe(400);
    expect(waInvalido.body.message).toBe('WHATSAPP_PROVIDER debe ser uno de: meta, twilio, gupshup');

    const smsDefault = await asAdmin(http(t).get('/settings/SMS_PROVIDER'));
    expect(smsDefault.body.value).toBe('twilio');
    expect(smsDefault.body.source).toBe('default');

    await setSetting(t.prisma, 'SMS_PROVIDER', 'gupshup');
    const smsDb = await asAdmin(http(t).get('/settings/SMS_PROVIDER'));
    expect(smsDb.body.value).toBe('gupshup');
    expect(smsDb.body.source).toBe('db');

    const smsInvalido = await asAdmin(http(t).post('/settings')).send({
      key: 'SMS_PROVIDER',
      value: 'carrier-pigeon',
    });
    expect(smsInvalido.status).toBe(400);
    expect(smsInvalido.body.message).toBe('SMS_PROVIDER debe ser uno de: twilio, gupshup');
  });

  it('BE-SET-20: TWILIO_ACCOUNT_SID e INVGATE_API_USER dicen "solo escritura" en la descripción pero son secret:false: el GET los devuelve en claro', async () => {
    const twilioDef = SETTINGS_CATALOG.find((d) => d.key === 'TWILIO_ACCOUNT_SID')!;
    const invgateDef = SETTINGS_CATALOG.find((d) => d.key === 'INVGATE_API_USER')!;

    // La discrepancia real del catálogo: la descripción promete "solo escritura" pero el flag
    // `secret` (el que de verdad controla el enmascarado) está en false para ambas.
    expect(twilioDef.secret).toBeFalsy();
    expect(twilioDef.description).toContain('solo escritura');
    expect(invgateDef.secret).toBeFalsy();
    expect(invgateDef.description).toContain('solo escritura');

    const plainSid = 'ACyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
    await asAdmin(http(t).post('/settings')).send({ key: 'TWILIO_ACCOUNT_SID', value: plainSid });
    const getSid = await asAdmin(http(t).get('/settings/TWILIO_ACCOUNT_SID'));
    // Comportamiento REAL (no lo que sugiere el texto): value en claro, sin isSet.
    expect(getSid.body.value).toBe(plainSid);
    expect(getSid.body.isSet).toBeUndefined();

    const plainUser = 'chatbot_test_be_set_20';
    await asAdmin(http(t).post('/settings')).send({ key: 'INVGATE_API_USER', value: plainUser });
    const getUser = await asAdmin(http(t).get('/settings/INVGATE_API_USER'));
    expect(getUser.body.value).toBe(plainUser);
    expect(getUser.body.isSet).toBeUndefined();
  });
});
