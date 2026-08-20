/**
 * 1.20 Canal WhatsApp — Gupshup (BE-GUP-*)
 *
 * Vía: `GupshupWebhookController` (`POST /webhooks/gupshup`) para la entrada, y
 * `GupshupWhatsAppService` (llamado directo, o vía `whatsapp.outgoing` para el caso de
 * selección de proveedor) para la salida.
 *
 * Frontera mockeada: `fetch` (`installFetchMock`), contra `api.gupshup.io`. El broker
 * (RabbitMQ real) y el motor de conversaciones NO se mockean.
 *
 * Mismos tres describes con app propia cada uno que `twilio.e2e-spec.ts` — ver el comentario
 * de cabecera de ese archivo para el porqué (evitar que dos apps abiertas a la vez compitan
 * por la misma cola `whatsapp.outgoing` del vhost efímero compartido).
 */
import {
  createTestApp,
  TestApp,
  http,
  uniquePhone,
  setSetting,
  deleteSetting,
  installFetchMock,
  FakeLlmService,
} from './support';
import { PrismaService } from '../src/prisma/prisma.service';
import { BrokerService } from '../src/modules/broker/broker.service';
import { GupshupWhatsAppService } from '../src/modules/whatsapp/gupshup-whatsapp.service';
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

const GUPSHUP_API_KEY = 'gupshup-test-key';
const GUPSHUP_WHATSAPP_SOURCE = '14155238886';
const GUPSHUP_APP_NAME = 'pci-test-app';

describe('1.20 Canal WhatsApp — Gupshup, selección de proveedor (BE-GUP-01)', () => {
  let t: TestApp;

  beforeAll(async () => {
    const preboot = new PrismaService();
    await preboot.$connect();
    await setSetting(preboot, 'WHATSAPP_PROVIDER', 'gupshup');
    await setSetting(preboot, 'GUPSHUP_API_KEY', GUPSHUP_API_KEY);
    await setSetting(preboot, 'GUPSHUP_WHATSAPP_SOURCE', GUPSHUP_WHATSAPP_SOURCE);
    await setSetting(preboot, 'GUPSHUP_APP_NAME', GUPSHUP_APP_NAME);
    await preboot.$disconnect();

    t = await createTestApp();
  }, 30000);

  afterAll(async () => {
    await deleteSetting(t.prisma, 'WHATSAPP_PROVIDER');
    await deleteSetting(t.prisma, 'GUPSHUP_API_KEY');
    await deleteSetting(t.prisma, 'GUPSHUP_WHATSAPP_SOURCE');
    await deleteSetting(t.prisma, 'GUPSHUP_APP_NAME');
    await t.close();
  }, 30000);

  it('BE-GUP-01: arrancar con WHATSAPP_PROVIDER=gupshup suscribe solo a GupshupWhatsAppService a whatsapp.outgoing', async () => {
    const { requests, restore } = installFetchMock((url) => {
      if (url.includes('api.gupshup.io')) return { status: 200, body: { status: 'submitted', messageId: 'gm01' } };
      // Si Meta o Twilio también estuvieran suscriptos (bug), la request caería acá.
      return { status: 200, body: { ok: true } };
    });
    try {
      const broker = t.moduleRef.get(BrokerService);
      const to1 = uniquePhone();
      const to2 = uniquePhone();
      await broker.publish('whatsapp.outgoing', {
        pattern: 'message.send',
        data: { to: to1, body: 'hola 1' },
        timestamp: new Date().toISOString(),
      });
      await broker.publish('whatsapp.outgoing', {
        pattern: 'message.send',
        data: { to: to2, body: 'hola 2' },
        timestamp: new Date().toISOString(),
      });

      await waitFor(() => requests.length >= 2);
      await new Promise((r) => setTimeout(r, 200));

      expect(requests.length).toBe(2);
      expect(requests.every((r) => r.url.includes('api.gupshup.io'))).toBe(true);
      expect(requests.some((r) => r.url.includes('graph.facebook.com'))).toBe(false);
      expect(requests.some((r) => r.url.includes('api.twilio.com'))).toBe(false);
    } finally {
      restore();
    }
  }, 15000);
});

