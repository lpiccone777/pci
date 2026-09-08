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
import { Logger } from '@nestjs/common';
import {
  createTestApp,
  TestApp,
  http,
  uniquePhone,
  uniqueEmail,
  uniqueSlug,
  createTenant,
  createRole,
  createUser,
  setSetting,
  deleteSetting,
  installFetchMock,
  FakeLlmService,
} from './support';
import { PrismaService } from '../src/prisma/prisma.service';
import { BrokerService } from '../src/modules/broker/broker.service';
import { LlmService } from '../src/modules/llm/llm.service';
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
// GupshupSmsService comparte la API key con WhatsApp (es de la cuenta, no del canal) pero tiene
// su propia app: el endpoint de SMS (`/sms/v1/message/{appId}`) va por UUID, no por nombre.
const GUPSHUP_API_KEY = 'gupshup-api-key-test';
const GUPSHUP_SMS_APP_ID = 'd7233f89-bf13-27e4-70d1-a981b1427249';

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
    await setSetting(preboot, 'GUPSHUP_SMS_APP_ID', GUPSHUP_SMS_APP_ID);
    await preboot.$disconnect();

    t = await createTestApp();
  }, 30000);

  afterAll(async () => {
    await deleteSetting(t.prisma, 'SMS_PROVIDER');
    await deleteSetting(t.prisma, 'GUPSHUP_API_KEY');
    await deleteSetting(t.prisma, 'GUPSHUP_SMS_APP_ID');
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

  it('BE-SMS-10: Gupshup SMS (SEC-21, corregido con el cambio de endpoint 2026-08-27) no manda la API key por query string: va en el header Authorization de un POST', async () => {
    await setSetting(t.prisma, 'GUPSHUP_API_KEY', GUPSHUP_API_KEY);
    await setSetting(t.prisma, 'GUPSHUP_SMS_APP_ID', GUPSHUP_SMS_APP_ID);
    const { requests, restore } = installFetchMock((url) =>
      url.includes('api.gupshup.io') ? { status: 202, body: { status: 'submitted', messageId: 'msgid' } } : { status: 404 },
    );
    try {
      await gupshupSms.sendText(uniquePhone(), 'texto de prueba');

      expect(requests).toHaveLength(1);
      const req = requests[0];

      // La API key no viaja en la URL (logs de proxies, historial): va en el header
      // `Authorization` de un POST — el endpoint moderno (`api.gupshup.io`) ya no es el GET con
      // query string de la cuenta legacy Enterprise SMS que este caso documentaba.
      expect(req.url).not.toContain(GUPSHUP_API_KEY);
      expect(req.init?.method).toBe('POST');
      const headers = req.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(GUPSHUP_API_KEY);
    } finally {
      restore();
      await deleteSetting(t.prisma, 'GUPSHUP_API_KEY');
      await deleteSetting(t.prisma, 'GUPSHUP_SMS_APP_ID');
    }
  });

  it('BE-SMS-10b: Gupshup SMS pega al endpoint de SMS (/sms/v1/message/{appId}), NO al de WhatsApp (/wa/api/v1/msg)', async () => {
    // Regresión del 2026-08-31: pegarle a `/wa/api/v1/msg` con `channel: 'sms'` devuelve 202
    // pero Gupshup entrega el mensaje por WhatsApp, no como SMS (confirmado con tráfico real).
    await setSetting(t.prisma, 'GUPSHUP_API_KEY', GUPSHUP_API_KEY);
    await setSetting(t.prisma, 'GUPSHUP_SMS_APP_ID', GUPSHUP_SMS_APP_ID);
    const { requests, restore } = installFetchMock((url) =>
      url.includes('api.gupshup.io') ? { status: 202, body: { status: 'submitted', messageId: 'msgid' } } : { status: 404 },
    );
    try {
      await gupshupSms.sendText('+5491158855098', 'texto de prueba');

      expect(requests).toHaveLength(1);
      const req = requests[0];

      expect(req.url).toBe(`https://api.gupshup.io/sms/v1/message/${GUPSHUP_SMS_APP_ID}`);
      expect(req.url).not.toContain('/wa/');

      // Cuerpo del SMS: `message` es texto plano, no el JSON `{type,text}` de WhatsApp, y no
      // viaja ningún `channel` (era el parámetro que Gupshup ignoraba).
      const body = new URLSearchParams(req.init?.body as string);
      expect(body.get('destination')).toBe('5491158855098');
      expect(body.get('message')).toBe('texto de prueba');
      expect(body.get('channel')).toBeNull();
      expect(body.get('src.name')).toBeNull();
    } finally {
      restore();
      await deleteSetting(t.prisma, 'GUPSHUP_API_KEY');
      await deleteSetting(t.prisma, 'GUPSHUP_SMS_APP_ID');
    }
  });

  it('BE-SMS-13: la request de salida lleva el appId en la URL, la API key en el header y el source solo si está configurado', async () => {
    // ⚠️ Verificado contra el código y la documentación de Gupshup, NO contra tráfico real: la
    // documentación no lista Argentina entre los destinos permitidos de esta API.
    await setSetting(t.prisma, 'GUPSHUP_API_KEY', GUPSHUP_API_KEY);
    await setSetting(t.prisma, 'GUPSHUP_SMS_APP_ID', GUPSHUP_SMS_APP_ID);
    const gupshup = t.moduleRef.get(GupshupSmsService);
    const { requests, restore } = installFetchMock(() => ({ status: 202, body: { status: 'submitted' } }));
    try {
      await gupshup.sendText(uniquePhone(), 'sin sender id');

      const req = requests[0];
      expect(req.url).toBe(`https://api.gupshup.io/sms/v1/message/${GUPSHUP_SMS_APP_ID}`);
      // Endpoint de SMS, no el de WhatsApp: pegarle al de WhatsApp con channel:'sms' devolvía
      // 202 "submitted" y entregaba el mensaje POR WHATSAPP (roto entre el 27/08 y el 31/08).
      expect(req.url).not.toContain('/wa/api/v1/msg');
      const headers = req.init!.headers as Record<string, string>;
      expect(headers.Authorization).toBe(GUPSHUP_API_KEY);
      expect(headers.apikey).toBeUndefined(); // ese es el header del canal de WhatsApp
      // Sin GUPSHUP_SMS_SOURCE configurado, no se manda un sender id vacío.
      expect(new URLSearchParams(req.init!.body as string).get('source')).toBeNull();

      await setSetting(t.prisma, 'GUPSHUP_SMS_SOURCE', 'PCIBOT');
      await gupshup.sendText(uniquePhone(), 'con sender id');
      expect(new URLSearchParams(requests[1].init!.body as string).get('source')).toBe('PCIBOT');
    } finally {
      restore();
      await deleteSetting(t.prisma, 'GUPSHUP_API_KEY');
      await deleteSetting(t.prisma, 'GUPSHUP_SMS_APP_ID');
      await deleteSetting(t.prisma, 'GUPSHUP_SMS_SOURCE');
    }
  });

  it('BE-SMS-14: sin API key o sin App ID, avisa nombrando el grupo de cada clave, no envía y no rompe el consumer', async () => {
    const gupshup = t.moduleRef.get(GupshupSmsService);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { requests, restore } = installFetchMock(() => ({ status: 202, body: {} }));
    try {
      // Sin ninguna de las dos.
      await expect(gupshup.sendText(uniquePhone(), 'sin credenciales')).resolves.toBeUndefined();

      // Con la API key pero sin el App ID: el error de carga esperable, porque viven en
      // pestañas distintas de /settings.
      await setSetting(t.prisma, 'GUPSHUP_API_KEY', GUPSHUP_API_KEY);
      await expect(gupshup.sendText(uniquePhone(), 'sin app id')).resolves.toBeUndefined();

      expect(requests).toHaveLength(0);
      const mensajes = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(mensajes).toContain('GUPSHUP_API_KEY');
      expect(mensajes).toContain('GUPSHUP_SMS_APP_ID');
      // Cada clave nombra el grupo de /settings donde vive.
      expect(mensajes).toContain('Mensajería: WhatsApp (Gupshup)');
      expect(mensajes).toContain('Mensajería: SMS (Gupshup)');
    } finally {
      warnSpy.mockRestore();
      restore();
      await deleteSetting(t.prisma, 'GUPSHUP_API_KEY');
    }
  });
});

