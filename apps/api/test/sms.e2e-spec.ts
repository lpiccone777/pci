/**
 * 1.21 Canal SMS — Twilio y Gupshup (BE-SMS-*)
 *
 * SMS es 100% SALIENTE (pedido de DEVELOPMENT, 2026-08-27: sin conversación bidireccional por
 * este canal) — no hay webhook de entrada ni cola `sms.incoming` para ningún proveedor;
 * `TwilioSmsWebhookController`/`GupshupSmsWebhookController` se eliminaron. Lo único que queda
 * es la salida: el nodo `sms` del editor publica en `sms.outgoing`, que consume
 * `TwilioSmsService`/`GupshupSmsService` según `SMS_PROVIDER` (ver `SmsModule`).
 *
 * Vía: `TwilioSmsService`/`GupshupSmsService`, llamado directo o vía `sms.outgoing` para los
 * casos de selección de proveedor.
 *
 * Frontera mockeada: `fetch`. El broker NO se mockea.
 *
 * Tres describes, cada uno con su propia app — mismo criterio que twilio/gupshup.e2e-spec.ts
 * (evitar que dos apps abiertas a la vez compitan por la misma cola del vhost efímero
 * compartido), con una app extra acá porque hay DOS selecciones de proveedor (Twilio y
 * Gupshup) en vez de una sola.
 */
import {
  createTestApp,
  TestApp,
  uniquePhone,
  setSetting,
  deleteSetting,
  installFetchMock,
} from './support';
import { PrismaService } from '../src/prisma/prisma.service';
import { BrokerService } from '../src/modules/broker/broker.service';
import { TwilioSmsService } from '../src/modules/sms/twilio-sms.service';
import { GupshupSmsService } from '../src/modules/sms/gupshup-sms.service';
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
// GupshupSmsService reusa las credenciales de WhatsApp Gupshup (2026-08-27: la cuenta legacy
// Enterprise SMS quedó con el alta rota) — no hay settings propios de SMS para Gupshup.
const GUPSHUP_API_KEY = 'gupshup-api-key-test';
const GUPSHUP_WHATSAPP_SOURCE = '15553788248';
const GUPSHUP_APP_NAME = 'dasyBotTest';

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
      expect(requests.some((r) => r.url.includes('api.gupshup.io'))).toBe(false);
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
    await setSetting(preboot, 'GUPSHUP_API_KEY', GUPSHUP_API_KEY);
    await setSetting(preboot, 'GUPSHUP_WHATSAPP_SOURCE', GUPSHUP_WHATSAPP_SOURCE);
    await setSetting(preboot, 'GUPSHUP_APP_NAME', GUPSHUP_APP_NAME);
    await preboot.$disconnect();

    t = await createTestApp();
  }, 30000);

  afterAll(async () => {
    await deleteSetting(t.prisma, 'SMS_PROVIDER');
    await deleteSetting(t.prisma, 'GUPSHUP_API_KEY');
    await deleteSetting(t.prisma, 'GUPSHUP_WHATSAPP_SOURCE');
    await deleteSetting(t.prisma, 'GUPSHUP_APP_NAME');
    await t.close();
  }, 30000);

  it('BE-SMS-03: arrancar con SMS_PROVIDER=gupshup suscribe solo a GupshupSmsService a sms.outgoing', async () => {
    const { requests, restore } = installFetchMock((url) => {
      if (url.includes('api.gupshup.io')) return { status: 202, body: { status: 'submitted', messageId: 'msgid1' } };
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
      expect(requests.every((r) => r.url.includes('api.gupshup.io'))).toBe(true);
      expect(requests.some((r) => r.url.includes('api.twilio.com'))).toBe(false);
    } finally {
      restore();
    }
  }, 15000);

  it.failing('BE-SMS-07: un menú de flujo enviado por Gupshup SMS debe anexar las opciones numeradas (robustez) @invertido', async () => {
    // Bug real documentado en el plan (sigue vigente tras el cambio de endpoint 2026-08-27):
    // `GupshupSmsService.handleOutgoing` desestructura `{ to, body }` de `msg.data` e ignora
    // `interactive` por completo — a diferencia de `TwilioSmsService`, que si recibe
    // `interactive` reconstruye la lista numerada (`appendInteractiveAsText`) antes de mandar
    // el SMS. El usuario que recibe un menú por Gupshup SMS hoy ve solo "Elegí una opción" sin
    // ninguna opción, y no sabe qué tipear.
    const interactive: WhatsAppInteractive = {
      type: 'button',
      body: 'Elegí una opción',
      buttons: [
        { id: 'opt_a', title: 'Opción A' },
        { id: 'opt_b', title: 'Opción B' },
      ],
    };
    const { requests, restore } = installFetchMock((url) =>
      url.includes('api.gupshup.io') ? { status: 202, body: { status: 'submitted', messageId: 'msgid2' } } : { status: 404 },
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

      // El body va urlencoded (POST), no en la query string — `message` es un JSON stringificado.
      const params = new URLSearchParams(requests[0].init!.body as string);
      const messageParam = JSON.parse(params.get('message') ?? '{}');
      const text = messageParam.text ?? '';

      // SEGURO: el texto mandado debería incluir las opciones numeradas (mismo criterio que
      // Twilio SMS). Hoy `text` es solo "Elegí una opción", sin ninguna opción listada.
      expect(text).toContain('1. Opción A');
      expect(text).toContain('2. Opción B');
    } finally {
      restore();
    }
  }, 15000);
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

  it('BE-SMS-10: Gupshup SMS (SEC-21, corregido con el cambio de endpoint 2026-08-27) no manda la API key por query string: va en el header apikey de un POST', async () => {
    await setSetting(t.prisma, 'GUPSHUP_API_KEY', GUPSHUP_API_KEY);
    await setSetting(t.prisma, 'GUPSHUP_WHATSAPP_SOURCE', GUPSHUP_WHATSAPP_SOURCE);
    await setSetting(t.prisma, 'GUPSHUP_APP_NAME', GUPSHUP_APP_NAME);
    const { requests, restore } = installFetchMock((url) =>
      url.includes('api.gupshup.io') ? { status: 202, body: { status: 'submitted', messageId: 'msgid' } } : { status: 404 },
    );
    try {
      await gupshupSms.sendText(uniquePhone(), 'texto de prueba');

      expect(requests).toHaveLength(1);
      const req = requests[0];

      // La API key no viaja en la URL (logs de proxies, historial): va en el header `apikey`
      // de un POST — el endpoint moderno (`api.gupshup.io`) ya no es el GET con query string
      // de la cuenta legacy Enterprise SMS que este caso documentaba.
      expect(req.url).not.toContain(GUPSHUP_API_KEY);
      expect(req.init?.method).toBe('POST');
      const headers = req.init?.headers as Record<string, string>;
      expect(headers.apikey).toBe(GUPSHUP_API_KEY);
    } finally {
      restore();
      await deleteSetting(t.prisma, 'GUPSHUP_API_KEY');
      await deleteSetting(t.prisma, 'GUPSHUP_WHATSAPP_SOURCE');
      await deleteSetting(t.prisma, 'GUPSHUP_APP_NAME');
    }
  });
});

