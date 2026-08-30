/**
 * 2.3 Nodos del motor — `device_validation` (CHAT-N-DEV-*)
 *
 * OTP por EMAIL dentro del flujo (no confundir con el 2FA de login/AuthService, aunque
 * comparte esquema de generación). Verificado leyendo `executeDeviceValidationNode` y
 * `sendDeviceValidationCode` en `conversations.service.ts` (aprox. líneas 899-1010):
 *
 * - Sin email real (o `@local.pci` autogenerado por `findOrCreateByPhone`) → error y cierre.
 * - `flowState.__awaiting !== node.id` (primera llegada al nodo): busca `DeviceValidation` por
 *   `fingerprint = sha256("<phone>:<email.toLowerCase()>")`. Válido (mismo `userId`, `expiresAt`
 *   futuro) → nodo transparente (`{}`), sigue de largo. Si no → manda código nuevo.
 * - Esperando código: si `flowState.__deviceValidationExpiresAt` venció, reenvía uno nuevo
 *   (prefijo "Ese código venció, te mandamos uno nuevo. "). Si no venció y el código no matchea
 *   → "Ese código no es correcto. Fijate bien y volvé a escribirlo." (sigue esperando). Si
 *   matchea → upsert de `DeviceValidation` con `expiresAt = now + deviceFingerprintTtlDays()` y
 *   sigue a la próxima arista.
 * - El código sale por `EmailService.send` (texto: "Tu código de validación es: <code>. Válido
 *   por <mins> minutos.") — se lee con `t.email.codeFor(email)`.
 *
 * Flujo de fixture: start (rama 'known') → device_validation → message final. Todos los
 * usuarios de este spec son CONOCIDOS (tienen membership), así que siempre entran por la rama
 * 'known' del nodo start y llegan al nodo bajo prueba.
 *
 * Frontera mockeada: `EmailService` → `RecordingEmailService` (default de `createTestApp`,
 * ver `t.email`) y `LlmService` → `FakeLlmService` (no lo usa este nodo, pero se mockea igual
 * por si el pipeline lo invoca). El motor de flujos NO se mockea.
 */
import { createHash } from 'crypto';
import { LlmService } from '../src/modules/llm/llm.service';
import {
  createTestApp,
  TestApp,
  http,
  createTenant,
  createRole,
  createUser,
  createFlow,
  uniqueSlug,
  uniqueEmail,
  uniquePhone,
  setSetting,
  deleteSetting,
  FakeLlmService,
  startNode,
  deviceValidationNode,
  messageNode,
  edge,
} from './support';