/**
 * SMS como canal 100% SALIENTE: no hay webhooks ni cola de entrada. Los casos que antes
 * describían la entrada (BE-SMS-09/12) ahora verifican que esa superficie no existe.
 */
describe('1.21 Canal SMS, canal saliente y superficie de entrada eliminada (BE-SMS-01, 04, 05, 09, 12)', () => {
  let t: TestApp;
  let broker: BrokerService;
  let tenantId: string;
  let phone: string;

  beforeAll(async () => {
    t = await createTestApp({
      customize: (b) =>
        b.overrideProvider(LlmService).useValue(new FakeLlmService().setReply('respuesta del bot')),
    });
    broker = t.moduleRef.get(BrokerService);
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('sms-canal') });
    tenantId = tenant.id;
    const role = await createRole(t.prisma, { tenantId, name: 'Rol SMS' });
    phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('sms-canal'),
      phone,
      memberships: [{ tenantId, roleId: role.id }],
    });
  }, 30000);

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 300));
    await t.close();
  });

  it('BE-SMS-01: un mensaje con channel:"sms" abre su propia conversación y su respuesta va a sms.outgoing', async () => {
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      // Se publica SIN `replyTo` (como un canal real, no como `/simulate`): con `replyTo` la
      // respuesta vuelve por la cola RPC y nunca se ve el ruteo a `${channel}.outgoing`, que es
      // justo lo que este caso verifica.
      for (const channel of ['sms', 'whatsapp']) {
        await broker.publish('whatsapp.incoming', {
          pattern: 'message.received',
          data: { from: phone, body: `hola por ${channel}`, channel },
          tenantId,
          timestamp: new Date().toISOString(),
        });
      }

      await waitFor(async () => {
        const convs = await t.prisma.conversation.findMany({ where: { tenantId, user: { phone } } });
        return convs.length === 2;
      }, 15000);

      const conversaciones = await t.prisma.conversation.findMany({
        where: { tenantId, user: { phone } },
      });
      // Una conversación por canal, independientes entre sí.
      expect(conversaciones.map((c) => c.channel).sort()).toEqual(['sms', 'whatsapp']);

      // La respuesta del canal sms se rutea a `${channel}.outgoing`.
      await waitFor(() => publishSpy.mock.calls.some((c) => c[0] === 'sms.outgoing'), 15000);
    } finally {
      publishSpy.mockRestore();
    }
  }, 30000);

  it('BE-SMS-04: los webhooks de SMS ya no existen — POST a sus rutas devuelve 404', async () => {
    for (const ruta of ['/webhooks/twilio-sms', '/webhooks/gupshup-sms']) {
      const res = await http(t).post(ruta).type('form').send({ From: phone, Body: 'entrante' });
      expect(res.status).toBe(404);
    }
  });

  it('BE-SMS-09: no hay ninguna superficie de entrada de SMS que necesite verificación de firma', async () => {
    // Esta parte de SEC-16 se cerró por ELIMINACIÓN de la superficie, no agregando un guard:
    // ninguna variante de ruta de SMS entrante responde.
    for (const ruta of ['/webhooks/sms', '/webhooks/twilio/sms', '/webhooks/gupshup/sms']) {
      const res = await http(t).post(ruta).send({});
      expect(res.status).toBe(404);
    }
  });

  it('BE-SMS-12: sin webhook de entrada no hay MMS que procesar', async () => {
    // Un MMS entrante llegaría por el webhook de SMS, que ya no existe: la descarga de media
    // sigue viva solo para WhatsApp (BE-TWA-12/13, BE-GUP-08).
    const res = await http(t)
      .post('/webhooks/twilio-sms')
      .type('form')
      .send({ From: phone, Body: '', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/x.jpg' });

    expect(res.status).toBe(404);
  });

  it('BE-SMS-05: publicar en la cola histórica sms.incoming no tiene efecto (nadie la consume)', async () => {
    const antes = await t.prisma.conversation.count({ where: { tenantId } });

    await broker.publish('sms.incoming', {
      pattern: 'message.received',
      data: { from: phone, body: 'mensaje a la cola muerta', channel: 'sms' },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 500));

    // El mensaje se acumula en la cola sin efecto: ni conversación nueva ni Message nuevo.
    expect(await t.prisma.conversation.count({ where: { tenantId } })).toBe(antes);
    const mensajes = await t.prisma.message.findMany({
      where: { conversation: { tenantId }, content: 'mensaje a la cola muerta' },
    });
    expect(mensajes).toHaveLength(0);
  });
});

