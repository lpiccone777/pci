import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as amqp from 'amqplib';

export interface BrokerMessage {
  pattern: string;
  data: unknown;
  tenantId?: string;
  timestamp?: string;
  /** Patrón RPC: id que correlaciona una respuesta con su request original. */
  correlationId?: string;
  /** Patrón RPC: cola donde el consumidor debe publicar la respuesta. */
  replyTo?: string;
}

export type MessageHandler = (msg: BrokerMessage) => Promise<void> | void;

interface PendingRequest {
  resolve: (msg: BrokerMessage) => void;
  reject: (err: Error) => void;
}

@Injectable()
export class BrokerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrokerService.name);
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private readonly handlers = new Map<string, MessageHandler[]>();

  // --- Patrón RPC (request/reply) ---
  // Una única cola de respuesta, anónima y exclusiva de esta conexión (el patrón
  // estándar de RabbitMQ para RPC): el propio broker le asigna un nombre único, y
  // la destruye sola cuando la conexión se cierra. No hay que declarar una cola de
  // salida fija por cada llamador ni por cada request.
  private replyQueueName: string | null = null;
  private replyConsumerReady: Promise<void> | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  private async connect() {
    const url = this.config.getOrThrow<string>('RABBITMQ_URL');
    try {
      this.connection = await amqp.connect(url);
      this.channel = await this.connection.createChannel();

      this.connection.on('error', (err) => {
        this.logger.error('RabbitMQ connection error', err);
      });
      this.connection.on('close', () => {
        this.logger.warn('RabbitMQ connection closed. Reconnecting in 5s...');
        setTimeout(() => this.connect(), 5000);
      });

      this.logger.log('RabbitMQ connected');

      // La cola de respuesta RPC es exclusiva de la conexión anterior: al reconectar
      // ya no existe, hay que crearla de nuevo en el próximo request(). Cualquier
      // request que haya quedado pendiente durante el corte simplemente expira por
      // su propio timeout — no hay forma de saber si la reconexión llegó a tiempo.
      this.replyQueueName = null;
      this.replyConsumerReady = null;

      // Re-suscribe handlers si hay reconnection
      for (const [queue, queueHandlers] of this.handlers) {
        await this.channel.assertQueue(queue, { durable: true });
        for (const handler of queueHandlers) {
          this.setupConsumer(queue, handler);
        }
      }
    } catch (err) {
      this.logger.error('Failed to connect to RabbitMQ', err);
      setTimeout(() => this.connect(), 5000);
    }
  }

  private async disconnect() {
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      // ignore
    }
  }

  /**
   * `opts.assert: false` salta el `assertQueue` previo al envío. Hace falta para
   * publicar contra la cola de respuesta RPC (`request()`/`ensureReplyConsumer()`):
   * esa cola ya se declaró como `exclusive: true`, y volver a afirmarla acá con
   * `{ durable: true }` a secas (sin `exclusive: true`) hace que RabbitMQ vea una
   * declaración con propiedades distintas a la original y cierre el canal con
   * 405 RESOURCE_LOCKED — el reply nunca llega y el request queda esperando hasta
   * el timeout. El resto de las colas (reales o `whatsapp.simulate.incoming`) usan
   * el default y siguen afirmándose igual que siempre.
   */
  async publish(
    queue: string,
    message: BrokerMessage,
    opts: { assert?: boolean } = {},
  ): Promise<boolean> {
    if (!this.channel) {
      this.logger.warn('Cannot publish: channel not ready');
      return false;
    }
    if (opts.assert !== false) {
      await this.channel.assertQueue(queue, { durable: true });
    }
    const sent = this.channel.sendToQueue(
      queue,
      Buffer.from(JSON.stringify(message)),
      { persistent: true },
    );
    return sent;
  }

  async subscribe(queue: string, handler: MessageHandler) {
    if (!this.handlers.has(queue)) {
      this.handlers.set(queue, []);
    }
    this.handlers.get(queue)!.push(handler);

    if (this.channel) {
      await this.channel.assertQueue(queue, { durable: true });
      this.setupConsumer(queue, handler);
    }
  }

  private setupConsumer(queue: string, handler: MessageHandler) {
    if (!this.channel) return;
    // Capturado en una constante: si RabbitMQ cierra la conexión mientras este
    // consumer está procesando un mensaje, `this.channel` puede haber cambiado (o
    // quedar null) para cuando el callback termina. Operar sobre el canal con el
    // que se registró el consumer, no sobre el que sea `this.channel` en ese momento.
    const channel = this.channel;
    channel.consume(queue, async (msg) => {
      if (!msg) return;
      try {
        const content = JSON.parse(msg.content.toString()) as BrokerMessage;
        await handler(content);
        this.safeAck(channel, msg);
      } catch (err) {
        this.logger.error('Error processing message', err);
        this.safeNack(channel, msg);
      }
    });
  }

  /**
   * `channel.nack()` explota de forma sincrónica (no rechaza una promesa: tira una
   * excepción) si el canal ya está cerrado — por ejemplo porque RabbitMQ cortó la
   * conexión mientras procesábamos el mensaje. Sin este try/catch esa excepción
   * queda sin capturar dentro del callback de `consume()` y tira abajo **todo el
   * proceso Node**, no solo el mensaje en curso. Ya pasó una vez con el reject de
   * una cola inválida.
   */
  private safeNack(channel: amqp.Channel, msg: amqp.ConsumeMessage) {
    try {
      channel.nack(msg, false, false);
    } catch {
      this.logger.warn('No se pudo nack-ear el mensaje: el canal ya estaba cerrado');
    }
  }

  /** Mismo motivo que `safeNack`: `channel.ack()` también puede tirar sincrónico. */
  private safeAck(channel: amqp.Channel, msg: amqp.ConsumeMessage) {
    try {
      channel.ack(msg);
    } catch {
      this.logger.warn('No se pudo ack-ear el mensaje: el canal ya estaba cerrado');
    }
  }

  /**
   * Publica `message` en `queue` y espera —de verdad, a través del broker— la
   * respuesta correlacionada. Es el patrón RPC estándar de RabbitMQ: una cola de
   * respuesta anónima y exclusiva de esta conexión, más un `correlationId` por
   * request para saber qué respuesta le pertenece a cuál llamada.
   *
   * Pensado para simular el flujo real end-to-end (publish → consume → publish)
   * en vez de invocar el handler en proceso. El productor real de mensajes
   * (webhook de WhatsApp) nunca usa esto: solo publica con `publish()` y sigue,
   * porque ahí no hay nadie esperando una respuesta sincrónica.
   *
   * Limitación conocida: si corren varias instancias de este proceso contra el
   * mismo RabbitMQ, la respuesta puede volver a una instancia distinta de la que
   * hizo el request — la cola de respuesta es anónima y exclusiva por conexión,
   * no por request. Con una sola instancia (el caso de desarrollo hoy) no aplica.
   */
  async request(
    queue: string,
    message: Omit<BrokerMessage, 'correlationId' | 'replyTo'>,
    opts: { timeoutMs?: number } = {},
  ): Promise<BrokerMessage> {
    const replyQueue = await this.ensureReplyConsumer();
    const correlationId = randomUUID();
    const timeoutMs = opts.timeoutMs ?? 30_000;

    const result = new Promise<BrokerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(
          new Error(
            `Sin respuesta de '${queue}' después de ${timeoutMs}ms (correlationId=${correlationId})`,
          ),
        );
      }, timeoutMs);

      this.pendingRequests.set(correlationId, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });

    const sent = await this.publish(queue, { ...message, correlationId, replyTo: replyQueue });
    if (!sent) {
      this.pendingRequests.delete(correlationId);
      throw new Error(`No se pudo publicar en '${queue}': RabbitMQ no está conectado`);
    }

    return result;
  }

  /** Crea (una sola vez por conexión) la cola anónima de respuestas RPC y su consumer. */
  private async ensureReplyConsumer(): Promise<string> {
    if (this.replyQueueName) return this.replyQueueName;

    if (!this.replyConsumerReady) {
      this.replyConsumerReady = (async () => {
        if (!this.channel) throw new Error('RabbitMQ channel no disponible');
        const channel = this.channel;

        // Nombre propio, no vacío: `assertQueue('', ...)` le pide a RabbitMQ que
        // genere el nombre, y el broker los nombra `amq.gen-*` — pero `amq.*` es
        // un namespace reservado del servidor, y este RabbitMQ (como muchos, según
        // su config) rechaza que un cliente declare una cola con ese prefijo. El
        // exclusive+autoDelete es lo que la hace efímera, no el nombre vacío.
        const queueName = `whatsapp.rpc.reply.${randomUUID()}`;
        // `durable: true` acá aunque sea exclusive: `publish()` reafirma cualquier
        // cola de destino con `durable: true` (línea de abajo, en publish()), y
        // `handleMessage` publica la respuesta contra esta cola vía ese mismo
        // `publish()`. Si las propiedades no coinciden con las de la declaración
        // original, RabbitMQ no lo tolera silenciosamente: cierra la conexión
        // entera con 406 (PRECONDITION_FAILED) — así se armó una tormenta de
        // reconexiones la primera vez que probé esto.
        await channel.assertQueue(queueName, { exclusive: true, durable: true, autoDelete: true });
        this.replyQueueName = queueName;

        channel.consume(
          queueName,
          (msg) => {
            if (!msg) return;

            try {
              const content = JSON.parse(msg.content.toString()) as BrokerMessage;
              const pending = content.correlationId
                ? this.pendingRequests.get(content.correlationId)
                : undefined;

              if (pending) {
                this.pendingRequests.delete(content.correlationId!);
                pending.resolve(content);
              }
              // Sin match: nadie espera esta respuesta (timeout ya venció). Se
              // descarta — se ack-ea igual, no vuelve a la cola.
            } catch (err) {
              this.logger.error('Respuesta RPC con formato inválido', err);
            } finally {
              this.safeAck(channel, msg);
            }
          },
          { noAck: false },
        );
      })();
    }

    await this.replyConsumerReady;
    return this.replyQueueName!;
  }
}
