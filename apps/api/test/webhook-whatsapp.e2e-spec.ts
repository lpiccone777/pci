/**
 * 1.12 Webhook de WhatsApp — recepción (BE-WHK-*)
 *
 * Vía: GET/POST reales a `/webhooks/whatsapp` con supertest (`WhatsAppWebhookController`, sin
 * `JwtAuthGuard` a propósito — Meta no manda ningún token nuestro).
 *
 * Cómo se observa "publicó en whatsapp.incoming": con un `jest.spyOn(broker, 'publish')`
 * SIN `mockImplementation` (passthrough: la implementación real sigue corriendo, RabbitMQ
 * recibe el mensaje igual) en vez de suscribir un segundo consumidor de test a esa cola.
 *
 * Motivo (gotcha real, no cosmético): `ConversationsService` YA es un consumidor real de
 * 'whatsapp.incoming' — se suscribe en su propio `onModuleInit`
 * (`conversations.service.ts:127`) dentro de la MISMA app que levanta `createTestApp()`. Un
 * segundo `broker.subscribe('whatsapp.incoming', ...)` de test competiría, mensaje a mensaje,
 * contra ese consumidor real (RabbitMQ reparte por round-robin entre los consumer tags de una
 * misma cola) — el mensaje llegaría al handler de test de forma no determinística, dejando el
 * spec flaky. Espiar `publish()` deja correr el código real tal cual (nada mockeado, ni el
 * broker ni el controller) y observa exactamente lo que el controller mandó, sin esa carrera.
 */
import { createTestApp, TestApp, http, setSetting, deleteSetting } from './support';
import { BrokerService, BrokerMessage } from '../src/modules/broker/broker.service';

const WEBHOOK_PATH = '/webhooks/whatsapp';

