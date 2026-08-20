/**
 * 1.11 Broker RabbitMQ — mecánica (BE-BRK-*)
 *
 * Vía: `BrokerService` REAL, obtenido de la app (`t.moduleRef.get(BrokerService)`), contra el
 * vhost de RabbitMQ EFÍMERO real que arma `global-setup.ts`. No se mockea el broker — es
 * exactamente la lógica bajo prueba — así que cada `request()`/`publish()`/`subscribe()` viaja
 * de verdad por el broker. Cada test usa colas propias (`test.rpc.*`, con `uid()`) para no
 * pisarse entre sí ni con las colas de producción (`whatsapp.*`).
 *
 * Como `BrokerService` no expone un `unsubscribe()`, los `subscribe()` que arma cada test viven
 * hasta que `t.close()` cierra la conexión entera en `afterAll` — es la única forma de "limpiar"
 * que ofrece la API real.
 *
 * Varios casos (BE-BRK-03/04/08/10) leen/pisan campos privados de `BrokerService` vía
 * `(broker as any)`. No es un capricho: son los únicos puntos de la clase real donde se puede
 * observar o forzar esos bordes (canal caído, nombre de la reply queue, ack sobre canal cerrado)
 * sin cerrar la conexión compartida que usan el resto de los tests del archivo.
 */
import * as amqp from 'amqplib';
import { createTestApp, TestApp, uid } from './support';
import { BrokerService, BrokerMessage } from '../src/modules/broker/broker.service';

