/**
 * 1.21 Canal SMS — Twilio y Gupshup (BE-SMS-*)
 *
 * SMS es un canal PROPIO, no un fallback de WhatsApp: colas propias (`sms.incoming`/
 * `sms.outgoing`) y `Conversation` con `channel:'sms'` independiente de la de `whatsapp` del
 * mismo usuario (ver `ConversationsService.handleMessage`, que resuelve la `Conversation` y la
 * cola de salida a partir de `channel`).
 *
 * Vía: `TwilioSmsWebhookController`/`GupshupSmsWebhookController` para la entrada,
 * `TwilioSmsService`/`GupshupSmsService` (llamado directo, o vía `sms.outgoing` para los casos
 * de selección de proveedor / BE-SMS-01) para la salida.
 *
 * Frontera mockeada: `fetch`. El broker y el motor de conversaciones NO se mockean.
 *
 * Cuatro describes, cada uno con su propia app — mismo criterio que twilio/gupshup.e2e-spec.ts
 * (evitar que dos apps abiertas a la vez compitan por la misma cola del vhost efímero
 * compartido), con dos apps extra acá porque hay DOS selecciones de proveedor (Twilio y
 * Gupshup) en vez de una sola.
 */
import {
  createTestApp,
  TestApp,
  http,
  createTenant,
  uniqueSlug,
  uniquePhone,
  setSetting,
  deleteSetting,
  installFetchMock,
  FakeLlmService,
} from './support';
import { PrismaService } from '../src/prisma/prisma.service';
import { BrokerService } from '../src/modules/broker/broker.service';
import { TwilioSmsService } from '../src/modules/sms/twilio-sms.service';
import { GupshupSmsService } from '../src/modules/sms/gupshup-sms.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { WhatsAppInteractive } from '../src/modules/whatsapp/whatsapp-interactive.types';