describe('1.20 Canal WhatsApp — Gupshup, webhook de entrada (BE-GUP-02, BE-GUP-04, BE-GUP-06)', () => {
  let t: TestApp;
  let broker: BrokerService;

  beforeAll(async () => {
    // Nunca se cargan credenciales de ningún proveedor en este describe — ver el comentario
    // equivalente en twilio.e2e-spec.ts sobre por qué eso alcanza para que cualquier tráfico
    // de fondo de ConversationsService sea inofensivo (no-op silencioso al no encontrar
    // credenciales), sin importar el timing entre tests.
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(new FakeLlmService().setReply('ok, gracias')),
    });
    broker = t.moduleRef.get(BrokerService);
  }, 30000);

  afterAll(async () => {
    // Ver el comentario equivalente en twilio.e2e-spec.ts: un margen chico antes de cerrar
    // evita dejar sin ackear el mensaje que `handleMessage` publica en `whatsapp.outgoing`
    // (WhatsAppService/Meta, sin credenciales acá, lo consume como no-op) — sin esto, RabbitMQ
    // puede reencolarlo y otro archivo de test que arranque después terminar recibiéndolo.
    await new Promise((r) => setTimeout(r, 300));
    await t.close();
  });

  it('BE-GUP-02: POST webhooks/gupshup con texto responde 200 y publica {from:+<num>, body, channel:whatsapp}', async () => {
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      const rawNumber = uniquePhone().replace('+', ''); // Gupshup manda el sender SIN "+"
      const res = await http(t)
        .post('/webhooks/gupshup')
        .send({
          type: 'message',
          payload: {
            type: 'text',
            payload: { text: 'Hola desde Gupshup' },
            sender: { phone: rawNumber },
          },
        });

      expect(res.status).toBe(200);
      const call = publishSpy.mock.calls.find((c) => c[0] === 'whatsapp.incoming');
      expect(call).toBeDefined();
      expect((call![1] as any).data).toEqual({
        from: `+${rawNumber}`,
        body: 'Hola desde Gupshup',
        channel: 'whatsapp',
      });

      await waitFor(async () => {
        const msg = await t.prisma.message.findFirst({
          where: { conversation: { externalId: `+${rawNumber}` }, senderType: 'assistant' },
        });
        return !!msg;
      });
    } finally {
      publishSpy.mockRestore();
    }
  });

  it('BE-GUP-04: la respuesta a botón (button_reply) o lista (list_reply) publica el id (postbackText) como body, no el título', async () => {
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      const rawNumber = uniquePhone().replace('+', '');
      const res = await http(t)
        .post('/webhooks/gupshup')
        .send({
          type: 'message',
          payload: {
            type: 'button_reply',
            payload: { postbackText: 'opt_2', text: 'Título visible del botón' },
            sender: { phone: rawNumber },
          },
        });

      expect(res.status).toBe(200);
      const call = publishSpy.mock.calls.find(
        (c) => c[0] === 'whatsapp.incoming' && (c[1] as any).data?.from === `+${rawNumber}`,
      );
      expect(call).toBeDefined();
      expect((call![1] as any).data.body).toBe('opt_2'); // el id, no "Título visible del botón"

      await waitFor(async () => {
        const msg = await t.prisma.message.findFirst({
          where: { conversation: { externalId: `+${rawNumber}` }, senderType: 'assistant' },
        });
        return !!msg;
      });
    } finally {
      publishSpy.mockRestore();
    }
  });

  it.failing('BE-GUP-06: POST webhooks/gupshup sin ninguna verificación de autenticidad debe rechazarse (SEC-16)', async () => {
    const rawNumber = uniquePhone().replace('+', '');
    const res = await http(t)
      .post('/webhooks/gupshup')
      .send({
        type: 'message',
        payload: { type: 'text', payload: { text: 'sin verificar' }, sender: { phone: rawNumber } },
      });

    // SEGURO: debería verificar que el POST viene realmente de Gupshup (firma, secret
    // compartido, IP allowlist, lo que sea) antes de encolar. Hoy `GupshupWebhookController`
    // no valida nada de eso y siempre acepta (200).
    expect([401, 403]).toContain(res.status);

    // Al aceptar hoy el POST, dispara el mismo pipeline de fondo que BE-GUP-02/04 — esperarlo
    // evita dejar un mensaje sin ackear cuando `afterAll` cierre la app (ver el comentario
    // equivalente en twilio.e2e-spec.ts, BE-TWA-10: sin esto, RabbitMQ lo reencola y puede
    // terminar en el consumer de OTRO archivo de test que arranque después).
    await waitFor(async () => {
      const msg = await t.prisma.message.findFirst({
        where: { conversation: { externalId: `+${rawNumber}` }, senderType: 'assistant' },
      });
      return !!msg;
    });
  });
});

