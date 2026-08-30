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
  createRole,
  createUser,
  createFlow,
  uniqueSlug,
  uniqueEmail,
  uniquePhone,
  setSetting,
  deleteSetting,
  installFetchMock,
  FakeLlmService,
  startNode,
  ticketCreateNode,
  endNode,
  edge,
} from './support';
import { PrismaService } from '../src/prisma/prisma.service';
import { BrokerService } from '../src/modules/broker/broker.service';
import { TwilioSmsService } from '../src/modules/sms/twilio-sms.service';
import { GupshupSmsService } from '../src/modules/sms/gupshup-sms.service';
import { TwilioMediaService } from '../src/common/twilio-media.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { WhatsAppInteractive } from '../src/modules/whatsapp/whatsapp-interactive.types';
import sharp from 'sharp';
import { mkdtemp, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHmac } from 'crypto';

/** Ver el comentario completo en twilio.e2e-spec.ts. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor: la condición no se cumplió dentro de ${timeoutMs}ms`);
}

/**
 * `installFetchMock` con canal BINARIO (el router puede devolver un `Buffer` como `body`, que
 * llega intacto a `res.arrayBuffer()`). Ver el comentario completo en twilio.e2e-spec.ts: el
 * `installFetchMock` compartido corrompe imágenes reales al serializarlas a string. Se usa para
 * bajar el MMS y volver a leer los adjuntos del disco. Sigue mockeando SOLO la frontera HTTP.
 */