describe('2.3 Nodos del motor — device_validation (CHAT-N-DEV-*)', () => {
  let t: TestApp;
  let llm: FakeLlmService;

  let tenant: { id: string };
  let role: { id: string };

  const FINAL_TEXT = 'Validación de dispositivo completa, seguimos.';
  const DEFAULT_MSG = (email: string) =>
    `Te mandamos un código de validación a ${email}. Escribime el código para continuar.`;

  /** Mismo hash que `computeDeviceFingerprint` (privado en el service): sha256(phone:email.toLowerCase()). */
  function fingerprintFor(phone: string, email: string): string {
    return createHash('sha256').update(`${phone}:${email.toLowerCase()}`).digest('hex');
  }

  function simulate(from: string, body = 'hola') {
    return http(t).post('/conversations/simulate').set('Authorization', `Bearer ${t.authToken}`).send({ from, body, tenantId: tenant.id });
  }

  /** Usuario conocido (con membership) para este tenant/rol, con email y teléfono propios. */
  async function createKnownUser(emailLabel: string) {
    const phone = uniquePhone();
    const email = uniqueEmail(emailLabel);
    const user = await createUser(t.prisma, {
      email,
      phone,
      firstName: 'Deví',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    return { user, phone, email };
  }

  beforeAll(async () => {
    llm = new FakeLlmService();
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(llm),
    });

    tenant = await createTenant(t.prisma, { slug: uniqueSlug('devval') });
    role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Con Device Validation' });

    await createFlow(t.prisma, {
      name: 'F-DEVICE-VALIDATION',
      nodes: [
        startNode('s'),
        deviceValidationNode('dv'),
        messageNode('m', FINAL_TEXT),
      ],
      edges: [edge('s', 'dv', 'known'), edge('dv', 'm')],
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    // Settings globales tocados por CHAT-N-DEV-06/08: no contaminar otros specs.
    await deleteSetting(t.prisma, 'OTP_TTL_SECONDS');
    await deleteSetting(t.prisma, 'OTP_CODE_LENGTH');
  });

  it('CHAT-N-DEV-01: usuario sin email real (placeholder @local.pci) recibe error y la charla se cierra', async () => {
    const phone = uniquePhone();
    // Mismo formato que genera `UsersService.findOrCreateByPhone` para altas por WhatsApp.
    const placeholderEmail = `whatsapp-${phone}@local.pci`;
    await createUser(t.prisma, {
      email: placeholderEmail,
      phone,
      firstName: 'SinEmail',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });

    const res = await simulate(phone);

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain(
      'No podemos validar este dispositivo porque no tenés un email registrado. ' +
        'Contactate con soporte para que te lo carguen.',
    );
    // No debería haber salido ningún código a ese "email".
    expect(t.email.lastTo(placeholderEmail)).toBeUndefined();

    const convo = await t.prisma.conversation.findFirst({
      where: { userId: (await t.prisma.user.findUniqueOrThrow({ where: { email: placeholderEmail } })).id },
      orderBy: { createdAt: 'desc' },
    });
    expect(convo?.status).toBe('closed');
  });

  it('CHAT-N-DEV-02: dispositivo ya validado y vigente pasa transparente (sin texto ni espera)', async () => {
    const { user, phone, email } = await createKnownUser('dev02');
    await t.prisma.deviceValidation.create({
      data: {
        userId: user.id,
        phone,
        email,
        fingerprint: fingerprintFor(phone, email),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // vigente
      },
    });

    const res = await simulate(phone);

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain(FINAL_TEXT);
    // Nada de texto de validación (ni el mensaje default, ni pedido de código).
    expect(res.body.reply).not.toContain('código de validación');
    expect(t.email.lastTo(email)).toBeUndefined();
  });

  it('CHAT-N-DEV-03: dispositivo no validado manda código por email y queda esperando', async () => {
    const { phone, email } = await createKnownUser('dev03');

    const res = await simulate(phone);

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain(DEFAULT_MSG(email));

    const code = t.email.codeFor(email);
    expect(code).toBeDefined();
    expect(code).toMatch(/^\d{6}$/); // OTP_CODE_LENGTH default = 6

    const sentMail = t.email.lastTo(email);
    expect(sentMail?.subject).toBe('Código de validación de dispositivo - Plataforma Conversacional Inteligente');
    expect(sentMail?.text).toContain(`Tu código de validación es: ${code}`);

    // Sigue esperando: no se cerró la charla ni se registró el device todavía.
    const registered = await t.prisma.deviceValidation.findUnique({ where: { fingerprint: fingerprintFor(phone, email) } });
    expect(registered).toBeNull();
  });

  it('CHAT-N-DEV-04: código correcto dentro del TTL registra el device y sigue al próximo nodo', async () => {
    const { user, phone, email } = await createKnownUser('dev04');

    await simulate(phone); // dispara el envío del código
    const code = t.email.codeFor(email)!;

    const res = await simulate(phone, code);

    expect(res.status).toBe(201);
    // Nodo transparente tras validar: la única respuesta es el mensaje final del flujo.
    expect(res.body.reply).toBe(FINAL_TEXT);

    const fingerprint = fingerprintFor(phone, email);
    const registered = await t.prisma.deviceValidation.findUniqueOrThrow({ where: { fingerprint } });
    expect(registered.userId).toBe(user.id);
    expect(registered.phone).toBe(phone);
    expect(registered.email).toBe(email);
    expect(registered.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // DEVICE_FINGERPRINT_TTL_DAYS default = 90.
    const daysLeft = (registered.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysLeft).toBeGreaterThan(89);
    expect(daysLeft).toBeLessThanOrEqual(90);
  });

  it('CHAT-N-DEV-05: código incorrecto responde el aviso de error y sigue esperando', async () => {
    const { phone, email } = await createKnownUser('dev05');

    await simulate(phone);
    const code = t.email.codeFor(email)!;
    const wrongCode = code === '000000' ? '111111' : '000000';

    const res = await simulate(phone, wrongCode);

    expect(res.status).toBe(201);
    expect(res.body.reply).toBe('Ese código no es correcto. Fijate bien y volvé a escribirlo.');

    // El código original sigue siendo válido: mandarlo ahora completa la validación.
    const followUp = await simulate(phone, code);
    expect(followUp.body.reply).toBe(FINAL_TEXT);
  });

  it('CHAT-N-DEV-06: código vencido mientras espera reenvía uno nuevo con el aviso de vencimiento', async () => {
    await setSetting(t.prisma, 'OTP_TTL_SECONDS', '0'); // vence apenas se genera
    const { phone, email } = await createKnownUser('dev06');

    const first = await simulate(phone);
    expect(first.body.reply).toContain(DEFAULT_MSG(email));
    expect(first.body.reply).not.toContain('venció');

    // Cualquier body sirve: para cuando llega este segundo mensaje, el TTL=0 ya venció.
    const second = await simulate(phone, '123456');

    expect(second.status).toBe(201);
    expect(second.body.reply).toBe('Ese código venció, te mandamos uno nuevo. ' + DEFAULT_MSG(email));

    // Se mandó un segundo email (el reenvío), no solo el primero.
    const sentToEmail = t.email.sent.filter((m) => m.to === email);
    expect(sentToEmail).toHaveLength(2);
    // Con OTP_TTL_SECONDS=0 hasta el código recién reenviado nace vencido (expiresAt = now+0),
    // así que un tercer mensaje con ESE código dispara otro reenvío en vez de validar — no es
    // forma de completar la charla con este TTL; ver CHAT-N-DEV-04 para el camino feliz.
    const thirdCode = t.email.codeFor(email)!;
    const third = await simulate(phone, thirdCode);
    expect(third.body.reply).toContain('Ese código venció, te mandamos uno nuevo.');
  });

  it('CHAT-N-DEV-07: dispositivo validado pero con otro userId no se da por válido, pide validar de nuevo', async () => {
    const { user, phone, email } = await createKnownUser('dev07');
    const decoy = await createUser(t.prisma, { email: uniqueEmail('decoy07'), phone: uniquePhone() });

    await t.prisma.deviceValidation.create({
      data: {
        userId: decoy.id, // OTRO usuario, mismo fingerprint (mismo phone+email del target)
        phone,
        email,
        fingerprint: fingerprintFor(phone, email),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const res = await simulate(phone);

    expect(res.status).toBe(201);
    // No pasa transparente: le pide validar como si no hubiera nada registrado.
    expect(res.body.reply).toContain(DEFAULT_MSG(email));
    expect(res.body.reply).not.toContain(FINAL_TEXT);

    // La fila existente sigue apuntando al decoy: todavía no se sobrescribió (recién se
    // sobrescribe cuando el usuario correcto manda el código, ver CHAT-N-DEV-04).
    const fingerprint = fingerprintFor(phone, email);
    const stillDecoy = await t.prisma.deviceValidation.findUniqueOrThrow({ where: { fingerprint } });
    expect(stillDecoy.userId).toBe(decoy.id);
    expect(stillDecoy.userId).not.toBe(user.id);
  });

  it('CHAT-N-DEV-08: OTP_CODE_LENGTH configurado en 5 hace que el código enviado tenga 5 dígitos', async () => {
    await setSetting(t.prisma, 'OTP_CODE_LENGTH', '5');
    const { phone, email } = await createKnownUser('dev08');

    const res = await simulate(phone);

    expect(res.status).toBe(201);
    const code = t.email.codeFor(email);
    expect(code).toBeDefined();
    expect(code).toMatch(/^\d{5}$/);
    expect(code!.length).toBe(5);

    // Y ese mismo código (de 5 dígitos) es el que completa la validación.
    const followUp = await simulate(phone, code!);
    expect(followUp.body.reply).toBe(FINAL_TEXT);
  });
});
