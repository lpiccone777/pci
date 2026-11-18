import { EventEmitter } from 'events';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { BrokerService } from './broker.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/** Canal falso: se comporta como el de amqplib una vez cerrado (tira / rechaza). */
class FakeChannel extends EventEmitter {
  closed = false;
  consumeImpl: () => Promise<unknown> = () => Promise.resolve({ consumerTag: 't' });
  assertQueue = jest.fn(async () => {
    if (this.closed) throw new Error('Channel closed');
    return {};
  });
  assertExchange = jest.fn(async () => ({}));
  sendToQueue = jest.fn(() => {
    if (this.closed) throw new Error('Channel closed');
    return true;
  });
  consume = jest.fn(() => this.consumeImpl());
  ack = jest.fn();
  nack = jest.fn();
}

class FakeConnection extends EventEmitter {
  constructor(public channel: FakeChannel) {
    super();
  }
  createChannel = jest.fn(async () => this.channel);
  close = jest.fn(async () => {
    if (this.channel.closed) throw new Error('Connection closed');
    this.channel.closed = true;
    this.channel.emit('close');
    this.emit('close');
  });
  /** Lo que pasa cuando RabbitMQ se reinicia: CONNECTION_FORCED. */
  serverShutdown() {
    this.channel.closed = true;
    this.emit('error', new Error('CONNECTION_FORCED - broker forced connection closure'));
    this.channel.emit('close');
    this.emit('close');
  }
}

describe('BrokerService ante reinicios de RabbitMQ', () => {
  const connect = amqp.connect as unknown as jest.Mock;
  let service: BrokerService;
  let unhandled: unknown[];
  const onUnhandled = (err: unknown) => unhandled.push(err);

  beforeEach(() => {
    jest.useFakeTimers();
    connect.mockReset();
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    const config = { getOrThrow: () => 'amqp://test' } as unknown as ConfigService;
    service = new BrokerService(config);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    process.off('unhandledRejection', onUnhandled);
    jest.useRealTimers();
  });

  it('con la conexión caída, publish() devuelve false en vez de operar sobre el canal muerto', async () => {
    const conn = new FakeConnection(new FakeChannel());
    connect.mockResolvedValueOnce(conn);
    await service.onModuleInit();

    conn.serverShutdown();

    await expect(service.publish('q', { pattern: 'x', data: {} })).resolves.toBe(false);
    expect(conn.channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('agenda una sola reconexión y re-suscribe los handlers', async () => {
    const first = new FakeConnection(new FakeChannel());
    const second = new FakeConnection(new FakeChannel());
    connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await service.onModuleInit();
    await service.subscribe('whatsapp.incoming', () => undefined);

    first.serverShutdown();
    await jest.advanceTimersByTimeAsync(5000);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.channel.consume).toHaveBeenCalledWith('whatsapp.incoming', expect.any(Function));
    await expect(service.publish('q', { pattern: 'x', data: {} })).resolves.toBe(true);
  });

  it('si la reconexión falla a mitad de camino, cierra esa conexión y no duplica reintentos', async () => {
    const first = new FakeConnection(new FakeChannel());
    const broken = new FakeChannel();
    broken.assertQueue.mockRejectedValue(new Error('Channel closed'));
    const half = new FakeConnection(broken);
    const third = new FakeConnection(new FakeChannel());
    connect.mockResolvedValueOnce(first).mockResolvedValueOnce(half).mockResolvedValueOnce(third);
    await service.onModuleInit();
    await service.subscribe('q', () => undefined);

    first.serverShutdown();
    await jest.advanceTimersByTimeAsync(5000); // intento 2: falla al re-declarar colas
    expect(half.close).toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5000); // intento 3: ok
    await jest.advanceTimersByTimeAsync(20000); // no debería haber más intentos

    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('un consume() rechazado no deja una promesa sin manejar (no tumba el proceso)', async () => {
    const channel = new FakeChannel();
    channel.consumeImpl = () => Promise.reject(new Error('Channel closed'));
    connect.mockResolvedValueOnce(new FakeConnection(channel));
    await service.onModuleInit();

    await expect(service.subscribe('q', () => undefined)).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(0);

    expect(unhandled).toEqual([]);
  });

  it('un error de canal o de conexión sin listener no revienta el EventEmitter', async () => {
    const conn = new FakeConnection(new FakeChannel());
    connect.mockResolvedValueOnce(conn);
    await service.onModuleInit();

    expect(() => conn.channel.emit('error', new Error('PRECONDITION_FAILED'))).not.toThrow();
    expect(() => conn.emit('error', new Error('boom'))).not.toThrow();
  });

  it('request() falla limpio si no puede armar la cola de respuesta, y reintenta en el próximo', async () => {
    const channel = new FakeChannel();
    channel.consumeImpl = () => Promise.reject(new Error('Channel closed'));
    connect.mockResolvedValueOnce(new FakeConnection(channel));
    await service.onModuleInit();

    await expect(service.request('q', { pattern: 'x', data: {} })).rejects.toThrow('Channel closed');
    channel.consumeImpl = () => Promise.resolve({ consumerTag: 't' });
    const pending = service.request('q', { pattern: 'x', data: {} }, { timeoutMs: 10 });
    const settled = expect(pending).rejects.toThrow('Sin respuesta');
    await jest.advanceTimersByTimeAsync(10);
    await settled;
    expect(channel.sendToQueue).toHaveBeenCalledTimes(1);
  });
});