function installBinaryFetchMock(
  router: (
    url: string,
    init?: RequestInit,
  ) => { status?: number; body?: Buffer | string; headers?: Record<string, string> },
) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    requests.push({ url, init });
    const res = router(url, init);
    const headers = new Headers(res.headers ?? {});
    return new Response((res.body ?? '') as BodyInit, { status: res.status ?? 200, headers });
  }) as unknown as typeof fetch);
  return { requests, restore: () => spy.mockRestore() };
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

  it.failing('BE-SMS-07: un menú de flujo enviado por Gupshup SMS debe anexar las opciones numeradas (robustez) @invertido', async () => {
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
      // El webhook SMS SIEMPRE arma `attachments` (feature de MMS): `extractMedia` devuelve `[]`
      // cuando no hay media y el controller lo incluye en el publish (ver TwilioSmsWebhookController).
      expect((call![1] as any).data).toEqual({ from: phone, body: 'Hola por SMS', channel: 'sms', attachments: [] });

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

  it('BE-SMS-05: POST webhooks/gupshup-sms mapea best-effort phno/text a {from, body, channel:sms} en sms.incoming, normalizando el número a +E.164', async () => {
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      // Gupshup manda el número SIN '+': el webhook lo normaliza a +E.164 al publicar, porque
      // `User.phone` se guarda con '+' y ahora es la clave del ruteo por membresía (sin esto,
      // ningún usuario registrado matcheaba y todos caían al tenant de los desconocidos).
      const rawPhone = uniquePhone().replace('+', '');
      const phone = `+${rawPhone}`;
      const res = await http(t).post('/webhooks/gupshup-sms').send({ phno: rawPhone, text: 'Hola desde Gupshup SMS' });

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
      const rawPhone = uniquePhone().replace('+', '');
      const phone = `+${rawPhone}`; // mismo normalizado a +E.164 que el caso phno/text
      const res = await http(t).post('/webhooks/gupshup-sms').send({ mobile: rawPhone, msg: 'Otro formato de campo' });

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

  it.failing('BE-SMS-09: POST webhooks/gupshup-sms sin autenticación debe rechazarse (SEC-16) @invertido', async () => {
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

/**
 * BE-SMS-09 (SMS Twilio, SEC-16, corregido): mismo `TwilioSignatureGuard` que el canal de
 * WhatsApp (ver twilio.e2e-spec.ts, BE-TWA-10) — describe aparte, con sus tres settings
 * propios, para no ensuciar "webhook de entrada", que deliberadamente nunca carga credenciales.
 */
describe('1.21 Canal SMS, verificación de firma del webhook de Twilio (BE-SMS-09, SEC-16)', () => {
  let t: TestApp;
  let broker: BrokerService;
  const publicUrl = 'https://miapp.e2e.test';

  /** Mismo algoritmo que `TwilioSignatureGuard.validateSignature`. */
  function computeSignature(fullUrl: string, params: Record<string, string>): string {
    let data = fullUrl;
    for (const key of Object.keys(params).sort()) data += key + params[key];
    return createHmac('sha1', TWILIO_AUTH_TOKEN).update(data, 'utf8').digest('base64');
  }

  beforeAll(async () => {
    const preboot = new PrismaService();
    await preboot.$connect();
    await setSetting(preboot, 'TWILIO_ACCOUNT_SID', TWILIO_ACCOUNT_SID);
    await setSetting(preboot, 'TWILIO_AUTH_TOKEN', TWILIO_AUTH_TOKEN);
    await setSetting(preboot, 'TWILIO_WEBHOOK_PUBLIC_URL', publicUrl);
    await preboot.$disconnect();

    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(new FakeLlmService().setReply('ok, gracias')),
    });
    broker = t.moduleRef.get(BrokerService);
  }, 30000);

  afterAll(async () => {
    await deleteSetting(t.prisma, 'TWILIO_ACCOUNT_SID');
    await deleteSetting(t.prisma, 'TWILIO_AUTH_TOKEN');
    await deleteSetting(t.prisma, 'TWILIO_WEBHOOK_PUBLIC_URL');
    await t.close();
  });

  it('BE-SMS-09a: sin header X-Twilio-Signature, se rechaza con 403', async () => {
    const res = await http(t)
      .post('/webhooks/twilio-sms')
      .type('form')
      .send({ From: uniquePhone(), Body: 'sin firma' });

    expect(res.status).toBe(403);
  });

  it('BE-SMS-09b: con una firma que no matchea, se rechaza con 403', async () => {
    const res = await http(t)
      .post('/webhooks/twilio-sms')
      .type('form')
      .set('X-Twilio-Signature', 'firma-inventada-a-mano')
      .send({ From: uniquePhone(), Body: 'firma trucha' });

    expect(res.status).toBe(403);
  });

  it('BE-SMS-09c: con la firma HMAC-SHA1 correcta, se acepta y procesa el mensaje', async () => {
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      const phone = uniquePhone();
      const params = { From: phone, Body: 'con firma valida' };
      const signature = computeSignature(`${publicUrl}/webhooks/twilio-sms`, params);

      const res = await http(t)
        .post('/webhooks/twilio-sms')
        .type('form')
        .set('X-Twilio-Signature', signature)
        .send(params);

      expect(res.status).toBe(200);
      const call = publishSpy.mock.calls.find(
        (c) => c[0] === 'sms.incoming' && (c[1] as any).data?.from === phone,
      );
      expect(call).toBeDefined();

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
      // `stripArgentinaMobileNine` saca el 9 de móvil AR (uniquePhone() da `+5491…`) — ver
      // BE-SMS-11 y phone.util.ts. Y sin "whatsapp:", a diferencia del canal WhatsApp.
      expect(body.get('To')).toBe(to.replace('+5491', '+541'));
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
      // `stripArgentinaMobileNine` saca el 9 de móvil AR (uniquePhone() da `+5491…`) — ver
      // BE-SMS-11 y phone.util.ts.
      expect(body.get('To')).toBe(to.replace('+5491', '+541'));
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

  it('BE-SMS-11: un móvil argentino guardado como +549… sale con el 9 removido (To); el From pasa por normalizeRecipient; un número no argentino cae a +digits', async () => {
    // El `To` de un SMS lo procesa `TwilioSmsService.sendText` con `stripArgentinaMobileNine`
    // (el mismo teléfono `+549…` que el nodo `sms` publica desde `recipient.phone`): el 9 de
    // móvil que WhatsApp exige, la red celular / Twilio SMS no lo quieren. El `From`
    // (TWILIO_SMS_FROM) pasa por `normalizeRecipient`. Se llama a `sendText` directo, como
    // BE-SMS-06/08, para probar la transformación sin el timing del broker.
    await setSetting(t.prisma, 'TWILIO_ACCOUNT_SID', TWILIO_ACCOUNT_SID);
    await setSetting(t.prisma, 'TWILIO_AUTH_TOKEN', TWILIO_AUTH_TOKEN);
    await setSetting(t.prisma, 'TWILIO_SMS_FROM', TWILIO_SMS_FROM);
    const { requests, restore } = installFetchMock((url) =>
      url.includes('api.twilio.com') ? { status: 201, body: { sid: 'SM11' } } : { status: 404 },
    );
    try {
      await twilioSms.sendText('+5491122223333', 'hola AR'); // móvil argentino con el 9
      await twilioSms.sendText('+447911123456', 'hello UK'); // no argentino

      expect(requests).toHaveLength(2);

      const arBody = new URLSearchParams(requests[0].init!.body as string);
      expect(arBody.get('To')).toBe('+541122223333'); // stripArgentinaMobileNine sacó el 9 de móvil
      expect(arBody.get('From')).toBe('+15005550006'); // normalizeRecipient(TWILIO_SMS_FROM)

      const ukBody = new URLSearchParams(requests[1].init!.body as string);
      expect(ukBody.get('To')).toBe('+447911123456'); // no argentino: +${digits}, sin tocar
    } finally {
      restore();
      await deleteSetting(t.prisma, 'TWILIO_ACCOUNT_SID');
      await deleteSetting(t.prisma, 'TWILIO_AUTH_TOKEN');
      await deleteSetting(t.prisma, 'TWILIO_SMS_FROM');
    }
  });

  it.failing('BE-SMS-10: Gupshup SMS legacy NO debe mandar userid/password en la query string de un GET (SEC-21) @invertido', async () => {
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

/**
 * MMS entrante (media por SMS) — reusa `TwilioMediaService` + `TwilioSmsWebhookController`.
 *
 * Mismo criterio que el describe de media de twilio.e2e-spec.ts: app propia con `FakeLlmService`,
 * credenciales de Twilio y `MEDIA_STORAGE_DIR` a un temporal por test. El teléfono se crea como
 * MIEMBRO de NUESTRO tenant (única empresa), así el ruteo por membresía resuelve ahí y corre su
 * flujo de inicio (start → ticket_create), donde los adjuntos se consumen.
 */
describe('1.21 Canal SMS, media entrante MMS (BE-SMS-12)', () => {
  let t: TestApp;
  let broker: BrokerService;
  let twilioMedia: TwilioMediaService;
  let mediaDir: string;

  beforeAll(async () => {
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(new FakeLlmService().setReply('ok')),
    });
    broker = t.moduleRef.get(BrokerService);
    twilioMedia = t.moduleRef.get(TwilioMediaService);
  }, 30000);

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 300));
    await t.close();
  });

  beforeEach(async () => {
    mediaDir = await mkdtemp(path.join(os.tmpdir(), 'pci-sms-media-'));
    await setSetting(t.prisma, 'TWILIO_ACCOUNT_SID', TWILIO_ACCOUNT_SID);
    await setSetting(t.prisma, 'TWILIO_AUTH_TOKEN', TWILIO_AUTH_TOKEN);
    await setSetting(t.prisma, 'MEDIA_STORAGE_DIR', mediaDir);
  });

  afterEach(async () => {
    await deleteSetting(t.prisma, 'TWILIO_ACCOUNT_SID');
    await deleteSetting(t.prisma, 'TWILIO_AUTH_TOKEN');
    await deleteSetting(t.prisma, 'MEDIA_STORAGE_DIR');
    await rm(mediaDir, { recursive: true, force: true });
  });

  it(
    'BE-SMS-12: un MMS con 2 imágenes reusa TwilioMediaService y ambas viajan al ticket_create como adjuntos',
    async () => {
      const tenant = await createTenant(t.prisma, { slug: uniqueSlug('sms12') });
      const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'SMS-12' });
      const phone = uniquePhone();
      const user = await createUser(t.prisma, {
        email: uniqueEmail('sms12'),
        phone,
        firstName: 'SMS12',
        memberships: [{ tenantId: tenant.id, roleId: role.id }],
      });
      await createFlow(t.prisma, {
        name: 'SMS-12',
        nodes: [startNode('s'), ticketCreateNode('tc', { subject: 'Adjuntos MMS' }), endNode('e')],
        edges: [edge('s', 'tc', 'known'), edge('tc', 'e')],
        assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
      });

      // Dos JPEG reales; el webhook de SMS reusa la misma descarga/resize/retención que WhatsApp.
      const img0 = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 10, b: 10 } } })
        .jpeg()
        .toBuffer();
      const img1 = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 10, g: 200, b: 10 } } })
        .jpeg()
        .toBuffer();
      const mock = installBinaryFetchMock((url) => (url.endsWith('ME1') ? { body: img1 } : { body: img0 }));
      const publishSpy = jest.spyOn(broker, 'publish');
      // Passthrough (sin mockImplementation): observamos que `ticket_create` lea los adjuntos,
      // sin reemplazar el comportamiento real de `TwilioMediaService` (frontera bajo prueba).
      const readSpy = jest.spyOn(twilioMedia, 'read');
      try {
        const res = await http(t)
          .post('/webhooks/twilio-sms')
          .type('form')
          .send({
            From: phone,
            Body: 'adjunto dos fotos',
            NumMedia: '2',
            MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages/MM12/Media/ME0`,
            MediaContentType0: 'image/jpeg',
            MediaUrl1: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages/MM12/Media/ME1`,
            MediaContentType1: 'image/jpeg',
          });
        expect(res.status).toBe(200);

        // Ambas imágenes se bajaron y viajan en sms.incoming.
        const inc = publishSpy.mock.calls.find(
          (c) => c[0] === 'sms.incoming' && (c[1] as any).data?.from === phone,
        );
        expect(inc).toBeDefined();
        expect((inc![1] as any).data.channel).toBe('sms');
        expect((inc![1] as any).data.attachments).toHaveLength(2);

        // La charla corre el flujo de inicio hasta ticket_create (crea el Ticket).
        await waitFor(async () => !!(await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenant.id } })));
        const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenant.id } });
        expect(ticket).not.toBeNull();

        // ticket_create → loadAttachments leyó (y consumió) los 2 adjuntos: prueba que llegaron.
        await waitFor(() => readSpy.mock.calls.length >= 2);
        expect(readSpy.mock.calls).toHaveLength(2);
      } finally {
        publishSpy.mockRestore();
        readSpy.mockRestore();
        mock.restore();
      }
    },
    20000,
  );
});
