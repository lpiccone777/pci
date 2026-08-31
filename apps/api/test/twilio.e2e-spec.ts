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
  uniqueSlug,
  uniqueEmail,
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
import { TwilioWhatsAppService } from '../src/modules/whatsapp/twilio-whatsapp.service';
import { TwilioMediaService } from '../src/common/twilio-media.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { WhatsAppInteractive } from '../src/modules/whatsapp/whatsapp-interactive.types';
import sharp from 'sharp';
import { mkdtemp, rm, readFile, writeFile, utimes } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHmac } from 'crypto';

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

/**
 * Igual que `installFetchMock` pero deja pasar cuerpos BINARIOS intactos: el `router` puede
 * devolver un `Buffer` como `body` y llega tal cual a `res.arrayBuffer()`. Hace falta porque
 * `installFetchMock` serializa cualquier body no-string con `JSON.stringify`, y pasar la imagen
 * como string latin1 la corrompe al re-encodear a UTF-8 dentro de `new Response(...)`
 * (comprobado: los bytes de un PNG/JPEG real no sobreviven). Para bajar imágenes reales y volver
 * a leerlas del disco (verificar resize/orientación) hace falta este canal binario. Sigue
 * mockeando SOLO la frontera HTTP (descarga de media de Twilio).
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
  let tenant: { id: string };
  let role: { id: string };

  /** Teléfono registrado en `tenant`: "no hablamos con desconocidos" (2026-08-27) rechaza
   *  cualquier número sin membresía ANTES de crear la Conversation/Message que estos tests
   *  esperan con `waitFor` — sin esto, el webhook responde 200 igual (solo confirma que
   *  publicó en `whatsapp.incoming`), pero el pipeline de fondo nunca crea el Message y el
   *  `waitFor` cuelga hasta el timeout. */
  async function knownPhone() {
    const phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('twa-webhook'),
      phone,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    return phone;
  }

  beforeAll(async () => {
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(new FakeLlmService().setReply('ok, gracias')),
    });
    broker = t.moduleRef.get(BrokerService);
    tenant = await createTenant(t.prisma, { slug: uniqueSlug('twa-webhook') });
    role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol TWA webhook' });
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
      const phone = await knownPhone();
      const res = await http(t)
        .post('/webhooks/twilio')
        .type('form')
        .send({ From: `whatsapp:${phone}`, Body: 'Hola, necesito ayuda' });

      // @HttpCode(200) explícito en el controller (no el 201 default de Nest para @Post()).
      expect(res.status).toBe(200);

      const call = publishSpy.mock.calls.find((c) => c[0] === 'whatsapp.incoming');
      expect(call).toBeDefined();
      // El webhook SIEMPRE arma `attachments` (feature de media): `extractMedia` devuelve `[]`
      // cuando no hay media y el controller lo incluye en el publish (ver TwilioWebhookController).
      expect((call![1] as any).data).toEqual({ from: phone, body: 'Hola, necesito ayuda', channel: 'whatsapp', attachments: [] });

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
      const phone = await knownPhone();
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

});

/**
 * BE-TWA-10 (SEC-16, corregido): `TwilioSignatureGuard` valida `X-Twilio-Signature` una vez
 * configurada `TWILIO_WEBHOOK_PUBLIC_URL`. Describe APARTE (con sus tres settings propios) para
 * no ensuciar "webhook de entrada", que deliberadamente nunca carga credenciales.
 */
