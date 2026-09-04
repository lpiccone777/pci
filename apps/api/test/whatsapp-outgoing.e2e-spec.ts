/**
 * 1.13 Conector de salida de WhatsApp — `WhatsAppService` (BE-WAO-*)
 *
 * Vía: `WhatsAppService` real (`t.moduleRef.get(WhatsAppService)`). Con `WHATSAPP_PROVIDER` en
 * su default ('meta'), es el único conector suscripto a `whatsapp.outgoing` — Twilio y Gupshup
 * se verifican a sí mismos que NO son el proveedor activo y no se suscriben (ver
 * `twilio-whatsapp.service.ts`/`gupshup-whatsapp.service.ts`, mismo chequeo invertido), así que
 * no compiten por la cola.
 *
 * Frontera mockeada: SOLO el `fetch` global hacia `graph.facebook.com` (`installFetchMock`,
 * la Cloud API de Meta). BE-WAO-02 a BE-WAO-09 llaman a `sendText()` directamente — tal cual lo
 * describe el propio plan de pruebas para esos casos ("sendText sin...", "sendText de texto
 * libre...") — porque lo que hay que verificar ahí es la mecánica del conector (payload,
 * headers, manejo de error), no el enrutamiento de la cola. BE-WAO-01 es el único que prueba
 * justamente ESE enrutamiento: encola de verdad en `whatsapp.outgoing` con el `BrokerService`
 * real y observa (con un `jest.spyOn` passthrough, sin `mockImplementation`) que
 * `WhatsAppService` consume el mensaje y llama a `sendText` con los argumentos correctos.
 */
import { createTestApp, TestApp, setSetting, deleteSetting, installFetchMock } from './support';
import { BrokerService } from '../src/modules/broker/broker.service';
import { WhatsAppService } from '../src/modules/whatsapp/whatsapp.service';
import { WhatsAppInteractive } from '../src/modules/whatsapp/whatsapp-interactive.types';
import { AppConfigService } from '../src/config/app-config.service';
import { PrismaService } from '../src/prisma/prisma.service';

const TOKEN = 'token-e2e-wao';
const PHONE_ID = '999888777';

async function setCredentials(prisma: PrismaService): Promise<void> {
  await setSetting(prisma, 'WHATSAPP_API_TOKEN', TOKEN);
  await setSetting(prisma, 'WHATSAPP_PHONE_NUMBER_ID', PHONE_ID);
}

