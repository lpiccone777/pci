/**
 * 1.14 Canal de email (SMTP) (BE-EML-*)
 *
 * Config en cascada BD → env → default (misma mecánica que el resto de /settings), contraseña
 * marcada `secret: true`. Sin `EMAIL_SMTP_HOST` el envío cae a un stub que loguea en consola.
 *
 * Frontera mockeada: `nodemailer` (`createTransport`/`sendMail`) — el transporte SMTP real, NUNCA
 * la lógica de `SmtpEmailService` ni de `AuthService`. `jest.mock` es por ARCHIVO (Jest resetea el
 * registro de módulos por test file), así que este mock no afecta a ningún otro spec.
 *
 * BE-EML-01/05 instancian `SmtpEmailService` directo con un `AppConfigService` fake — mismo
 * patrón que BE-AUTH-21 en auth.e2e-spec.ts — porque no necesitan la app completa. BE-EML-03
 * (invertido) y BE-EML-08 sí, porque ejercitan `AuthService.login`/`/settings` reales.
 *
 * BLOQUEADOS (requieren un SMTP real vivo, no simulable con un mock de frontera sin volver a
 * probar el mock en vez del código): BE-EML-02, BE-EML-06, BE-EML-07.
 */
const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));
jest.mock('nodemailer', () => ({
  createTransport: (...args: unknown[]) => mockCreateTransport(...args),
}));

import {
  createTestApp,
  TestApp,
  http,
  loginViaApi,
  createUser,
  uniqueEmail,
  uniquePhone,
  setSetting,
  deleteSetting,
  DEFAULT_PASSWORD,
  getSystemContext,
  tokenFor,
  withAuth,
} from './support';
import { SmtpEmailService } from '../src/modules/auth/smtp-email.service';
import { AppConfigService } from '../src/config/app-config.service';

const UA = 'jest-e2e-email';

/** `AppConfigService` fake mínimo: sólo lo que `SmtpEmailService` llama (`get`/`getNumber`/`getBoolean`). */
function fakeConfig(values: Record<string, string>): AppConfigService {
  return {
    get: async (key: string, def?: string) => values[key] ?? def,
    getNumber: async (key: string, def: number) => {
      const v = values[key];
      if (v === undefined) return def;
      const n = Number(v);
      return isNaN(n) ? def : n;
    },
    getBoolean: async (key: string, def: boolean) => {
      const v = values[key];
      if (v === undefined || v === '') return def;
      return v.toLowerCase() === 'true';
    },
  } as unknown as AppConfigService;
}

/** Réplica de `DeviceService.computeFingerprint` para armar el device previo (mismo helper que
 *  usa auth.e2e-spec.ts en BE-AUTH-07/09/10 para forzar el camino "device nuevo"). */
function computeFingerprint(phone: string | null, userAgent: string): string {
  return Buffer.from(`${phone ?? ''}:${userAgent}`).toString('base64');
}