describe('1.11 Broker RabbitMQ — mecánica (BE-BRK-*)', () => {
  let t: TestApp;
  let broker: BrokerService;

  beforeAll(async () => {
    t = await createTestApp();
    broker = t.moduleRef.get(BrokerService);
  });

  afterAll(async () => {
    await t.close();
  });

  it('BE-BRK-01: request() a una cola con un consumidor que responde resuelve con la respuesta correlacionada', async () => {
    const queue = `test.rpc.${uid()}`;

    // El "consumidor externo" responde por el patrón RPC real: publica en `msg.replyTo`
    // ecoando `msg.correlationId`, tal como documenta `request()` en broker.service.ts.
    await broker.subscribe(queue, async (msg) => {
      await broker.publish(
        msg.replyTo!,
        { pattern: 'reply', data: { echo: msg.data }, correlationId: msg.correlationId },
        { assert: false },
      );
    });

    const res = await broker.request(queue, { pattern: 'ping', data: { n: 1 } }, { timeoutMs: 5000 });

    // Viajó de verdad por el broker (publish → consume → publish → consume), no fue el handler
    // invocado en proceso: `res` es lo que el consumidor publicó, correlacionado por su propio
    // correlationId (no algo devuelto in-memory).
    expect(res.correlationId).toBeDefined();
    expect(res.data).toEqual({ echo: { n: 1 } });
  });

  it('BE-BRK-02: request() sin respuesta dentro del timeout rechaza y limpia el pending', async () => {
    const queue = `test.rpc.${uid()}`; // nadie escucha esta cola
    const sizeBefore = (broker as any).pendingRequests.size;

    await expect(
      broker.request(queue, { pattern: 'ping', data: {} }, { timeoutMs: 500 }),
    ).rejects.toThrow(new RegExp(`Sin respuesta de '${queue}' después de 500ms`));

    // `pendingRequests.delete(correlationId)` corrió dentro del propio timeout: no queda
    // colgado un pending huérfano por cada request que expira.
    expect((broker as any).pendingRequests.size).toBe(sizeBefore);
  });

  it('BE-BRK-03: request() cuando RabbitMQ no está conectado lanza y limpia el pending', async () => {
    // Primero deja creada la reply queue con el channel real: así, al anular `channel` más
    // abajo, `ensureReplyConsumer()` no revienta con otro error distinto al que se quiere
    // probar (`publish()` devolviendo `false` dentro de `request()`).
    await (broker as any).ensureReplyConsumer();
    const realChannel = (broker as any).channel;
    const sizeBefore = (broker as any).pendingRequests.size;
    const queue = 'test.rpc.sin-conexion';

    // GOTCHA real del código (no se toca acá, solo se neutraliza para este test): cuando
    // `publish()` dentro de `request()` devuelve `false`, el código borra el pending y lanza
    // sincrónicamente ("No se pudo publicar...") — pero el `setTimeout` del timeout interno de
    // `result` (armado ANTES del publish, dentro del executor del `new Promise`) sigue vivo, y esa
    // promesa `result` nunca se retorna (el `throw` corta antes del `return result`) ni queda
    // encadenada a nada. Sin blindaje, ese timer dispara más tarde y rechaza una promesa sin
    // ningún handler → `unhandledRejection` real (confirmado: hace fallar el test en la corrida
    // sin este parche, aunque el `expect` de abajo ya haya pasado). Para este test puntual, la
    // única llamada a `setTimeout` que ocurre durante el `request()` de abajo es exactamente ESE
    // timer huérfano (la reply queue ya está creada, y con `channel=null` `publish()` resuelve
    // sincrónico sin I/O) — así que capturarlo y cancelarlo acá es preciso, no un parche a ciegas.
    const originalSetTimeout = global.setTimeout;
    const capturedTimers: ReturnType<typeof setTimeout>[] = [];
    (global as any).setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const handle = originalSetTimeout(fn, ms, ...args);
      capturedTimers.push(handle);
      return handle;
    }) as typeof setTimeout;

    (broker as any).channel = null;
    try {
      await expect(
        broker.request(queue, { pattern: 'ping', data: {} }),
      ).rejects.toThrow(`No se pudo publicar en '${queue}': RabbitMQ no está conectado`);
    } finally {
      global.setTimeout = originalSetTimeout;
      capturedTimers.forEach(clearTimeout);
      (broker as any).channel = realChannel;
    }

    expect((broker as any).pendingRequests.size).toBe(sizeBefore);
  });

  it('BE-BRK-04: publish() sin canal disponible devuelve false y no lanza', async () => {
    const realChannel = (broker as any).channel;
    (broker as any).channel = null;
    try {
      const result = await broker.publish('test.rpc.sin-canal', { pattern: 'ping', data: {} });
      expect(result).toBe(false);
    } finally {
      (broker as any).channel = realChannel;
    }
  });

  it('BE-BRK-05: publish() contra la reply queue exclusiva con { assert:false } no reafirma ni dispara 405', async () => {
    const queue = `test.rpc.${uid()}`;

    await broker.subscribe(queue, async (msg) => {
      // Exactamente el path que documenta el comentario de `publish()`: reafirmar la reply
      // queue (exclusive:true) sin `{ assert:false }` la reafirmaría como `durable:true` a
      // secas → 405 RESOURCE_LOCKED y cierre del canal.
      await broker.publish(
        msg.replyTo!,
        { pattern: 'reply', data: { ok: true }, correlationId: msg.correlationId },
        { assert: false },
      );
    });

    const res1 = await broker.request(queue, { pattern: 'ping', data: {} }, { timeoutMs: 5000 });
    expect(res1.data).toEqual({ ok: true });

    // Si el publish de arriba hubiese roto el canal con 405, este segundo round trip sobre la
    // MISMA conexión se quedaría esperando hasta el timeout en vez de resolver.
    const res2 = await broker.request(queue, { pattern: 'ping', data: { n: 2 } }, { timeoutMs: 5000 });
    expect(res2.data).toEqual({ ok: true });
  });

  it('BE-BRK-08: safeAck/safeNack sobre un canal ya cerrado no tiran (no cae el proceso)', async () => {
    // Canal DESCARTABLE, ajeno a la conexión real que usa `broker` — así se fuerza el borde sin
    // tocar la conexión compartida por el resto de los tests del archivo.
    const conn = await amqp.connect(process.env.RABBITMQ_URL!);
    const closedChannel = await conn.createChannel();
    await closedChannel.close();
    await conn.close();

    const fakeMsg = {
      content: Buffer.from('{}'),
      fields: { deliveryTag: 1, redelivered: false, exchange: '', routingKey: 'x' },
      properties: {},
    } as unknown as amqp.ConsumeMessage;

    // `safeAck`/`safeNack` son privados: se invocan vía `any` porque son el único punto de la
    // clase donde se puede ejercitar el try/catch documentado en el código sin tocar la
    // conexión real del broker bajo prueba.
    expect(() => (broker as any).safeAck(closedChannel, fakeMsg)).not.toThrow();
    expect(() => (broker as any).safeNack(closedChannel, fakeMsg)).not.toThrow();
  });

  it('BE-BRK-09: un mensaje con JSON inválido en la cola no tira el proceso y se descarta', async () => {
    const queue = `test.rpc.${uid()}`;
    const handler = jest.fn();
    await broker.subscribe(queue, handler);

    // `broker.publish()` siempre serializa JSON válido: para forzar este borde hay que
    // saltearlo y escribir basura directo por el channel real.
    (broker as any).channel.sendToQueue(queue, Buffer.from('{esto no es json'), { persistent: true });
    await new Promise((r) => setTimeout(r, 400));

    expect(handler).not.toHaveBeenCalled();

    // El canal sigue sano tras el JSON inválido: un mensaje válido posterior en la misma cola
    // se sigue procesando con normalidad (setupConsumer no quedó roto).
    const ok = await broker.publish(queue, { pattern: 'ping', data: { n: 1 } });
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('BE-BRK-10: la reply queue tiene nombre propio whatsapp.rpc.reply.*, nunca amq.gen-*', async () => {
    await (broker as any).ensureReplyConsumer();
    const name = (broker as any).replyQueueName as string;

    expect(name).toMatch(/^whatsapp\.rpc\.reply\.[0-9a-f-]+$/i);
    expect(name.startsWith('amq.')).toBe(false);
  });

  it('BE-BRK-11: requestViaQueue() resuelve por FIFO cuando el externo no ecoa correlationId', async () => {
    const sendQueue = `test.rpc.send.${uid()}`;
    const responseQueue = `test.rpc.fixed.${uid()}`;

    // Simula un externo (ej. un RAG) que responde SIEMPRE en su propia cola fija, sin
    // correlationId — el caso real que motiva `resolveOldestPendingForQueue`.
    await broker.subscribe(sendQueue, async (msg) => {
      await broker.publish(responseQueue, { pattern: 'reply', data: { answer: 'hola', eco: msg.data } });
    });

    const res = await broker.requestViaQueue(
      sendQueue,
      responseQueue,
      { pattern: 'ask', data: { q: 1 } },
      { timeoutMs: 5000 },
    );

    expect(res.data).toEqual({ answer: 'hola', eco: { q: 1 } });
    expect(res.correlationId).toBeUndefined(); // el externo nunca lo mandó: resolvió por FIFO
  });

  it('BE-BRK-13: un mensaje viejo sin consumir se atribuye por FIFO al request más nuevo', async () => {
    const responseQueue = `test.rpc.fixed.${uid()}`;
    const sendQueueOld = `test.rpc.send.old.${uid()}`;
    const sendQueueNew = `test.rpc.send.new.${uid()}`;

    // 1) Un primer request que nadie responde a tiempo: expira solo. `requestViaQueue` se
    //    auto-limpia de `pendingByQueue` en su propio timeout.
    await expect(
      broker.requestViaQueue(
        sendQueueOld,
        responseQueue,
        { pattern: 'ask', data: { who: 'vieja' } },
        { timeoutMs: 500 },
      ),
    ).rejects.toThrow(/Sin respuesta en/);

    // 2) Un segundo request: ahora es el único pendiente en la cola fija.
    const nuevo = broker.requestViaQueue(
      sendQueueNew,
      responseQueue,
      { pattern: 'ask', data: { who: 'nueva' } },
      { timeoutMs: 5000 },
    );

    // 3) Llega tarde una respuesta "vieja" (de la sesión ya expirada), sin correlationId: el
    //    fallback FIFO la asigna al request más antiguo que sigue pendiente en esa cola — que
    //    para este momento es el NUEVO, no el que la originó.
    await broker.publish(responseQueue, { pattern: 'reply', data: { answer: 'basura de la sesión vieja' } });

    const res = await nuevo;
    expect(res.data).toEqual({ answer: 'basura de la sesión vieja' });
  });

  describe('Reconexión de RabbitMQ (BE-BRK-06, BE-BRK-07)', () => {
    // App PROPIA y descartable: forzar el cierre de la conexión real de este `BrokerService` es
    // el único modo de ejercitar `connect()`/reconexión, y hacerlo sobre la conexión compartida
    // por el resto del archivo (`t`/`broker`) se llevaría puesto a todos los demás tests. Usar
    // una instancia aislada contiene el riesgo sin dejar de probar la mecánica real.
    let t2: TestApp;
    let broker2: BrokerService;

    beforeAll(async () => {
      t2 = await createTestApp();
      broker2 = t2.moduleRef.get(BrokerService);
    });

    afterAll(async () => {
      await t2.close();
    });

    it(
      'BE-BRK-06: tras una caída de la conexión, reconecta y re-suscribe los handlers',
      async () => {
        const queue = `test.rpc.reconnect.${uid()}`;
        const received: BrokerMessage[] = [];
        await broker2.subscribe(queue, async (msg) => {
          received.push(msg);
        });

        // GOTCHA real del código (no se toca acá): `setupConsumer` llama `channel.consume(...)`
        // sin `await` ni `.catch()` — es una promesa flotante. Si se corta la conexión mientras
        // esa RPC de consumo todavía no volvió, amqplib la rechaza con "Channel ended, no reply
        // will be forthcoming" y, al no tener handler, sale como `unhandledRejection`. Este margen
        // le da tiempo de sobra a esa RPC (round trip local, ~ms) para terminar ANTES de forzar el
        // corte más abajo, así el test ejercita la reconexión sin pisar ese borde no relacionado.
        await new Promise((r) => setTimeout(r, 300));

        // Cierra la conexión real (no solo el canal): dispara el 'close' del ChannelModel, que
        // en el código real agenda `setTimeout(() => this.connect(), 5000)`.
        const connectionBeforeDrop = (broker2 as any).connection;
        await connectionBeforeDrop.close();

        // Espera a que reconecte (5s fijos en el código) + margen.
        await new Promise((r) => setTimeout(r, 7000));

        expect((broker2 as any).connection).not.toBe(connectionBeforeDrop); // conexión NUEVA
        expect((broker2 as any).channel).not.toBeNull();

        // Prueba de fuego: publicar sobre la conexión nueva debe seguir llegando al handler
        // re-suscripto — no quedó huérfano tras la reconexión.
        await broker2.publish(queue, { pattern: 'ping', data: { after: 'reconnect' } });
        await new Promise((r) => setTimeout(r, 500));
        expect(received.some((m) => (m.data as any)?.after === 'reconnect')).toBe(true);
      },
      20_000,
    );

    it(
      'BE-BRK-07: un request() en vuelo durante la caída expira por su propio timeout, no se recupera',
      async () => {
        const queue = `test.rpc.inflight.${uid()}`; // nadie responde jamás

        const pending = broker2.request(queue, { pattern: 'ping', data: {} }, { timeoutMs: 3000 });
        // Deja que el publish salga antes de cortar la conexión.
        await new Promise((r) => setTimeout(r, 200));
        await (broker2 as any).connection.close();

        const start = Date.now();
        await expect(pending).rejects.toThrow(/Sin respuesta de/);
        const elapsed = Date.now() - start;

        // No se resuelve/rechaza apenas cae la conexión: espera su propio timeout (~3000ms desde
        // que se creó, ~2800ms desde este punto), tal como documenta el comentario de `connect()`
        // ("no hay forma de saber si la reconexión llegó a tiempo").
        expect(elapsed).toBeGreaterThanOrEqual(2400);
      },
      15_000,
    );
  });

  describe('Cola de respuesta fija — límite de un solo consumidor (BE-BRK-12)', () => {
    // Segunda app/instancia de BrokerService: para que RabbitMQ reparta por round-robin entre
    // DOS consumidores reales hace falta una segunda conexión, no alcanza con dos requests desde
    // el mismo `broker`.
    let t3: TestApp;
    let broker3: BrokerService;

    beforeAll(async () => {
      t3 = await createTestApp();
      broker3 = t3.moduleRef.get(BrokerService);
    });

    afterAll(async () => {
      await t3.close();
    });

    it(
      'BE-BRK-12: dos consumidores compitiendo por la misma cola fija — uno resuelve, el otro expira',
      async () => {
        const responseQueue = `test.rpc.fixed.${uid()}`;
        const sendQueueA = `test.rpc.send.a.${uid()}`;
        const sendQueueB = `test.rpc.send.b.${uid()}`;

        // Ambas instancias declaran consumer sobre LA MISMA cola fija: RabbitMQ reparte por
        // round-robin entre los dos, sin mirar correlationId (documentado en el código real).
        const reqA = broker.requestViaQueue(
          sendQueueA,
          responseQueue,
          { pattern: 'ask', data: { who: 'A' } },
          { timeoutMs: 2500 },
        );
        const reqB = broker3.requestViaQueue(
          sendQueueB,
          responseQueue,
          { pattern: 'ask', data: { who: 'B' } },
          { timeoutMs: 2500 },
        );

        // Da tiempo a que ambos consumers queden registrados antes de la única respuesta.
        await new Promise((r) => setTimeout(r, 300));
        await broker.publish(responseQueue, { pattern: 'reply', data: { answer: 'única respuesta' } });

        const results = await Promise.allSettled([reqA, reqB]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        // Limitación documentada en el código: la respuesta va a UNO solo de los dos (cuál, no es
        // determinístico); el otro expira por su propio timeout. Nunca los dos, nunca ninguno.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/Sin respuesta en/);
      },
      10_000,
    );
  });
});
