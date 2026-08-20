/**
 * 1.19 Canal WhatsApp — Twilio (BE-TWA-*)
 *
 * Vía: `TwilioWebhookController` (endpoints REST reales, `POST /webhooks/twilio`) para la
 * entrada, y `TwilioWhatsAppService` (llamado directo al método, o vía `whatsapp.outgoing`
 * cuando lo que se prueba es justamente la suscripción) para la salida.
 *
 * Frontera mockeada: `fetch` (`installFetchMock`), contra `api.twilio.com` y
 * `content.twilio.com`. El broker (RabbitMQ real, sobre el vhost efímero) y el motor de
 * conversaciones NO se mockean.
 *
 * Tres describes, cada uno con su PROPIA app, para no pisarse entre sí:
 *  - "Selección de proveedor": el único caso que necesita `WHATSAPP_PROVIDER=twilio` real al
 *    arrancar. Si compartiera app con el resto, sus mensajes en `whatsapp.outgoing` competirían
 *    (round-robin real de RabbitMQ) contra el consumer de Meta (activo por default) de OTRA app
 *    abierta al mismo tiempo sobre el mismo vhost efímero — exactamente lo que este bloque
 *    quiere que NO pase.
 *  - "Webhook de entrada": nunca carga credenciales de ningún proveedor. Un mensaje real que
 *    entra por acá dispara de fondo a `ConversationsService` (crea `Conversation`, responde con
 *    el LLM fake, publica en `whatsapp.outgoing`) — sin credenciales configuradas en ESTE
 *    describe, cualquier conector que levante esa respuesta hace un no-op silencioso (mismo
 *    chequeo que BE-TWA-09), así que ese tráfico de fondo nunca puede colarse en el
 *    `installFetchMock` de otro test.
 *  - "Mecánica del conector": solo llamadas directas a `TwilioWhatsAppService.sendText`, nunca
 *    toca colas de entrada ni webhooks — cero actividad de `ConversationsService` de fondo.
 */
import { Logger } from '@nestjs/common';
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
import { TwilioWhatsAppService } from '../src/modules/whatsapp/twilio-whatsapp.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { WhatsAppInteractive } from '../src/modules/whatsapp/whatsapp-interactive.types';

/**
 * Espera hasta que `check()` devuelva `true` o vence el timeout. Hace falta porque publicar en
 * una cola (`broker.publish`) y que el consumer real la levante es asincrónico de verdad
 * (RabbitMQ real de punta a punta, aunque `fetch` esté mockeado) — no hay una promesa que
 * awaitear directamente para "ya lo consumió".
 */
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
const TWILIO_WHATSAPP_FROM = '+14155238886';

