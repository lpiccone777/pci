import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';

export interface BrokerMessage {
  pattern: string;
  data: unknown;
  tenantId?: string;
  timestamp?: string;
}

export type MessageHandler = (msg: BrokerMessage) => Promise<void> | void;

@Injectable()
export class BrokerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrokerService.name);
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private readonly handlers = new Map<string, MessageHandler[]>();

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

  async publish(queue: string, message: BrokerMessage): Promise<boolean> {
    if (!this.channel) {
      this.logger.warn('Cannot publish: channel not ready');
      return false;
    }
    await this.channel.assertQueue(queue, { durable: true });
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
    this.channel.consume(queue, async (msg) => {
      if (!msg) return;
      try {
        const content = JSON.parse(msg.content.toString()) as BrokerMessage;
        await handler(content);
        this.channel!.ack(msg);
      } catch (err) {
        this.logger.error('Error processing message', err);
        this.channel!.nack(msg, false, false); // dead-letter or discard
      }
    });
  }
}