/** Ver el comentario completo en twilio.e2e-spec.ts. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor: la condición no se cumplió dentro de ${timeoutMs}ms`);
}

const TWILIO_ACCOUNT_SID = 'ACtest00000000000000000000000000';
const TWILIO_AUTH_TOKEN = 'authtoken-test';
const TWILIO_SMS_FROM = '+15005550006';
const GUPSHUP_SMS_USERID = 'gupshup-sms-user';
const GUPSHUP_SMS_PASSWORD = 'gupshup-sms-pass';

describe('1.21 Canal SMS, selección de proveedor — Twilio (BE-SMS-02)', () => {
  let t: TestApp;

  beforeAll(async () => {
    const preboot = new PrismaService();
    await preboot.$connect();
    await setSetting(preboot, 'SMS_PROVIDER', 'twilio');
    await setSetting(preboot, 'TWILIO_ACCOUNT_SID', TWILIO_ACCOUNT_SID);
    await setSetting(preboot, 'TWILIO_AUTH_TOKEN', TWILIO_AUTH_TOKEN);
    await setSetting(preboot, 'TWILIO_SMS_FROM', TWILIO_SMS_FROM);
    await preboot.$disconnect();

    t = await createTestApp();
  }, 30000);

  afterAll(async () => {
    await deleteSetting(t.prisma, 'SMS_PROVIDER');
    await deleteSetting(t.prisma, 'TWILIO_ACCOUNT_SID');
    await deleteSetting(t.prisma, 'TWILIO_AUTH_TOKEN');
    await deleteSetting(t.prisma, 'TWILIO_SMS_FROM');
    await t.close();
  }, 30000);

  it('BE-SMS-02: arrancar con SMS_PROVIDER=twilio suscribe solo a TwilioSmsService a sms.outgoing', async () => {
    const { requests, restore } = installFetchMock((url) => {
      if (url.includes('api.twilio.com')) return { status: 201, body: { sid: 'SM01' } };
      // Si GupshupSmsService también estuviera suscripto (bug), la request caería acá.
      return { status: 200, body: { ok: true } };
    });
    try {
      const broker = t.moduleRef.get(BrokerService);
      const to1 = uniquePhone();
      const to2 = uniquePhone();
      await broker.publish('sms.outgoing', {
        pattern: 'message.send',
        data: { to: to1, body: 'sms 1' },
        timestamp: new Date().toISOString(),
      });
      await broker.publish('sms.outgoing', {
        pattern: 'message.send',
        data: { to: to2, body: 'sms 2' },
        timestamp: new Date().toISOString(),
      });

      await waitFor(() => requests.length >= 2);
      await new Promise((r) => setTimeout(r, 200));

      expect(requests.length).toBe(2);
      expect(requests.every((r) => r.url.includes('api.twilio.com'))).toBe(true);
      expect(requests.some((r) => r.url.includes('enterprise.smsgupshup.com'))).toBe(false);
    } finally {
      restore();
    }
  }, 15000);
});

describe('1.21 Canal SMS, selección de proveedor — Gupshup (BE-SMS-03, BE-SMS-07)', () => {
  let t: TestApp;

  beforeAll(async () => {
    const preboot = new PrismaService();
    await preboot.$connect();
    await setSetting(preboot, 'SMS_PROVIDER', 'gupshup');
    await setSetting(preboot, 'GUPSHUP_SMS_USERID', GUPSHUP_SMS_USERID);
    await setSetting(preboot, 'GUPSHUP_SMS_PASSWORD', GUPSHUP_SMS_PASSWORD);
    await preboot.$disconnect();

    t = await createTestApp();
  }, 30000);

  afterAll(async () => {
    await deleteSetting(t.prisma, 'SMS_PROVIDER');
    await deleteSetting(t.prisma, 'GUPSHUP_SMS_USERID');
    await deleteSetting(t.prisma, 'GUPSHUP_SMS_PASSWORD');
    await t.close();
  }, 30000);

  it('BE-SMS-03: arrancar con SMS_PROVIDER=gupshup suscribe solo a GupshupSmsService a sms.outgoing', async () => {
    const { requests, restore } = installFetchMock((url) => {
      if (url.includes('enterprise.smsgupshup.com')) return { status: 200, body: 'success|1|msgid1' };
      return { status: 200, body: { ok: true } };
    });
    try {
      const broker = t.moduleRef.get(BrokerService);
      const to1 = uniquePhone();
      const to2 = uniquePhone();
      await broker.publish('sms.outgoing', {
        pattern: 'message.send',
        data: { to: to1, body: 'sms 1' },
        timestamp: new Date().toISOString(),
      });
      await broker.publish('sms.outgoing', {
        pattern: 'message.send',
        data: { to: to2, body: 'sms 2' },
        timestamp: new Date().toISOString(),
      });

      await waitFor(() => requests.length >= 2);
      await new Promise((r) => setTimeout(r, 200));

      expect(requests.length).toBe(2);
      expect(requests.every((r) => r.url.includes('enterprise.smsgupshup.com'))).toBe(true);
      expect(requests.some((r) => r.url.includes('api.twilio.com'))).toBe(false);
    } finally {
      restore();
    }
  }, 15000);

  it.failing('BE-SMS-07: un menú de flujo enviado por Gupshup SMS debe anexar las opciones numeradas (robustez)', async () => {
    // Bug real documentado en el plan: `GupshupSmsService.handleOutgoing` desestructura
    // `{ to, body }` de `msg.data` e ignora `interactive` por completo — a diferencia de
    // `TwilioSmsService`, que si recibe `interactive` reconstruye la lista numerada
    // (`appendInteractiveAsText`) antes de mandar el SMS. El usuario que recibe un menú por
    // Gupshup SMS hoy ve solo "Elegí una opción:" sin ninguna opción, y no sabe qué tipear.
    const interactive: WhatsAppInteractive = {
      type: 'button',
      body: 'Elegí una opción',
      buttons: [
        { id: 'opt_a', title: 'Opción A' },
        { id: 'opt_b', title: 'Opción B' },
      ],
    };
    const { requests, restore } = installFetchMock((url) =>
      url.includes('enterprise.smsgupshup.com') ? { status: 200, body: 'success|1|msgid2' } : { status: 404 },
    );
    try {
      const broker = t.moduleRef.get(BrokerService);
      const to = uniquePhone();
      await broker.publish('sms.outgoing', {
        pattern: 'message.send',
        data: { to, body: 'Elegí una opción', interactive },
        timestamp: new Date().toISOString(),
      });

      await waitFor(() => requests.length >= 1);
      await new Promise((r) => setTimeout(r, 200));

      const params = new URL(requests[0].url).searchParams;
      const text = params.get('msg') ?? '';

      // SEGURO: el texto mandado debería incluir las opciones numeradas (mismo criterio que
      // Twilio SMS). Hoy `text` es solo "Elegí una opción", sin ninguna opción listada.
      expect(text).toContain('1. Opción A');
      expect(text).toContain('2. Opción B');
    } finally {
      restore();
    }
  }, 15000);
});

describe('1.21 Canal SMS, webhook de entrada y aislamiento de canal (BE-SMS-01, BE-SMS-04, BE-SMS-05, BE-SMS-09)', () => {
  let t: TestApp;
  let broker: BrokerService;

  beforeAll(async () => {
    // Nunca se cargan credenciales de ningún proveedor en este describe (ver el comentario
    // equivalente en twilio.e2e-spec.ts): cualquier tráfico de fondo que dispare
    // ConversationsService (BE-SMS-01 publica directo a las colas de entrada; BE-SMS-04/05 lo
    // hacen indirecto, vía el webhook real) termina en un no-op silencioso del lado del
    // conector de salida, sin importar el timing entre tests.
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(new FakeLlmService().setReply('ok, gracias')),
    });
    broker = t.moduleRef.get(BrokerService);
  }, 30000);

  afterAll(async () => {
    // Ver el comentario equivalente en twilio.e2e-spec.ts: un margen chico antes de cerrar
    // evita dejar sin ackear las respuestas que `handleMessage` publica en `sms.outgoing` /
    // `whatsapp.outgoing` (TwilioSmsService / WhatsAppService por default, sin credenciales
    // acá, las consumen como no-op) — sin esto, RabbitMQ puede reencolarlas y otro archivo de
    // test que arranque después terminar recibiéndolas.
    await new Promise((r) => setTimeout(r, 300));
    await t.close();
  });

  it('BE-SMS-01: un mensaje channel:sms resuelve una Conversation propia del canal sms, distinta de la de whatsapp, y responde en sms.outgoing', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('sms01') });
    const phone = uniquePhone();
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      await broker.publish('sms.incoming', {
        pattern: 'message.received',
        data: { from: phone, body: 'Necesito ayuda con mi conexión', channel: 'sms' },
        tenantId: tenant.id,
        timestamp: new Date().toISOString(),
      });
      // Esperar el `Message` del asistente (no solo la `Conversation`, que se crea ANTES en el
      // pipeline): así el `handleMessage` de fondo ya terminó y ackeó el mensaje entrante antes
      // de seguir — mismo motivo que en BE-TWA-03 (evitar dejar trabajo en vuelo para `afterAll`).
      await waitFor(async () => {
        const msg = await t.prisma.message.findFirst({
          where: { conversation: { externalId: phone, channel: 'sms' }, senderType: 'assistant' },
        });
        return !!msg;
      });

      await broker.publish('whatsapp.incoming', {
        pattern: 'message.received',
        data: { from: phone, body: 'Necesito ayuda con mi conexión', channel: 'whatsapp' },
        tenantId: tenant.id,
        timestamp: new Date().toISOString(),
      });
      await waitFor(async () => {
        const msg = await t.prisma.message.findFirst({
          where: { conversation: { externalId: phone, channel: 'whatsapp' }, senderType: 'assistant' },
        });
        return !!msg;
      });

      const smsConversation = await t.prisma.conversation.findFirst({
        where: { tenantId: tenant.id, channel: 'sms' },
      });
      const waConversation = await t.prisma.conversation.findFirst({
        where: { tenantId: tenant.id, channel: 'whatsapp' },
      });

      expect(smsConversation).not.toBeNull();
      expect(waConversation).not.toBeNull();
      // Mismo usuario/teléfono, misma empresa — pero conversaciones DISTINTAS, una por canal.
      expect(smsConversation!.id).not.toBe(waConversation!.id);
      expect(smsConversation!.userId).toBe(waConversation!.userId);
      expect(smsConversation!.externalId).toBe(phone);

      // La respuesta de cada una va a `${channel}.outgoing`, no a una cola compartida.
      const smsReply = publishSpy.mock.calls.find(
        (c) => c[0] === 'sms.outgoing' && (c[1] as any).data?.to === phone,
      );
      const waReply = publishSpy.mock.calls.find(
        (c) => c[0] === 'whatsapp.outgoing' && (c[1] as any).data?.to === phone,
      );
      expect(smsReply).toBeDefined();
      expect(waReply).toBeDefined();
    } finally {
      publishSpy.mockRestore();
    }
  }, 15000);

  it('BE-SMS-04: POST webhooks/twilio-sms con texto responde 200 y publica {from, body, channel:sms} en sms.incoming', async () => {
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      const phone = uniquePhone();
      const res = await http(t)
        .post('/webhooks/twilio-sms')
        .type('form')
        .send({ From: phone, Body: 'Hola por SMS' });

      expect(res.status).toBe(200);
      const call = publishSpy.mock.calls.find((c) => c[0] === 'sms.incoming');
      expect(call).toBeDefined();
      expect((call![1] as any).data).toEqual({ from: phone, body: 'Hola por SMS', channel: 'sms' });

      await waitFor(async () => {
        const msg = await t.prisma.message.findFirst({
          where: { conversation: { externalId: phone, channel: 'sms' }, senderType: 'assistant' },
        });
        return !!msg;
      });
    } finally {
      publishSpy.mockRestore();
    }
  });

  it('BE-SMS-05: POST webhooks/gupshup-sms mapea best-effort phno/text a {from, body, channel:sms} en sms.incoming', async () => {
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      const phone = uniquePhone().replace('+', '');
      const res = await http(t).post('/webhooks/gupshup-sms').send({ phno: phone, text: 'Hola desde Gupshup SMS' });

      expect(res.status).toBe(200);
      const call = publishSpy.mock.calls.find((c) => c[0] === 'sms.incoming' && (c[1] as any).data?.from === phone);
      expect(call).toBeDefined();
      expect((call![1] as any).data).toEqual({ from: phone, body: 'Hola desde Gupshup SMS', channel: 'sms' });

      await waitFor(async () => {
        const msg = await t.prisma.message.findFirst({
          where: { conversation: { externalId: phone, channel: 'sms' }, senderType: 'assistant' },
        });
        return !!msg;
      });
    } finally {
      publishSpy.mockRestore();
    }
  });

  it('BE-SMS-05: POST webhooks/gupshup-sms también reconoce el par alternativo mobile/msg (mapeo best-effort)', async () => {
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      const phone = uniquePhone().replace('+', '');
      const res = await http(t).post('/webhooks/gupshup-sms').send({ mobile: phone, msg: 'Otro formato de campo' });

      expect(res.status).toBe(200);
      const call = publishSpy.mock.calls.find((c) => c[0] === 'sms.incoming' && (c[1] as any).data?.from === phone);
      expect(call).toBeDefined();
      expect((call![1] as any).data.body).toBe('Otro formato de campo');

      await waitFor(async () => {
        const msg = await t.prisma.message.findFirst({
          where: { conversation: { externalId: phone, channel: 'sms' }, senderType: 'assistant' },
        });
        return !!msg;
      });
    } finally {
      publishSpy.mockRestore();
    }
  });

  it.failing('BE-SMS-09: POST webhooks/twilio-sms sin firma debe rechazarse (SEC-16)', async () => {
    const phone = uniquePhone();
    const res = await http(t).post('/webhooks/twilio-sms').type('form').send({ From: phone, Body: 'sin firma' });

    // SEGURO: sin validar X-Twilio-Signature, debería rechazar (401/403). Hoy acepta cualquiera.
    expect([401, 403]).toContain(res.status);

    // Ver el comentario equivalente en twilio.e2e-spec.ts (BE-TWA-10): esperar el pipeline de
    // fondo evita dejar un mensaje sin ackear que RabbitMQ reencole hacia otro archivo.
    await waitFor(async () => {
      const msg = await t.prisma.message.findFirst({
        where: { conversation: { externalId: phone, channel: 'sms' }, senderType: 'assistant' },
      });
      return !!msg;
    });
  });

  it.failing('BE-SMS-09: POST webhooks/gupshup-sms sin autenticación debe rechazarse (SEC-16)', async () => {
    const phone = uniquePhone().replace('+', '');
    const res = await http(t).post('/webhooks/gupshup-sms').send({ phno: phone, text: 'sin autenticar' });

    // SEGURO: debería verificar el origen del POST antes de encolar. Hoy acepta cualquiera.
    expect([401, 403]).toContain(res.status);

    await waitFor(async () => {
      const msg = await t.prisma.message.findFirst({
        where: { conversation: { externalId: phone, channel: 'sms' }, senderType: 'assistant' },
      });
      return !!msg;
    });
  });
});

describe('1.21 Canal SMS, mecánica del conector (BE-SMS-06, BE-SMS-08, BE-SMS-10)', () => {
  let t: TestApp;
  let twilioSms: TwilioSmsService;
  let gupshupSms: GupshupSmsService;

  beforeAll(async () => {
    t = await createTestApp();
    twilioSms = t.moduleRef.get(TwilioSmsService);
    gupshupSms = t.moduleRef.get(GupshupSmsService);
  }, 30000);

  afterAll(async () => {
    await t.close();
  });

  it('BE-SMS-06: un menú enviado por Twilio SMS se degrada a texto numerado (sin prefijo whatsapp:)', async () => {
    await setSetting(t.prisma, 'TWILIO_ACCOUNT_SID', TWILIO_ACCOUNT_SID);
    await setSetting(t.prisma, 'TWILIO_AUTH_TOKEN', TWILIO_AUTH_TOKEN);
    await setSetting(t.prisma, 'TWILIO_SMS_FROM', TWILIO_SMS_FROM);
    const interactive: WhatsAppInteractive = {
      type: 'button',
      body: 'Elegí una opción',
      buttons: [
        { id: 'opt_a', title: 'Opción A' },
        { id: 'opt_b', title: 'Opción B' },
      ],
    };
    const { requests, restore } = installFetchMock((url) =>
      url.includes('api.twilio.com') ? { status: 201, body: { sid: 'SM06' } } : { status: 404 },
    );
    try {
      const to = uniquePhone();
      await twilioSms.sendText(to, 'Elegí una opción', interactive);

      expect(requests).toHaveLength(1); // SMS no tiene Content API: nunca hay una llamada previa
      const body = new URLSearchParams(requests[0].init!.body as string);
      expect(body.get('To')).toBe(to); // sin "whatsapp:" — a diferencia del canal WhatsApp
      const text = body.get('Body')!;
      expect(text).toContain('1. Opción A');
      expect(text).toContain('2. Opción B');
    } finally {
      restore();
      await deleteSetting(t.prisma, 'TWILIO_ACCOUNT_SID');
      await deleteSetting(t.prisma, 'TWILIO_AUTH_TOKEN');
      await deleteSetting(t.prisma, 'TWILIO_SMS_FROM');
    }
  });

  it('BE-SMS-08: Twilio SMS reusa TWILIO_ACCOUNT_SID/AUTH_TOKEN de WhatsApp y manda desde TWILIO_SMS_FROM', async () => {
    await setSetting(t.prisma, 'TWILIO_ACCOUNT_SID', TWILIO_ACCOUNT_SID);
    await setSetting(t.prisma, 'TWILIO_AUTH_TOKEN', TWILIO_AUTH_TOKEN);
    await setSetting(t.prisma, 'TWILIO_SMS_FROM', TWILIO_SMS_FROM);
    const { requests, restore } = installFetchMock((url) =>
      url.includes('api.twilio.com') ? { status: 201, body: { sid: 'SM08' } } : { status: 404 },
    );
    try {
      const to = uniquePhone();
      await twilioSms.sendText(to, 'texto simple sin menú');

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      );
      const body = new URLSearchParams(requests[0].init!.body as string);
      expect(body.get('From')).toBe(TWILIO_SMS_FROM); // sin "whatsapp:"
      expect(body.get('To')).toBe(to);
      const auth = requests[0].init!.headers as Record<string, string>;
      const decoded = Buffer.from((auth['Authorization'] as string).replace('Basic ', ''), 'base64').toString();
      expect(decoded).toBe(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
    } finally {
      restore();
      await deleteSetting(t.prisma, 'TWILIO_ACCOUNT_SID');
      await deleteSetting(t.prisma, 'TWILIO_AUTH_TOKEN');
      await deleteSetting(t.prisma, 'TWILIO_SMS_FROM');
    }
  });

  it.failing('BE-SMS-10: Gupshup SMS legacy NO debe mandar userid/password en la query string de un GET (SEC-21)', async () => {
    await setSetting(t.prisma, 'GUPSHUP_SMS_USERID', GUPSHUP_SMS_USERID);
    await setSetting(t.prisma, 'GUPSHUP_SMS_PASSWORD', GUPSHUP_SMS_PASSWORD);
    const { requests, restore } = installFetchMock((url) =>
      url.includes('enterprise.smsgupshup.com') ? { status: 200, body: 'success|1|msgid' } : { status: 404 },
    );
    try {
      await gupshupSms.sendText(uniquePhone(), 'texto de prueba');

      expect(requests).toHaveLength(1);
      const url = requests[0].url;

      // SEGURO: las credenciales no deberían viajar en la URL (logs de proxies, historial del
      // navegador, etc.) — deberían ir en el body de un POST, o al menos no como query de un
      // GET. Hoy `GupshupSmsService.sendText` hace `fetch(\`${BASE_URL}?${params}\`, {method:'GET'})`
      // con `userid`/`password` incluidos en esos mismos `params`.
      expect(url).not.toContain(`userid=${GUPSHUP_SMS_USERID}`);
      expect(url).not.toContain('password=');
    } finally {
      restore();
      await deleteSetting(t.prisma, 'GUPSHUP_SMS_USERID');
      await deleteSetting(t.prisma, 'GUPSHUP_SMS_PASSWORD');
    }
  });
});