describe('1.14 Canal de email (SMTP) (BE-EML-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    // `recordEmail: false`: queremos el `SmtpEmailService` REAL conectado a `AuthService`
    // (BE-EML-03, BE-EML-08 no necesitan el canal de email en absoluto). `nodemailer` ya está
    // mockeado arriba, así que ningún test de este archivo toca la red de verdad.
    t = await createTestApp({ recordEmail: false });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    mockSendMail.mockReset();
    mockCreateTransport.mockClear();
  });

  afterEach(async () => {
    await deleteSetting(t.prisma, 'EMAIL_SMTP_HOST');
    await deleteSetting(t.prisma, 'EMAIL_FROM');
    await deleteSetting(t.prisma, 'EMAIL_SMTP_PASS');
    await deleteSetting(t.prisma, 'OTP_ENABLED');
  });

  it('BE-EML-01: enviar sin EMAIL_SMTP_HOST configurado no falla y cae al stub de consola', async () => {
    const smtp = new SmtpEmailService(fakeConfig({}));
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(
        smtp.send({ to: 'persona@e2e.test', subject: 'Aviso', text: 'Cuerpo del mensaje.' }),
      ).resolves.toBeUndefined();
      // Cae al path stub (comportamiento normal en desarrollo, según el catálogo de /settings:
      // "Sin configurar, los emails... quedan solo logueados en consola"). El cuerpo TAMBIÉN
      // queda en el log — eso es el hallazgo de seguridad que ya cubre BE-AUTH-21 (SEC-10) como
      // `it.failing` en auth.e2e-spec.ts; acá sólo se verifica la parte funcional: no revienta.
      expect(logSpy).toHaveBeenCalledWith('[STUB EMAIL]');
    } finally {
      logSpy.mockRestore();
    }
    expect(mockSendMail).not.toHaveBeenCalled(); // sin host, nunca arma un transporter real
  });

  it.skip('BE-EML-02: envío con host válido y credenciales correctas llega [BLOQUEADO: requiere un SMTP real vivo]', () => {
    // Mockear nodemailer para "probar" esto terminaría probando el mock, no un envío real.
  });

  it.failing(
    'BE-EML-03: login con 2FA y el servidor de correo configurado pero caído debe cortar con un error controlado, no un 500 crudo (SEC-10 / hallazgo de plan)',
    async () => {
      await setSetting(t.prisma, 'OTP_ENABLED', 'true');
      await setSetting(t.prisma, 'EMAIL_SMTP_HOST', 'smtp.caida.be-eml-03.test');
      // nodemailer está mockeado a nivel de archivo: no hay red real, así que esto es
      // determinístico y rápido — simula un host inalcanzable o credenciales inválidas.
      mockSendMail.mockRejectedValueOnce(new Error('ECONNREFUSED (simulado): servidor SMTP caído'));

      const phone = uniquePhone();
      const user = await createUser(t.prisma, {
        email: uniqueEmail('eml03'),
        password: DEFAULT_PASSWORD,
        phone,
      });
      // Device previo con OTRO user-agent: fuerza el camino "device nuevo" → AuthService.login
      // dispara sendOtp() (ver BE-AUTH-07, mismo fixture). Con 0 devices el login del primer
      // dispositivo no pide OTP y este test no ejercitaría el envío en absoluto.
      await t.prisma.device.create({
        data: {
          userId: user.id,
          fingerprint: computeFingerprint(phone, 'otro-ua'),
          userAgent: 'otro-ua',
          expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
        },
      });

      const res = await loginViaApi(t, user.email, DEFAULT_PASSWORD, UA);

      // SEGURO: el fallo del envío se captura y corta con un error controlado ("no pudimos
      // enviarte el código, probá de nuevo"), sin dejar un código huérfano vivo. Hoy
      // `AuthService.sendOtp` guarda el código en el `otpStore` en memoria ANTES de llamar
      // `emailService.send()`, y esa llamada no está envuelta en try/catch (ver
      // auth.service.ts): la excepción sube sin capturar y Nest devuelve el 500 genérico de
      // siempre, con el código ya guardado (huérfano: nunca llegó al usuario, pero
      // `verify-otp` lo sigue aceptando).
      expect(res.status).not.toBe(500);
      expect(res.body.message).not.toBe('Internal server error');
    },
  );

  it.skip('BE-EML-04: SMTP caído durante una notificación de transferencia a agente [no ejercitable por REST sin colgar el test 300s]', () => {
    // `executeTransferAgentNode` llama `emailService.send()` sin try/catch (mismo patrón que
    // BE-EML-03, ver conversations.service.ts ~línea 1178) DENTRO del handler que
    // `BrokerService.subscribe` corre por cada mensaje (conversations.service.ts). Ese handler
    // sólo tiene un try/catch que LOGUEA y nackea el mensaje (broker.service.ts ~línea 166-172):
    // nunca publica una respuesta de error por el canal RPC. Como /conversations/simulate espera
    // esa respuesta con `BrokerService.request`, un fallo acá deja al llamador colgado hasta
    // SIMULATE_TIMEOUT_MS = 300_000ms (5 minutos) antes de que el controller recién ahí devuelva
    // 504. Ejercitarlo de punta a punta por REST haría que este test tarde 5 minutos en fallar —
    // impracticable para la corrida de e2e. Hallazgo real para el plan: el "la conversación no
    // se rompe" que promete el escenario NO se cumple hoy para este camino específico (el fallo
    // del email cuelga la respuesta entera, no sólo el aviso).
  });

  it('BE-EML-05: enviar sin EMAIL_FROM configurado usa el remitente por defecto del sistema', async () => {
    const smtp = new SmtpEmailService(fakeConfig({ EMAIL_SMTP_HOST: 'smtp.interno.be-eml-05.test' }));

    await smtp.send({ to: 'persona@e2e.test', subject: 'Aviso', text: 'Cuerpo.' });

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.interno.be-eml-05.test', port: 587, secure: false }),
    );
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'no-reply@localhost', to: 'persona@e2e.test' }),
    );
  });

  it.skip('BE-EML-06: puerto y "conexión segura" tomados de la configuración (587/STARTTLS y 465/TLS) [BLOQUEADO: requiere un SMTP real vivo para confirmar que conecta de verdad con cada combinación]', () => {
    // El PASAJE de la config al transporter (buildTransporter lee EMAIL_SMTP_PORT/SECURE con
    // getNumber/getBoolean) se puede mockear, pero "también conecta" con 465+secure es, otra
    // vez, probar el mock. Queda documentado el mecanismo (cascada BD→env→default vía
    // AppConfigService.getNumber/getBoolean), sin un aserto de red real.
  });

  it.skip('BE-EML-07: host configurado sin usuario ni contraseña conecta sin autenticación (relay interno) [BLOQUEADO: requiere un SMTP real vivo]', () => {
    // `buildTransporter` arma `auth: user ? { user, pass } : undefined` — sin EMAIL_SMTP_USER,
    // nodemailer recibe `auth: undefined`. Confirmar que ESO "conecta igual" contra un servidor
    // real es justamente lo bloqueado.
  });

  it('BE-EML-08: la contraseña del servidor de correo (EMAIL_SMTP_PASS), leída desde /settings, viene enmascarada + isSet, nunca en claro', async () => {
    const { admin, tenant } = await getSystemContext(t.prisma);
    const token = tokenFor(t, admin);
    const plain = 'sup3r-secreta-be-eml-08';

    const post = await withAuth(http(t).post('/settings'), token, tenant.id).send({
      key: 'EMAIL_SMTP_PASS',
      value: plain,
    });
    // `@Post()` sin `@HttpCode` → 201 (default de Nest).
    expect(post.status).toBe(201);
    expect(post.body.value).not.toBe(plain);
    expect(post.body.isSet).toBe(true);

    const row = await t.prisma.setting.findUnique({ where: { key: 'EMAIL_SMTP_PASS' } });
    expect(row!.value.startsWith('enc:v1:')).toBe(true); // cifrada en BD, no en claro

    const get = await withAuth(http(t).get('/settings/EMAIL_SMTP_PASS'), token, tenant.id);
    expect(get.status).toBe(200);
    expect(get.body.isSet).toBe(true);
    expect(get.body.value).not.toBe(plain);
    expect(get.body.value).toContain('•'); // SecretsCipher.mask()
    expect(JSON.stringify(get.body)).not.toContain(plain);

    // Tampoco aparece en /settings (listado completo): mismo trato que cualquier otro secret.
    const list = await withAuth(http(t).get('/settings'), token, tenant.id);
    expect(JSON.stringify(list.body)).not.toContain(plain);
  });
});