describe('1.19 Canal WhatsApp — Twilio, selección de proveedor (BE-TWA-01, BE-TWA-02)', () => {
  let t: TestApp;

  beforeAll(async () => {
    // El provider se lee UNA sola vez en `onModuleInit`: hay que dejarlo en BD ANTES de levantar
    // la app. Conexión de Prisma aparte (no la de `t`, que todavía no existe) — apunta a la
    // misma base efímera vía DATABASE_URL, ya seteado por setup-env.ts para todo el proceso.
    const preboot = new PrismaService();
    await preboot.$connect();
    await setSetting(preboot, 'WHATSAPP_PROVIDER', 'twilio');
    await setSetting(preboot, 'TWILIO_ACCOUNT_SID', TWILIO_ACCOUNT_SID);
    await setSetting(preboot, 'TWILIO_AUTH_TOKEN', TWILIO_AUTH_TOKEN);
    await setSetting(preboot, 'TWILIO_WHATSAPP_FROM', TWILIO_WHATSAPP_FROM);
    await preboot.$disconnect();

    t = await createTestApp();
  }, 30000);

  afterAll(async () => {
    await deleteSetting(t.prisma, 'WHATSAPP_PROVIDER');
    await deleteSetting(t.prisma, 'TWILIO_ACCOUNT_SID');
    await deleteSetting(t.prisma, 'TWILIO_AUTH_TOKEN');
    await deleteSetting(t.prisma, 'TWILIO_WHATSAPP_FROM');
    await t.close();
  }, 30000);

  it('BE-TWA-01: arrancar con WHATSAPP_PROVIDER=twilio suscribe solo a TwilioWhatsAppService a whatsapp.outgoing', async () => {
    const { requests, restore } = installFetchMock((url) => {
      if (url.includes('api.twilio.com')) return { status: 201, body: { sid: 'SM01' } };
      // Si Meta o Gupshup también estuvieran suscriptos (bug), la request caería acá.
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
      await new Promise((r) => setTimeout(r, 200)); // margen por si un consumer de más contestara con demora

      expect(requests.length).toBe(2);
      expect(requests.every((r) => r.url.includes('api.twilio.com'))).toBe(true);
      expect(requests.some((r) => r.url.includes('graph.facebook.com'))).toBe(false);
      expect(requests.some((r) => r.url.includes('api.gupshup.io'))).toBe(false);
    } finally {
      restore();
    }
  }, 15000);

  it('BE-TWA-02: cambiar WHATSAPP_PROVIDER en BD sin reiniciar NO re-suscribe (los mensajes nuevos siguen yendo a Twilio)', async () => {
    // Simula un PATCH /settings en caliente, después de que la app ya arrancó y ya se
    // suscribió. `onModuleInit` de los tres conectores solo corre una vez, al boot.
    await setSetting(t.prisma, 'WHATSAPP_PROVIDER', 'meta');

    const { requests, restore } = installFetchMock((url) => {
      if (url.includes('api.twilio.com')) return { status: 201, body: { sid: 'SM02' } };
      return { status: 200, body: { ok: true } };
    });
    try {
      const broker = t.moduleRef.get(BrokerService);
      const to = uniquePhone();
      await broker.publish('whatsapp.outgoing', {
        pattern: 'message.send',
        data: { to, body: 'sigue siendo twilio' },
        timestamp: new Date().toISOString(),
      });

      await waitFor(() => requests.length >= 1);
      await new Promise((r) => setTimeout(r, 200));

      // Sigue yendo a Twilio: nadie re-evaluó el setting ni se resuscribió a Meta. Choca con el
      // texto de /settings que promete "aplican sin reiniciar" — divergencia documentada en el plan.
      expect(requests.length).toBe(1);
      expect(requests[0].url).toContain('api.twilio.com');
    } finally {
      restore();
      await setSetting(t.prisma, 'WHATSAPP_PROVIDER', 'twilio'); // vuelve al valor con el que arrancó la app
    }
  }, 15000);
});

describe('1.19 Canal WhatsApp — Twilio, webhook de entrada (BE-TWA-03, BE-TWA-04, BE-TWA-10)', () => {
  let t: TestApp;
  let broker: BrokerService;

  beforeAll(async () => {
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(new FakeLlmService().setReply('ok, gracias')),
    });
    broker = t.moduleRef.get(BrokerService);
  }, 30000);

  afterAll(async () => {
    // Cada test ya esperó a que exista el `Message` del asistente (la respuesta de
    // `handleMessage` publicada en `whatsapp.outgoing`) — pero eso solo prueba que el PUBLISH
    // ocurrió, no que el conector que consume esa cola en ESTA misma app (`WhatsAppService`/
    // Meta, sin credenciales, no-op) ya la ackeó. Un margen chico antes de cerrar evita dejar
    // ese mensaje sin ackear: si `app.close()` corta el canal a mitad de ese consumo, RabbitMQ
    // lo reencola y puede terminar entregado al conector de OTRO archivo de test que arranque
    // después (el vhost efímero es compartido por toda la corrida, no por archivo) — así se
    // detectó este caso, corriendo la suite completa en vez de un archivo aislado.
    await new Promise((r) => setTimeout(r, 300));
    await t.close();
  });

  it('BE-TWA-03: POST webhooks/twilio con un mensaje de texto responde 200 y publica {from, body, channel} en whatsapp.incoming', async () => {
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      const phone = uniquePhone();
      const res = await http(t)
        .post('/webhooks/twilio')
        .type('form')
        .send({ From: `whatsapp:${phone}`, Body: 'Hola, necesito ayuda' });

      // @HttpCode(200) explícito en el controller (no el 201 default de Nest para @Post()).
      expect(res.status).toBe(200);

      const call = publishSpy.mock.calls.find((c) => c[0] === 'whatsapp.incoming');
      expect(call).toBeDefined();
      expect((call![1] as any).data).toEqual({ from: phone, body: 'Hola, necesito ayuda', channel: 'whatsapp' });

      // Esperar a que termine de fondo el pipeline real que dispara ese publish
      // (`ConversationsService.handleMessage`, siempre suscripto a `whatsapp.incoming`): sin
      // esto, `afterAll` puede cerrar la app con ese trabajo todavía en vuelo (ruido de
      // "Channel closed" en el log, inofensivo pero evitable). De paso confirma que el
      // `LlmService` fake de este describe es el que realmente respondió, no el real.
      await waitFor(async () => {
        const msg = await t.prisma.message.findFirst({
          where: { conversation: { externalId: phone }, senderType: 'assistant' },
        });
        return !!msg;
      });
      const assistantMsg = await t.prisma.message.findFirst({
        where: { conversation: { externalId: phone }, senderType: 'assistant' },
      });
      expect(assistantMsg?.content).toBe('ok, gracias');
    } finally {
      publishSpy.mockRestore();
    }
  });

  it('BE-TWA-04: la respuesta a un botón/lista de Content llega en Body y se publica igual como body (mismo contrato que Meta)', async () => {
    // Twilio no distingue del lado del servidor "toqué un botón de Content" de un texto libre:
    // el id de la opción viaja en el MISMO campo `Body` — `TwilioWebhookController` no tiene
    // ninguna rama separada para esto (confirmado leyendo el controller completo). Por eso este
    // caso ejercita el mismo código que BE-TWA-03: lo que prueba es que el id de la opción
    // (ej. "opt_2") viaja intacto como `body`.
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      const phone = uniquePhone();
      const res = await http(t)
        .post('/webhooks/twilio')
        .type('form')
        .send({ From: `whatsapp:${phone}`, Body: 'opt_2' });

      expect(res.status).toBe(200);
      const call = publishSpy.mock.calls.find(
        (c) => c[0] === 'whatsapp.incoming' && (c[1] as any).data?.from === phone,
      );
      expect(call).toBeDefined();
      expect((call![1] as any).data.body).toBe('opt_2');

      // Mismo motivo que en BE-TWA-03: esperar a que el pipeline de fondo termine, así no
      // queda trabajo en vuelo cuando `afterAll` cierra la app.
      await waitFor(async () => {
        const msg = await t.prisma.message.findFirst({
          where: { conversation: { externalId: phone }, senderType: 'assistant' },
        });
        return !!msg;
      });
    } finally {
      publishSpy.mockRestore();
    }
  });

  it.failing('BE-TWA-10: POST webhooks/twilio sin X-Twilio-Signature válida debe rechazarse (SEC-16)', async () => {
    const phone = uniquePhone();
    const res = await http(t)
      .post('/webhooks/twilio')
      .type('form')
      .send({ From: `whatsapp:${phone}`, Body: 'sin firma' });

    // SEGURO: sin validar la firma HMAC con el auth token, debería rechazar (401/403).
    // Hoy `TwilioWebhookController.receive` no valida `X-Twilio-Signature` en absoluto y
    // siempre acepta (200) — agravante señalado en el plan: el webhook está activo aunque
    // WHATSAPP_PROVIDER no sea 'twilio'.
    expect([401, 403]).toContain(res.status);

    // Al aceptar hoy el POST, dispara el mismo pipeline de fondo que BE-TWA-03/04 — esperarlo
    // evita dejar un mensaje sin ackear cuando `afterAll` cierre la app: sin esto, RabbitMQ lo
    // reencola y el SIGUIENTE archivo de test que se suscriba a `whatsapp.outgoing` (con otro
    // provider activo) puede terminar recibiéndolo — un falso positivo cruzado entre archivos,
    // detectado corriendo la suite completa (no solo este archivo en aislamiento).
    await waitFor(async () => {
      const msg = await t.prisma.message.findFirst({
        where: { conversation: { externalId: phone }, senderType: 'assistant' },
      });
      return !!msg;
    });
  });
});