describe('1.20 Canal WhatsApp — Gupshup, mecánica del conector (BE-GUP-03, BE-GUP-05, BE-GUP-07)', () => {
  let t: TestApp;
  let service: GupshupWhatsAppService;

  beforeAll(async () => {
    t = await createTestApp();
    service = t.moduleRef.get(GupshupWhatsAppService);
  }, 30000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await setSetting(t.prisma, 'GUPSHUP_API_KEY', GUPSHUP_API_KEY);
    await setSetting(t.prisma, 'GUPSHUP_WHATSAPP_SOURCE', GUPSHUP_WHATSAPP_SOURCE);
    await setSetting(t.prisma, 'GUPSHUP_APP_NAME', GUPSHUP_APP_NAME);
  });

  afterEach(async () => {
    await deleteSetting(t.prisma, 'GUPSHUP_API_KEY');
    await deleteSetting(t.prisma, 'GUPSHUP_WHATSAPP_SOURCE');
    await deleteSetting(t.prisma, 'GUPSHUP_APP_NAME');
  });

  it('BE-GUP-03: encolar un menú de ≤3 opciones lo traduce a quick_reply inline (sin templates pre-creados)', async () => {
    const interactive: WhatsAppInteractive = {
      type: 'button',
      body: 'Elegí una opción',
      buttons: [
        { id: 'opt_a', title: 'Opción A' },
        { id: 'opt_b', title: 'Opción B' },
      ],
    };
    const { requests, restore } = installFetchMock((url) =>
      url.includes('api.gupshup.io') ? { status: 200, body: { status: 'submitted' } } : { status: 404 },
    );
    try {
      const to = uniquePhone();
      await service.sendText(to, 'Elegí una opción', interactive);

      expect(requests).toHaveLength(1); // un único request, inline — sin llamada previa a una Content API
      const params = new URLSearchParams(requests[0].init!.body as string);
      const message = JSON.parse(params.get('message')!);
      expect(message.type).toBe('quick_reply');
      expect(message.content).toEqual({ type: 'text', text: 'Elegí una opción' });
      expect(message.options).toEqual([
        { type: 'text', title: 'Opción A', postbackText: 'opt_a' },
        { type: 'text', title: 'Opción B', postbackText: 'opt_b' },
      ]);
    } finally {
      restore();
    }
  });

  it('BE-GUP-03: encolar un menú de >3 opciones (lista) lo traduce a list inline, con las opciones bajo items[0].options', async () => {
    const interactive: WhatsAppInteractive = {
      type: 'list',
      body: 'Elegí un área',
      buttonText: 'Ver áreas',
      rows: [
        { id: 'area_1', title: 'Soporte' },
        { id: 'area_2', title: 'Ventas' },
        { id: 'area_3', title: 'Facturación' },
        { id: 'area_4', title: 'Otro' },
      ],
    };
    const { requests, restore } = installFetchMock((url) =>
      url.includes('api.gupshup.io') ? { status: 200, body: { status: 'submitted' } } : { status: 404 },
    );
    try {
      const to = uniquePhone();
      await service.sendText(to, 'Elegí un área', interactive);

      expect(requests).toHaveLength(1);
      const params = new URLSearchParams(requests[0].init!.body as string);
      const message = JSON.parse(params.get('message')!);
      expect(message.type).toBe('list');
      expect(message.items[0].options.map((o: any) => o.postbackText)).toEqual([
        'area_1',
        'area_2',
        'area_3',
        'area_4',
      ]);
    } finally {
      restore();
    }
  });

  it('BE-GUP-05: sendText sin GUPSHUP_API_KEY/SOURCE/APP_NAME hace warn y no envía nada (no lanza)', async () => {
    await deleteSetting(t.prisma, 'GUPSHUP_API_KEY');
    await deleteSetting(t.prisma, 'GUPSHUP_WHATSAPP_SOURCE');
    await deleteSetting(t.prisma, 'GUPSHUP_APP_NAME');

    const { requests, restore } = installFetchMock(() => ({ status: 200 }));
    try {
      await expect(service.sendText(uniquePhone(), 'nunca sale')).resolves.toBeUndefined();
      expect(requests).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('BE-GUP-07: un menú tipo lista con buttonText reusa ese texto como título (title) de la lista', async () => {
    const interactive: WhatsAppInteractive = {
      type: 'list',
      body: 'Elegí un área',
      buttonText: 'Ver opciones',
      rows: [
        { id: 'area_1', title: 'Soporte' },
        { id: 'area_2', title: 'Ventas' },
        { id: 'area_3', title: 'Facturación' },
        { id: 'area_4', title: 'Otro' },
      ],
    };
    const { requests, restore } = installFetchMock((url) =>
      url.includes('api.gupshup.io') ? { status: 200, body: { status: 'submitted' } } : { status: 404 },
    );
    try {
      const to = uniquePhone();
      await service.sendText(to, 'Elegí un área', interactive);

      const params = new URLSearchParams(requests[0].init!.body as string);
      const message = JSON.parse(params.get('message')!);
      // `buttonText` no tiene equivalente propio de "header" en WhatsAppInteractive — el código
      // reusa el mismo valor tanto para `title` (header de la lista) como para el globalButton.
      expect(message.title).toBe('Ver opciones');
      expect(message.globalButtons[0]).toEqual({ type: 'text', title: 'Ver opciones' });
    } finally {
      restore();
    }
  });
});