describe('1.12 Webhook de WhatsApp — recepción (BE-WHK-*)', () => {
  let t: TestApp;
  let broker: BrokerService;
  let publishSpy: jest.SpyInstance;

  beforeAll(async () => {
    t = await createTestApp();
    broker = t.moduleRef.get(BrokerService);
  });

  afterAll(async () => {
    // Cada mensaje que publicamos de verdad en whatsapp.incoming también lo levanta
    // ConversationsService (consumidor real, mismo app) y sigue procesándolo de fondo —
    // orchestratorLlm falla (sin OPENAI_API_KEY en el entorno de test) pero igual arma una
    // respuesta de fallback y la publica en whatsapp.outgoing (conversations.service.ts:349).
    // Si `t.close()` corta el channel de RabbitMQ mientras ese publish todavía está en vuelo,
    // truena con IllegalOperationError ("Channel closed"/"Channel closing") — no rompe estos
    // tests (el error queda contenido en el catch de BrokerService), pero sí ensucia los logs
    // y, en corridas largas junto a otros specs, puede arrastrar reintentos de reconexión del
    // BrokerService hasta bien entrado el siguiente archivo. Un margen corto acá le da tiempo
    // a esa cola de trabajo de fondo (LLM fallido + guardar mensaje + publish) para terminar
    // ANTES de cerrar la app, en vez de competir con el cierre.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await t.close();
  });

  beforeEach(() => {
    publishSpy = jest.spyOn(broker, 'publish');
  });

  afterEach(async () => {
    publishSpy.mockRestore();
    await deleteSetting(t.prisma, 'WHATSAPP_WEBHOOK_VERIFY_TOKEN');
  });

  /** Solo las publicaciones dirigidas a `whatsapp.incoming` (el controller no publica en otra cola). */
  function incomingCalls(): Array<[string, BrokerMessage]> {
    return publishSpy.mock.calls.filter((call) => call[0] === 'whatsapp.incoming') as Array<
      [string, BrokerMessage]
    >;
  }

  // --- GET de verificación (handshake de Meta) ---

  it('BE-WHK-01: GET de verificación con hub.verify_token correcto y mode=subscribe devuelve el challenge', async () => {
    await setSetting(t.prisma, 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'token-secreto-01');

    const res = await http(t).get(WEBHOOK_PATH).query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'token-secreto-01',
      'hub.challenge': 'reto-123',
    });

    expect(res.status).toBe(200);
    expect(res.text).toBe('reto-123');
    // El controller devuelve un string sin fijar Content-Type: Express (res.send(string)) lo
    // resuelve a text/html por default. Es el comportamiento real, aunque el plan diga otra cosa.
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('BE-WHK-02: GET de verificación con token incorrecto devuelve 403 "verify_token inválido"', async () => {
    await setSetting(t.prisma, 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'token-secreto-02');

    const res = await http(t).get(WEBHOOK_PATH).query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'token-equivocado',
      'hub.challenge': 'reto-456',
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('verify_token inválido');
  });

  // --- POST de mensajes entrantes ---

  it('BE-WHK-03: POST con un mensaje de texto responde 200 {status:ok} y publica {from,body} en whatsapp.incoming (sin tenantId: la empresa se resuelve aguas abajo)', async () => {
    const from = '5491122334455';

    const res = await http(t)
      .post(WEBHOOK_PATH)
      .send({
        entry: [
          { changes: [{ value: { messages: [{ from, type: 'text', text: { body: 'Hola, necesito ayuda' } }] } }] },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(incomingCalls()).toHaveLength(1);
    const [, message] = incomingCalls()[0];
    expect(message.data).toEqual({ from: `+${from}`, body: 'Hola, necesito ayuda', channel: 'whatsapp' });
    expect(message.tenantId).toBeUndefined();
    expect(message.pattern).toBe('message.received');
  });

  it('BE-WHK-04: POST con una respuesta interactiva (botón o lista) publica el id de la opción como body', async () => {
    const resBoton = await http(t)
      .post(WEBHOOK_PATH)
      .send({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: '5491122334456',
                      type: 'interactive',
                      interactive: { type: 'button_reply', button_reply: { id: 'opcion_si', title: 'Sí' } },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
    expect(resBoton.status).toBe(200);

    const resLista = await http(t)
      .post(WEBHOOK_PATH)
      .send({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: '5491122334457',
                      type: 'interactive',
                      interactive: {
                        type: 'list_reply',
                        list_reply: { id: 'opcion_soporte', title: 'Soporte técnico' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
    expect(resLista.status).toBe(200);

    expect(incomingCalls()).toHaveLength(2);
    expect(incomingCalls()[0][1].data).toEqual({ from: '+5491122334456', body: 'opcion_si', channel: 'whatsapp' });
    expect(incomingCalls()[1][1].data).toEqual({
      from: '+5491122334457',
      body: 'opcion_soporte',
      channel: 'whatsapp',
    });
  });

  it('BE-WHK-05: POST con un tipo no soportado (imagen) ignora ese mensaje y responde 200 igual', async () => {
    const res = await http(t)
      .post(WEBHOOK_PATH)
      .send({ entry: [{ changes: [{ value: { messages: [{ from: '5491100000000', type: 'image' }] } }] }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(incomingCalls()).toHaveLength(0);
  });

  it('BE-WHK-06: POST sin "messages" (ej. statuses de entrega) responde 200 sin publicar nada', async () => {
    const res = await http(t)
      .post(WEBHOOK_PATH)
      .send({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.entrega1', status: 'delivered' }] } }] }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(incomingCalls()).toHaveLength(0);
  });

  // --- BE-WHK-08 (SEC-04): el POST debe validar X-Hub-Signature-256 antes de encolar ---
  it.failing('BE-WHK-08: POST sin X-Hub-Signature-256 válida debe rechazarse antes de encolar (SEC-04) @invertido', async () => {
    const res = await http(t)
      .post(WEBHOOK_PATH)
      // Sin X-Hub-Signature-256 (Meta firma cada POST con el App Secret configurado en la app).
      .send({
        entry: [{ changes: [{ value: { messages: [{ from: '5491100000001', type: 'text', text: { body: 'sin firma' } }] } }] }],
      });

    // Comportamiento SEGURO esperado: rechazar antes de encolar (401/403).
    // Hoy no hay validación de X-Hub-Signature-256 en `whatsapp-webhook.controller.ts`: el POST
    // se procesa igual, responde 200 y publica en whatsapp.incoming sin verificar que venga
    // realmente de Meta — cualquiera que conozca la URL puede inyectar mensajes falsos.
    expect([401, 403]).toContain(res.status);
  });

  it('BE-WHK-09: POST "con firma válida" (hoy no se valida ninguna firma, el camino legítimo sigue funcionando) responde 200 y publica', async () => {
    // El código real no valida X-Hub-Signature-256 todavía (ver BE-WHK-08, SEC-04): el header se
    // manda igual, pero el controller lo ignora por completo. Este caso documenta que, el día que
    // se agregue la validación, el flujo legítimo (firma correcta) tiene que seguir dando este
    // mismo resultado — hoy da lo mismo mandar el header o no.
    const from = '5491100000002';

    const res = await http(t)
      .post(WEBHOOK_PATH)
      .set('X-Hub-Signature-256', 'sha256=firma-de-ejemplo-ignorada-hoy')
      .send({ entry: [{ changes: [{ value: { messages: [{ from, type: 'text', text: { body: 'con firma' } }] } }] }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(incomingCalls()).toHaveLength(1);
    expect(incomingCalls()[0][1].data).toEqual({ from: `+${from}`, body: 'con firma', channel: 'whatsapp' });
  });

});