describe('1.19 Canal WhatsApp — Twilio, verificación de firma del webhook (BE-TWA-10, SEC-16)', () => {
  let t: TestApp;
  let broker: BrokerService;
  let tenant: { id: string };
  let role: { id: string };
  const publicUrl = 'https://miapp.e2e.test';

  /** Mismo algoritmo que `TwilioSignatureGuard.validateSignature`. */
  function computeSignature(fullUrl: string, params: Record<string, string>): string {
    let data = fullUrl;
    for (const key of Object.keys(params).sort()) data += key + params[key];
    return createHmac('sha1', TWILIO_AUTH_TOKEN).update(data, 'utf8').digest('base64');
  }

  /** Registrado en `tenant`: "no hablamos con desconocidos" — ver el comentario equivalente
   *  en "webhook de entrada" más arriba. Solo hace falta para BE-TWA-10c (única rama que
   *  llega a procesarse: 10a/10b se rechazan antes por firma inválida). */
  async function knownPhone() {
    const phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('twa-sig'),
      phone,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    return phone;
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
    tenant = await createTenant(t.prisma, { slug: uniqueSlug('twa-sig') });
    role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol TWA sig' });
  }, 30000);

  afterAll(async () => {
    await deleteSetting(t.prisma, 'TWILIO_ACCOUNT_SID');
    await deleteSetting(t.prisma, 'TWILIO_AUTH_TOKEN');
    await deleteSetting(t.prisma, 'TWILIO_WEBHOOK_PUBLIC_URL');
    await t.close();
  });

  it('BE-TWA-10a: sin header X-Twilio-Signature, se rechaza con 403', async () => {
    const res = await http(t)
      .post('/webhooks/twilio')
      .type('form')
      .send({ From: `whatsapp:${uniquePhone()}`, Body: 'sin firma' });

    expect(res.status).toBe(403);
  });

  it('BE-TWA-10b: con una firma que no matchea, se rechaza con 403', async () => {
    const res = await http(t)
      .post('/webhooks/twilio')
      .type('form')
      .set('X-Twilio-Signature', 'firma-inventada-a-mano')
      .send({ From: `whatsapp:${uniquePhone()}`, Body: 'firma trucha' });

    expect(res.status).toBe(403);
  });

  it('BE-TWA-10c: con la firma HMAC-SHA1 correcta (URL pública + params ordenados), se acepta y procesa el mensaje', async () => {
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      const phone = await knownPhone();
      const params = { From: `whatsapp:${phone}`, Body: 'con firma valida' };
      const signature = computeSignature(`${publicUrl}/webhooks/twilio`, params);

      const res = await http(t)
        .post('/webhooks/twilio')
        .type('form')
        .set('X-Twilio-Signature', signature)
        .send(params);

      expect(res.status).toBe(200);
      const call = publishSpy.mock.calls.find(
        (c) => c[0] === 'whatsapp.incoming' && (c[1] as any).data?.from === phone,
      );
      expect(call).toBeDefined();

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

/**
 * Media entrante por WhatsApp (Twilio) — `TwilioMediaService` + `TwilioWebhookController`.
 *
 * Describe propio (app propia, mismo criterio que el resto del archivo). A diferencia del
 * "webhook de entrada", ESTE bloque SÍ carga credenciales de Twilio en cada test (las necesita
 * `downloadAndStore` para autenticarse contra la media de Twilio), pero eso no activa ningún
 * conector de salida: el de WhatsApp Twilio solo se suscribe con `WHATSAPP_PROVIDER=twilio`
 * (no seteado acá) y el de Meta necesita SUS credenciales — así que la respuesta que
 * `handleMessage` publica de fondo en `whatsapp.outgoing` sigue siendo un no-op silencioso.
 *
 * `MEDIA_STORAGE_DIR` se apunta a un temporal propio por test (borrado en `afterEach`) para no
 * ensuciar `uploads/incoming-media` del repo ni pisarse entre tests.
 *
 * La descarga de media se mockea con `installBinaryFetchMock` (canal binario, ver arriba)
 * cuando el test lee de vuelta la imagen del disco, y con el `installFetchMock` compartido
 * cuando solo importa el status/headers (404, tamaño).
 */
describe('1.19 Canal WhatsApp — Twilio, media entrante (BE-TWA-12..15)', () => {
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
    // Margen para que el pipeline de fondo (handleMessage → whatsapp.outgoing, no-op) ackee
    // antes de cerrar — mismo motivo que los otros describes del archivo.
    await new Promise((r) => setTimeout(r, 300));
    await t.close();
  });

  beforeEach(async () => {
    mediaDir = await mkdtemp(path.join(os.tmpdir(), 'pci-twa-media-'));
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

  it('BE-TWA-12: baja cada adjunto con Authorization Basic, auto-orienta/redimensiona (jpeg), no toca gif/pdf, publica attachments; solo-imagen NO se descarta; tope MAX_MEDIA_ITEMS=10', async () => {
    // JPEG apaisado 2400x1000 con EXIF orientation=6 (foto sacada con el celular de costado):
    // al auto-orientar por EXIF pasa a vertical, y al redimensionar entra en 1920x1080.
    const orientedJpeg = await sharp({
      create: { width: 2400, height: 1000, channels: 3, background: { r: 0, g: 128, b: 255 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    // GIF grande: multi-frame, NO se redimensiona (queda 3000x2000).
    const bigGif = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .gif()
      .toBuffer();
    // "PDF": no es imagen, no se redimensiona; se guarda tal cual con extensión .pdf.
    const pdfBytes = Buffer.from('%PDF-1.4\nfake pdf payload\n%%EOF');

    const base = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages/MM1/Media`;
    const mock = installBinaryFetchMock((url) => {
      if (url.endsWith('ME0')) return { body: orientedJpeg };
      if (url.endsWith('ME1')) return { body: bigGif };
      if (url.endsWith('ME2')) return { body: pdfBytes };
      return { status: 404 };
    });
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      const phone = uniquePhone();
      // Sin `Body` (solo imágenes): antes se descartaba, ahora sigue de largo.
      const res = await http(t)
        .post('/webhooks/twilio')
        .type('form')
        .send({
          From: `whatsapp:${phone}`,
          NumMedia: '3',
          MediaUrl0: `${base}/ME0`,
          MediaContentType0: 'image/jpeg',
          MediaUrl1: `${base}/ME1`,
          MediaContentType1: 'image/gif',
          MediaUrl2: `${base}/ME2`,
          MediaContentType2: 'application/pdf',
        });
      expect(res.status).toBe(200);

      // Cada descarga lleva Authorization: Basic base64(SID:token) de /settings.
      const mediaReqs = mock.requests.filter((r) => r.url.includes('/Media/'));
      expect(mediaReqs).toHaveLength(3);
      for (const r of mediaReqs) {
        const authHeader = (r.init!.headers as Record<string, string>)['Authorization'];
        const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString();
        expect(decoded).toBe(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
      }

      // whatsapp.incoming con los 3 adjuntos y body vacío: el mensaje solo-imagen NO se descartó.
      const call = publishSpy.mock.calls.find(
        (c) => c[0] === 'whatsapp.incoming' && (c[1] as any).data?.from === phone,
      );
      expect(call).toBeDefined();
      const data = (call![1] as any).data;
      expect(data.body).toBe('');
      expect(data.channel).toBe('whatsapp');
      expect(data.attachments).toHaveLength(3);
      const byType: Record<string, any> = Object.fromEntries(
        data.attachments.map((a: any) => [a.contentType, a]),
      );

      // JPEG: auto-orientado (apaisado → vertical) y redimensionado a ≤1920x1080.
      const jpegMeta = await sharp(byType['image/jpeg'].path).metadata();
      expect(jpegMeta.width).toBeLessThanOrEqual(1920);
      expect(jpegMeta.height).toBeLessThanOrEqual(1080);
      expect(jpegMeta.height!).toBeGreaterThan(jpegMeta.width!); // la orientación EXIF se aplicó
      expect(byType['image/jpeg'].filename.endsWith('.jpg')).toBe(true);

      // GIF: NO redimensionado (sigue 3000x2000).
      const gifMeta = await sharp(byType['image/gif'].path).metadata();
      expect(gifMeta.width).toBe(3000);
      expect(gifMeta.height).toBe(2000);
      expect(byType['image/gif'].filename.endsWith('.gif')).toBe(true);

      // PDF: guardado tal cual (mismos bytes), extensión .pdf.
      const storedPdf = await readFile(byType['application/pdf'].path);
      expect(storedPdf.equals(pdfBytes)).toBe(true);
      expect(byType['application/pdf'].filename.endsWith('.pdf')).toBe(true);
    } finally {
      publishSpy.mockRestore();
      mock.restore();
    }

    // --- Tope MAX_MEDIA_ITEMS=10: 12 adjuntos declarados, solo 10 se descargan/publican ---
    const tiny = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const capMock = installBinaryFetchMock(() => ({ body: tiny }));
    const capSpy = jest.spyOn(broker, 'publish');
    try {
      const phone2 = uniquePhone();
      const payload: Record<string, string> = { From: `whatsapp:${phone2}`, NumMedia: '12' };
      for (let i = 0; i < 12; i++) {
        payload[`MediaUrl${i}`] = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages/MM2/Media/ME${i}`;
        payload[`MediaContentType${i}`] = 'image/png';
      }
      const res2 = await http(t).post('/webhooks/twilio').type('form').send(payload);
      expect(res2.status).toBe(200);

      const mediaReqs2 = capMock.requests.filter((r) => r.url.includes('/Media/'));
      expect(mediaReqs2).toHaveLength(10); // NumMedia=12, pero el tope corta en 10
      const call2 = capSpy.mock.calls.find(
        (c) => c[0] === 'whatsapp.incoming' && (c[1] as any).data?.from === phone2,
      );
      expect((call2![1] as any).data.attachments).toHaveLength(10);
    } finally {
      capSpy.mockRestore();
      capMock.restore();
    }
  }, 20000);

  it('BE-TWA-13: URL no-2xx o sin credenciales → warn y se saltea el adjunto (la charla sigue); el cron borra temporales de +10min; ni SID ni token se loguean', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    const logSpy = jest.spyOn(Logger.prototype, 'log');
    try {
      // --- (A) URL 404: el adjunto se saltea, el mensaje se publica igual con su body ---
      // URL sin el SID adentro, para que el warn (que loguea la URL) no lo arrastre.
      const url404 = 'https://api.twilio.com/2010-04-01/Accounts/ACnotloggeddddddddddddddddddddd/Messages/MMbad/Media/MEbad';
      const mockA = installFetchMock(() => ({ status: 404, body: 'not found' }));
      const publishSpyA = jest.spyOn(broker, 'publish');
      try {
        const phone = uniquePhone();
        const res = await http(t)
          .post('/webhooks/twilio')
          .type('form')
          .send({ From: `whatsapp:${phone}`, Body: 'tengo un problema', NumMedia: '1', MediaUrl0: url404, MediaContentType0: 'image/jpeg' });
        expect(res.status).toBe(200);

        const call = publishSpyA.mock.calls.find(
          (c) => c[0] === 'whatsapp.incoming' && (c[1] as any).data?.from === phone,
        );
        expect(call).toBeDefined();
        expect((call![1] as any).data.body).toBe('tengo un problema'); // la charla no se rompe
        expect((call![1] as any).data.attachments).toHaveLength(0); // el adjunto 404 se salteó
        expect(warnSpy.mock.calls.some((a) => String(a[0]).includes('Twilio respondió 404'))).toBe(true);
      } finally {
        publishSpyA.mockRestore();
        mockA.restore();
      }

      // --- (B) sin credenciales: warn y ni siquiera se intenta la descarga ---
      await deleteSetting(t.prisma, 'TWILIO_ACCOUNT_SID');
      await deleteSetting(t.prisma, 'TWILIO_AUTH_TOKEN');
      const mockB = installFetchMock(() => ({ status: 200, body: 'no debería llamarse' }));
      const publishSpyB = jest.spyOn(broker, 'publish');
      try {
        const phone = uniquePhone();
        const res = await http(t)
          .post('/webhooks/twilio')
          .type('form')
          .send({ From: `whatsapp:${phone}`, Body: 'hola', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/ACnotloggeddddddddddddddddddddd/Messages/MMx/Media/MEnocreds', MediaContentType0: 'image/jpeg' });
        expect(res.status).toBe(200);

        expect(mockB.requests).toHaveLength(0); // sin credenciales no llega a `fetch`
        const call = publishSpyB.mock.calls.find(
          (c) => c[0] === 'whatsapp.incoming' && (c[1] as any).data?.from === phone,
        );
        expect((call![1] as any).data.attachments).toHaveLength(0);
        expect(
          warnSpy.mock.calls.some((a) => String(a[0]).includes('falta TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN')),
        ).toBe(true);
      } finally {
        publishSpyB.mockRestore();
        mockB.restore();
      }

      // --- (C) el cron @Cron('*/2 …') borra temporales de más de 10 min y deja los frescos ---
      const oldFile = path.join(mediaDir, 'old.jpg');
      const freshFile = path.join(mediaDir, 'fresh.jpg');
      await writeFile(oldFile, 'viejo');
      await writeFile(freshFile, 'nuevo');
      const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000);
      await utimes(oldFile, elevenMinAgo, elevenMinAgo);

      await twilioMedia.cleanupExpired();

      await expect(readFile(oldFile)).rejects.toThrow(); // el de +10min se borró
      expect((await readFile(freshFile)).toString()).toBe('nuevo'); // el fresco quedó

      // --- Ni el SID ni el token aparecieron en ningún log (warn/log) ---
      const allLogs = [...warnSpy.mock.calls, ...logSpy.mock.calls].map((a) => a.map(String).join(' ')).join('\n');
      expect(allLogs).not.toContain(TWILIO_ACCOUNT_SID);
      expect(allLogs).not.toContain(TWILIO_AUTH_TOKEN);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it.failing('BE-TWA-14: un adjunto de media demasiado grande debería rechazarse por un tope de bytes / Content-Length (robustez) @invertido', async () => {
    // Declara 64MB por Content-Length; hoy `downloadAndStore` ignora el header y hace
    // `res.arrayBuffer()` (carga todo en memoria), con el timeout de 20s como único freno.
    const bigBody = 'a'.repeat(1024 * 1024); // 1MB de relleno; el header declara mucho más
    const mock = installFetchMock(() => ({
      status: 200,
      body: bigBody,
      headers: { 'content-length': String(64 * 1024 * 1024), 'content-type': 'image/jpeg' },
    }));
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      const phone = uniquePhone();
      const res = await http(t)
        .post('/webhooks/twilio')
        .type('form')
        .send({ From: `whatsapp:${phone}`, Body: 'foto pesada', NumMedia: '1', MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages/MMh/Media/MEhuge`, MediaContentType0: 'image/jpeg' });
      expect(res.status).toBe(200);

      const call = publishSpy.mock.calls.find(
        (c) => c[0] === 'whatsapp.incoming' && (c[1] as any).data?.from === phone,
      );
      // SEGURO (deseado): con un tope de bytes / chequeo de Content-Length, el adjunto gigante
      // se rechaza y no viaja ningún attachment. Hoy no hay tope: se descarga y guarda igual,
      // así que `attachments` trae 1 y este assert falla → por eso va con `it.failing`.
      expect((call![1] as any).data.attachments).toHaveLength(0);
    } finally {
      publishSpy.mockRestore();
      mock.restore();
    }
  });

  it('BE-TWA-15: el webhook de Twilio publica en whatsapp.incoming SIN tenantId (la empresa se resuelve aguas abajo por membresía, ver inbound-tenant-routing.e2e)', async () => {
    // El ruteo por config (TWILIO_TENANT_ID + fallback al tenant más viejo) se eliminó: el
    // webhook ya no resuelve la empresa, solo publica el mensaje. La resolución por membresía
    // del teléfono vive en InboundTenantRoutingService y se prueba en su propio spec.
    const publishSpy = jest.spyOn(broker, 'publish');
    try {
      const phone = uniquePhone();
      const res = await http(t)
        .post('/webhooks/twilio')
        .type('form')
        .send({ From: `whatsapp:${phone}`, Body: 'hola' });
      expect(res.status).toBe(200);

      const call = publishSpy.mock.calls.find(
        (c) => c[0] === 'whatsapp.incoming' && (c[1] as any).data?.from === phone,
      );
      expect(call).toBeDefined();
      expect((call![1] as any).data).toMatchObject({ from: phone, body: 'hola', channel: 'whatsapp' });
      expect((call![1] as any).tenantId).toBeUndefined();
    } finally {
      publishSpy.mockRestore();
    }
  });
});