/** Sondeo corto (sin timers largos) para esperar que un jest.fn/spy haya sido llamado. */
async function waitForCalls(fn: jest.SpyInstance, min = 1, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (fn.mock.calls.length < min) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout esperando ${min} llamada(s) (hubo ${fn.mock.calls.length})`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('1.13 Conector de salida de WhatsApp (BE-WAO-*)', () => {
  let t: TestApp;
  let service: WhatsAppService;
  let broker: BrokerService;

  beforeAll(async () => {
    // `WHATSAPP_PROVIDER` es un Setting global (`Setting.key` único) que decide, leído UNA sola
    // vez en `onModuleInit`, cuál conector se suscribe a whatsapp.outgoing. Este spec asume el
    // default ('meta'/sin fila) para que sea justamente `WhatsAppService` el que se suscriba —
    // hay que garantizarlo ANTES de levantar la app (después ya es tarde: onModuleInit ya corrió).
    // Sin este borrado, un resabio de otro spec (gupshup.e2e-spec.ts/twilio.e2e-spec.ts, que
    // también tocan esta key) que no haya llegado a limpiar la suya —p. ej. por su propio test
    // fallando antes de tiempo— dejaría a WhatsAppService sin suscribirse acá, y BE-WAO-01
    // (la única prueba que depende de esa suscripción) se cuelga hasta su propio timeout.
    const preboot = new PrismaService();
    await preboot.$connect();
    await preboot.setting.deleteMany({ where: { key: 'WHATSAPP_PROVIDER' } });
    await preboot.$disconnect();

    t = await createTestApp();
    service = t.moduleRef.get(WhatsAppService);
    broker = t.moduleRef.get(BrokerService);
  });

  afterAll(async () => {
    await t.close();
  });

  afterEach(async () => {
    await deleteSetting(t.prisma, 'WHATSAPP_API_TOKEN');
    await deleteSetting(t.prisma, 'WHATSAPP_PHONE_NUMBER_ID');
    await deleteSetting(t.prisma, 'WHATSAPP_API_VERSION');
    await deleteSetting(t.prisma, 'WHATSAPP_SANDBOX_RECIPIENT_OVERRIDES');
  });

  it('BE-WAO-01: encolar en whatsapp.outgoing hace que WhatsAppService lo consuma y llame a sendText(to, body, interactive?)', async () => {
    // Sin credenciales: si quedara un token cargado por algún resabio, sendText no debe pegarle
    // a la red real — el mock de fetch es red de seguridad (no debería usarse: BE-WAO-02 ya
    // prueba que sin credenciales no se llega a llamar fetch).
    await deleteSetting(t.prisma, 'WHATSAPP_API_TOKEN');
    await deleteSetting(t.prisma, 'WHATSAPP_PHONE_NUMBER_ID');
    const fetchMock = installFetchMock(() => ({ status: 200, body: { messages: [{ id: 'wamid.no-deberia-llamarse' }] } }));
    const sendTextSpy = jest.spyOn(service, 'sendText'); // passthrough: NO reemplaza el método real
    try {
      const to = '+5491100000010';
      const body = 'Hola desde la cola';

      const sent = await broker.publish('whatsapp.outgoing', {
        pattern: 'message.send',
        data: { to, body },
        tenantId: 'tenant-e2e-wao01',
        timestamp: new Date().toISOString(),
      });
      expect(sent).toBe(true);

      await waitForCalls(sendTextSpy);

      expect(sendTextSpy).toHaveBeenCalledWith(to, body, undefined);
      expect(fetchMock.requests).toHaveLength(0); // sin credenciales, sendText no llegó a pegarle a Meta
    } finally {
      sendTextSpy.mockRestore();
      fetchMock.restore();
    }
  });

  it('BE-WAO-02: sendText sin WHATSAPP_API_TOKEN ni WHATSAPP_PHONE_NUMBER_ID no lanza y no llama a fetch (warn y listo)', async () => {
    const appConfig = t.moduleRef.get(AppConfigService);
    const [token, phoneId] = await Promise.all([
      appConfig.get('WHATSAPP_API_TOKEN'),
      appConfig.get('WHATSAPP_PHONE_NUMBER_ID'),
    ]);
    expect(token).toBeFalsy(); // precondición: nada seteado en BD ni en env para este caso
    expect(phoneId).toBeFalsy();

    const fetchMock = installFetchMock(() => ({
      status: 200,
      body: { messages: [{ id: 'wamid.no-deberia-llamarse' }] },
    }));
    try {
      await expect(service.sendText('+5491100000011', 'hola')).resolves.toBeUndefined();
      expect(fetchMock.requests).toHaveLength(0);
    } finally {
      fetchMock.restore();
    }
  });

  it('BE-WAO-03: sendText de texto libre con credenciales hace POST con Authorization Bearer y payload {type:text, text:{body}}', async () => {
    await setCredentials(t.prisma);
    const fetchMock = installFetchMock(() => ({ status: 200, body: { messages: [{ id: 'wamid.03' }] } }));
    try {
      await service.sendText('+5491100000012', 'Hola, este es un texto libre');

      expect(fetchMock.requests).toHaveLength(1);
      const req = fetchMock.requests[0];
      expect(req.url).toBe(`https://graph.facebook.com/v26.0/${PHONE_ID}/messages`);
      const headers = req.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(req.init?.body as string);
      expect(body).toEqual({
        messaging_product: 'whatsapp',
        to: '5491100000012',
        type: 'text',
        text: { body: 'Hola, este es un texto libre' },
      });
    } finally {
      fetchMock.restore();
    }
  });

  it('BE-WAO-04: sendText interactivo de botones arma type:button con action.buttons[].reply{id,title}', async () => {
    await setCredentials(t.prisma);
    const fetchMock = installFetchMock(() => ({ status: 200, body: { messages: [{ id: 'wamid.04' }] } }));
    try {
      const interactive: WhatsAppInteractive = {
        type: 'button',
        body: '¿Confirmás la reserva?',
        buttons: [
          { id: 'si', title: 'Sí' },
          { id: 'no', title: 'No' },
        ],
      };

      await service.sendText('+5491100000013', 'texto ignorado cuando hay interactive', interactive);

      const body = JSON.parse(fetchMock.requests[0].init?.body as string);
      expect(body.type).toBe('interactive');
      expect(body.interactive).toEqual({
        type: 'button',
        body: { text: '¿Confirmás la reserva?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'si', title: 'Sí' } },
            { type: 'reply', reply: { id: 'no', title: 'No' } },
          ],
        },
      });
    } finally {
      fetchMock.restore();
    }
  });

  it('BE-WAO-05: sendText interactivo de lista arma type:list con action.button + sections[0].rows[]', async () => {
    await setCredentials(t.prisma);
    const fetchMock = installFetchMock(() => ({ status: 200, body: { messages: [{ id: 'wamid.05' }] } }));
    try {
      const interactive: WhatsAppInteractive = {
        type: 'list',
        body: 'Elegí una opción',
        buttonText: 'Ver opciones',
        rows: [
          { id: 'op1', title: 'Opción 1', description: 'Primera opción' },
          { id: 'op2', title: 'Opción 2' },
        ],
      };

      await service.sendText('+5491100000014', 'texto ignorado cuando hay interactive', interactive);

      const body = JSON.parse(fetchMock.requests[0].init?.body as string);
      expect(body.type).toBe('interactive');
      expect(body.interactive).toEqual({
        type: 'list',
        body: { text: 'Elegí una opción' },
        action: {
          button: 'Ver opciones',
          sections: [
            {
              rows: [
                { id: 'op1', title: 'Opción 1', description: 'Primera opción' },
                { id: 'op2', title: 'Opción 2' },
              ],
            },
          ],
        },
      });
    } finally {
      fetchMock.restore();
    }
  });

  it('BE-WAO-06: resolveRecipient mapea con WHATSAPP_SANDBOX_RECIPIENT_OVERRIDES y normaliza a E.164 sin override', async () => {
    await setCredentials(t.prisma);
    await setSetting(t.prisma, 'WHATSAPP_SANDBOX_RECIPIENT_OVERRIDES', '5491158855098:54111558855098');
    const fetchMock = installFetchMock(() => ({ status: 200, body: { messages: [{ id: 'wamid.06' }] } }));
    try {
      // Con override: el número normalizado matchea la clave del override.
      await service.sendText('+549 11 5885-5098', 'con override');
      const body1 = JSON.parse(fetchMock.requests[0].init?.body as string);
      expect(body1.to).toBe('54111558855098');

      // Sin override: normaliza a solo dígitos (E.164 sin "+" ni separadores).
      await service.sendText('+549 11 1234-5678', 'sin override');
      const body2 = JSON.parse(fetchMock.requests[1].init?.body as string);
      expect(body2.to).toBe('5491112345678');
    } finally {
      fetchMock.restore();
    }
  });

  it('BE-WAO-07: si la API de WhatsApp no responde (timeout/error de red), sendText loguea y lanza', async () => {
    await setCredentials(t.prisma);
    const fetchMock = installFetchMock(() => {
      throw new Error('network timeout simulado (AbortError)');
    });
    try {
      await expect(service.sendText('+5491100000015', 'hola')).rejects.toThrow();
      expect(fetchMock.requests).toHaveLength(1); // el intento se hizo antes de fallar
    } finally {
      fetchMock.restore();
    }
  });

  it('BE-WAO-08: si la API de WhatsApp responde no-ok, sendText loguea el status y lanza "WhatsApp API error <status>"', async () => {
    await setCredentials(t.prisma);
    const fetchMock = installFetchMock(() => ({
      status: 400,
      body: { error: { message: 'Recipient phone number not in allowed list', code: 131030 } },
    }));
    try {
      await expect(service.sendText('+5491100000016', 'hola')).rejects.toThrow('WhatsApp API error 400');
      expect(fetchMock.requests).toHaveLength(1);
    } finally {
      fetchMock.restore();
    }
  });

  it('BE-WAO-09: sin WHATSAPP_API_VERSION configurada, usa v26.0 por defecto en la URL', async () => {
    await setCredentials(t.prisma); // sin setear WHATSAPP_API_VERSION
    const appConfig = t.moduleRef.get(AppConfigService);
    expect(await appConfig.get('WHATSAPP_API_VERSION')).toBeFalsy(); // precondición: nada en BD/env

    const fetchMock = installFetchMock(() => ({ status: 200, body: { messages: [{ id: 'wamid.09' }] } }));
    try {
      await service.sendText('+5491100000017', 'hola');
      expect(fetchMock.requests[0].url).toBe(`https://graph.facebook.com/v26.0/${PHONE_ID}/messages`);
    } finally {
      fetchMock.restore();
    }
  });
});
