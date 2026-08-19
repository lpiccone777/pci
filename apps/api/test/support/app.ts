/**
 * Factory de la app Nest para los tests e2e.
 *
 * Levanta el `AppModule` REAL sobre la base efímera y el vhost de RabbitMQ efímero que
 * preparó `global-setup.ts`. Aplica el **mismo `ValidationPipe` global que `main.ts`**
 * (whitelist + forbidNonWhitelisted + transform): sin esto, los casos de "400 por campo
 * fuera del DTO" (BE-FLW-02, BE-ARE-16, etc.) pasarían por el motivo equivocado.
 *
 * Reemplaza por defecto el `EmailService` real por un grabador en memoria
 * (`RecordingEmailService`): así los tests de OTP pueden leer el código enviado y el canal
 * de correo nunca toca un SMTP real. Es la única frontera externa que se mockea por defecto;
 * el resto (LLM, HTTP de Meta/Twilio/Gupshup/InvGate) se overridea por test vía `customize`.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EmailService } from '../../src/modules/auth/email.service';
import { BrokerService } from '../../src/modules/broker/broker.service';
import { RecordingEmailService } from './mocks';
import { createEphemeralVhost, deleteEphemeralVhost } from './broker-vhost';

export interface TestAppOptions {
  /**
   * Overridear providers antes de compilar (mocks de frontera externa: LLM, fetch, etc.).
   * Recibe el builder y debe devolverlo:
   *   customize: (b) => b.overrideProvider(LlmService).useValue(fakeLlm),
   */
  customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /** Si `false`, no reemplaza `EmailService` por el grabador. Default: `true`. */
  recordEmail?: boolean;
}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  moduleRef: TestingModule;
  /** Emails capturados (códigos OTP, notificaciones de transferencia). */
  email: RecordingEmailService;
  /** Cierra la app (y con ella la conexión a RabbitMQ y Prisma). */
  close: () => Promise<void>;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const email = new RecordingEmailService();

  // Aislar el broker de ESTE spec en su propio vhost efímero (ver broker-vhost.ts): sin esto,
  // todas las apps comparten las colas del vhost de la corrida y se contaminan entre specs.
  // Se apunta `RABBITMQ_URL` al vhost nuevo ANTES de compilar (BrokerService lo lee al conectar,
  // en onModuleInit) y se restaura apenas la app quedó conectada.
  const savedRabbitUrl = process.env.RABBITMQ_URL;
  const vhost = await createEphemeralVhost();
  if (vhost) process.env.RABBITMQ_URL = vhost.url;

  let moduleRef: TestingModule;
  let app: import('@nestjs/common').INestApplication;
  try {
    let builder: TestingModuleBuilder = Test.createTestingModule({ imports: [AppModule] });

    if (options.recordEmail !== false) {
      builder = builder.overrideProvider(EmailService).useValue(email);
    }
    if (options.customize) {
      builder = options.customize(builder);
    }

    moduleRef = await builder.compile();
    app = moduleRef.createNestApplication();

    // Mismo pipe global que `main.ts`. Imprescindible para los casos de whitelist/validación.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );

    await app.init();

    // Settle: `BrokerService.setupConsumer` llama `channel.consume(...)` SIN await (promesa
    // flotante — bug real de producción). Si la app se cierra antes de que esas RPC de registro
    // resuelvan (típico en specs que crean y cierran una segunda app rápido, como BE-AUTH-25),
    // amqplib las rechaza al cerrar el canal con "Channel ended, no reply will be forthcoming",
    // un unhandledRejection que Jest le adjudica al test en curso. Darles ~300ms para asentarse
    // evita esa carrera en el teardown, sin tocar el código de producción.
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    // La app ya capturó su URL al conectar: devolvemos el env global para no afectar a nadie más
    // (la próxima app deriva su vhost del mismo servidor de la corrida).
    if (vhost) process.env.RABBITMQ_URL = savedRabbitUrl;
  }

  const prisma = moduleRef.get(PrismaService);

  // Reafirmar el baseline de settings del seed. El plan asume "seed aplicado" (con sus settings
  // base) como precondición de CADA bloque, pero todos los specs comparten la MISMA base: uno
  // que borra un setting sembrado (p.ej. el spec de /settings con su DELETE de
  // DEVICE_FINGERPRINT_TTL_DAYS) se lo dejaría borrado al siguiente, que caería a la cascada
  // env/default y leería otro valor. Restaurarlo acá hace que cada spec arranque desde la
  // precondición del plan, sin depender del orden de ejecución de Jest.
  await prisma.setting.upsert({
    where: { key: 'OTP_TTL_SECONDS' },
    update: { value: '300' },
    create: { key: 'OTP_TTL_SECONDS', value: '300' },
  });
  await prisma.setting.upsert({
    where: { key: 'DEVICE_FINGERPRINT_TTL_DAYS' },
    update: { value: '90' },
    create: { key: 'DEVICE_FINGERPRINT_TTL_DAYS', value: '90' },
  });

  return {
    app,
    prisma,
    moduleRef,
    email,
    close: async () => {
      // Neutralizar el reconnect-zombie del broker antes de cerrar. `BrokerService.disconnect()`
      // (que corre en onModuleDestroy) NO saca el listener `connection.on('close', ...)` que
      // reagenda un reintento a los 5s, así que cada app cerrada RECONECTA sola y deja un
      // consumer compitiendo por las colas del vhost efímero COMPARTIDO — round-robin que
      // desvía mensajes de un spec al consumer zombie de otro (contaminación cruzada + el flake
      // "Channel ended, no reply will be forthcoming"). Es un bug real de producción (queda en
      // el reporte); acá se mitiga solo para el teardown de los tests, sin tocar el código de
      // producción: sacamos el listener para que el close deliberado no reagende nada.
      try {
        const broker = moduleRef.get(BrokerService, { strict: false }) as any;
        broker?.connection?.removeAllListeners?.('close');
      } catch {
        /* si el broker no está resuelto o ya cerró, no hay nada que neutralizar */
      }
      await app.close();
      // Borrar el vhost efímero de este spec (best-effort).
      if (vhost) await deleteEphemeralVhost(vhost.vhost);
    },
  };
}