describe('1.19 Canal WhatsApp — Twilio, mecánica del conector (BE-TWA-05..09, BE-TWA-11)', () => {
  let t: TestApp;
  let service: TwilioWhatsAppService;

  beforeAll(async () => {
    t = await createTestApp();
    service = t.moduleRef.get(TwilioWhatsAppService);
  }, 30000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await setSetting(t.prisma, 'TWILIO_ACCOUNT_SID', TWILIO_ACCOUNT_SID);
    await setSetting(t.prisma, 'TWILIO_AUTH_TOKEN', TWILIO_AUTH_TOKEN);
    await setSetting(t.prisma, 'TWILIO_WHATSAPP_FROM', TWILIO_WHATSAPP_FROM);
  });

  afterEach(async () => {
    await deleteSetting(t.prisma, 'TWILIO_ACCOUNT_SID');
    await deleteSetting(t.prisma, 'TWILIO_AUTH_TOKEN');
    await deleteSetting(t.prisma, 'TWILIO_WHATSAPP_FROM');
  });

  it('BE-TWA-05: sendText con un texto simple hace POST a la Messages API de Twilio desde TWILIO_WHATSAPP_FROM', async () => {
    const { requests, restore } = installFetchMock((url) => {
      if (url.includes('api.twilio.com')) return { status: 201, body: { sid: 'SM05' } };
      return { status: 404 };
    });
    try {
      const to = uniquePhone();
      await service.sendText(to, 'Hola desde el test');

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      );
      const body = new URLSearchParams(requests[0].init!.body as string);
      expect(body.get('To')).toBe(`whatsapp:${to}`);
      expect(body.get('From')).toBe(`whatsapp:${TWILIO_WHATSAPP_FROM}`);
      expect(body.get('Body')).toBe('Hola desde el test');
    } finally {
      restore();
    }
  });

  it('BE-TWA-06: el primer menú de una forma nueva crea un Content Template en Twilio y lo persiste en TwilioContentTemplate', async () => {
    const interactive: WhatsAppInteractive = {
      type: 'button',
      body: 'Elegí una opción',
      buttons: [
        { id: 'opt_a', title: 'Opción A' },
        { id: 'opt_b', title: 'Opción B' },
      ],
    };
    const { requests, restore } = installFetchMock((url) => {
      if (url.includes('content.twilio.com')) return { status: 201, body: { sid: 'HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } };
      if (url.includes('api.twilio.com')) return { status: 201, body: { sid: 'SM06' } };
      return { status: 404 };
    });
    try {
      const to = uniquePhone();
      await service.sendText(to, 'Cuerpo variable', interactive);

      const contentCalls = requests.filter((r) => r.url.includes('content.twilio.com'));
      expect(contentCalls).toHaveLength(1);
      const payload = JSON.parse(contentCalls[0].init!.body as string);
      expect(payload.types['twilio/quick-reply'].actions).toHaveLength(2);
      expect(payload.types['twilio/quick-reply'].body).toBe('{{1}}'); // el body va como variable, no fijo

      const msgCalls = requests.filter((r) => r.url.includes('api.twilio.com'));
      expect(msgCalls).toHaveLength(1);
      const msgBody = new URLSearchParams(msgCalls[0].init!.body as string);
      expect(msgBody.get('ContentSid')).toBe('HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(JSON.parse(msgBody.get('ContentVariables')!)).toEqual({ '1': 'Cuerpo variable' });

      const stored = await t.prisma.twilioContentTemplate.findFirst({
        where: { contentSid: 'HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      });
      expect(stored).not.toBeNull();
    } finally {
      restore();
    }
  });

  it('BE-TWA-07: un segundo menú con la MISMA forma pero distinto body reusa el mismo ContentSid, sin crear otro template', async () => {
    // Misma forma exacta que BE-TWA-06 (mismos ids/títulos de botones, en el mismo orden) — el
    // hash no depende del body, así que tiene que pegar en la caché L1 en memoria de `service`
    // (misma instancia en todo este describe) sin volver a tocar ni la BD ni la Content API.
    const interactive: WhatsAppInteractive = {
      type: 'button',
      body: 'Elegí una opción',
      buttons: [
        { id: 'opt_a', title: 'Opción A' },
        { id: 'opt_b', title: 'Opción B' },
      ],
    };
    const { requests, restore } = installFetchMock((url) => {
      if (url.includes('api.twilio.com')) return { status: 201, body: { sid: 'SM07' } };
      // Si esto se llegara a llamar sería la prueba de que NO reusó el template.
      if (url.includes('content.twilio.com')) return { status: 201, body: { sid: 'HXnuevo' } };
      return { status: 404 };
    });
    try {
      const to = uniquePhone();
      await service.sendText(to, 'Otro cuerpo distinto', interactive);

      expect(requests.some((r) => r.url.includes('content.twilio.com'))).toBe(false);
      const msgCalls = requests.filter((r) => r.url.includes('api.twilio.com'));
      expect(msgCalls).toHaveLength(1);
      const msgBody = new URLSearchParams(msgCalls[0].init!.body as string);
      expect(msgBody.get('ContentSid')).toBe('HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'); // el mismo de BE-TWA-06

      const count = await t.prisma.twilioContentTemplate.count({
        where: { contentSid: 'HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      });
      expect(count).toBe(1); // no se creó una fila nueva
    } finally {
      restore();
    }
  });

  it('BE-TWA-08: si la Content API falla al crear el template, degrada a texto numerado en vez de perder el mensaje', async () => {
    const interactive: WhatsAppInteractive = {
      type: 'list',
      body: 'Elegí un área',
      buttonText: 'Ver áreas',
      rows: [
        { id: 'area_1', title: 'Soporte' },
        { id: 'area_2', title: 'Ventas' },
      ],
    };
    const { requests, restore } = installFetchMock((url) => {
      if (url.includes('content.twilio.com')) return { status: 500, body: 'boom' };
      if (url.includes('api.twilio.com')) return { status: 201, body: { sid: 'SM08' } };
      return { status: 404 };
    });
    try {
      const to = uniquePhone();
      await expect(service.sendText(to, 'Elegí un área', interactive)).resolves.toBeUndefined();

      const msgCalls = requests.filter((r) => r.url.includes('api.twilio.com'));
      expect(msgCalls).toHaveLength(1); // el mensaje se mandó igual, degradado
      const msgBody = new URLSearchParams(msgCalls[0].init!.body as string);
      expect(msgBody.get('ContentSid')).toBeNull();
      const text = msgBody.get('Body')!;
      expect(text).toContain('1. Soporte');
      expect(text).toContain('2. Ventas');
    } finally {
      restore();
    }
  });

  it('BE-TWA-09: sendText sin TWILIO_ACCOUNT_SID/AUTH_TOKEN/WHATSAPP_FROM hace warn y no envía nada (no lanza)', async () => {
    await deleteSetting(t.prisma, 'TWILIO_ACCOUNT_SID');
    await deleteSetting(t.prisma, 'TWILIO_AUTH_TOKEN');
    await deleteSetting(t.prisma, 'TWILIO_WHATSAPP_FROM');

    const { requests, restore } = installFetchMock(() => ({ status: 200 }));
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as unknown as void);
    try {
      await expect(service.sendText(uniquePhone(), 'nunca sale')).resolves.toBeUndefined();
      expect(requests).toHaveLength(0);
      expect(
        warnSpy.mock.calls.some((args) => String(args[0]).includes('No se pudo enviar WhatsApp (Twilio)')),
      ).toBe(true);
    } finally {
      restore();
      warnSpy.mockRestore();
    }
  });

  it('BE-TWA-11: dos requests concurrentes con la misma forma NUEVA compiten por crear el Content Template', async () => {
    const interactive: WhatsAppInteractive = {
      type: 'button',
      body: '{{b}}',
      buttons: [
        { id: 'race_a', title: 'Carrera A' },
        { id: 'race_b', title: 'Carrera B' },
      ],
    };
    let contentCallCount = 0;
    const { requests, restore } = installFetchMock((url) => {
      if (url.includes('content.twilio.com')) {
        contentCallCount++;
        return { status: 201, body: { sid: contentCallCount === 1 ? 'HXrace1' : 'HXrace2' } };
      }
      if (url.includes('api.twilio.com')) return { status: 201, body: { sid: 'SMrace' } };
      return { status: 404 };
    });
    try {
      const toA = uniquePhone();
      const toB = uniquePhone();
      await Promise.all([
        service.sendText(toA, 'cuerpo A', interactive),
        service.sendText(toB, 'cuerpo B', interactive),
      ]);

      const msgCalls = requests.filter((r) => r.url.includes('api.twilio.com'));
      expect(msgCalls).toHaveLength(2); // los dos mensajes salieron igual, con o sin carrera real

      const contentCalls = requests.filter((r) => r.url.includes('content.twilio.com'));
      const sidsUsados = msgCalls.map((r) => new URLSearchParams(r.init!.body as string).get('ContentSid'));
      const stored = await t.prisma.twilioContentTemplate.findMany({
        where: { contentSid: { in: sidsUsados as string[] } },
      });

      if (contentCalls.length === 2) {
        // Se dio la carrera real (las dos llegaron a `createContentTemplate` antes de que
        // cualquiera persistiera): cada llamada usa su propio sid — uno de los dos queda
        // "huérfano" en la cuenta de Twilio, sin fila en BD — y el `shapeHash` único garantiza
        // que solo UNA fila haya quedado persistida.
        expect(new Set(sidsUsados).size).toBe(2);
        expect(stored).toHaveLength(1);
      } else {
        // El timing de `Promise.all` no garantiza la carrera: la segunda llegó a `findUnique`
        // después de que la primera ya había persistido, y reusó el mismo Content Template sin
        // pegarle una segunda vez a la Content API (mismo mecanismo que BE-TWA-07).
        expect(contentCalls).toHaveLength(1);
        expect(new Set(sidsUsados).size).toBe(1);
        expect(stored).toHaveLength(1);
      }
    } finally {
      restore();
    }
  });
});
