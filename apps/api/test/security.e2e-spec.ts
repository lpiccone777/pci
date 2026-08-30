/**
 * 1.17 Seguridad transversal (BE-SEC-*)
 *
 * Casos de aceptación de hallazgos abiertos que no tienen un hogar funcional único. Los que
 * siguen abiertos son INVERTIDOS (`it.failing`): verifican el comportamiento SEGURO que hoy no
 * existe, así que hoy fallan y `it.failing` los da por verdes. Cuando se corrigen, el assert
 * pasa y el marcador se saca (como ya pasó con BE-SEC-01, hoy un `it` normal).
 *
 * Vía: endpoints REST reales con supertest. Nada de la lógica bajo prueba se mockea.
 */
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  createTestApp,
  TestApp,
  http,
  loginViaApi,
  uniqueEmail,
  uniquePhone,
  DEFAULT_PASSWORD,
} from './support';
import { AppModule } from '../src/app.module';
import { TENANT_HEADER } from '../src/common/guards/tenant.guard';

const UA = 'jest-e2e-security';

describe('1.17 Seguridad transversal (BE-SEC-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('BE-SEC-01: POST /conversations/simulate sin autenticación se rechaza con 401 (SEC-02, corregido)', async () => {
    // tenantId inexistente a propósito: si el guard NO cortara, handleMessage lo trataría como
    // "empresa dada de baja o no existe" y respondería rápido por el canal de reply de RabbitMQ
    // (ver conversations.service.ts), sin gastar el LLM ni colgarse hasta el timeout de 300s
    // del simulate.
    const res = await http(t).post('/conversations/simulate').send({
      from: uniquePhone(),
      body: 'hola',
      tenantId: 'tenant-inexistente-be-sec-01',
    });

    // `ConversationsController` lleva `@UseGuards(JwtAuthGuard)`: sin token válido, 401 antes
    // de tocar el broker. Con el ruteo por membresía, además del tenant del body sin validar,
    // un anónimo podía enumerar las empresas de un teléfono vía el selector multiempresa.
    expect(res.status).toBe(401);
  });

  it.failing(
    'BE-SEC-02: una ráfaga de requests a /auth/login debe cortar con 429 (rate limiting) (SEC-05) @invertido',
    async () => {
      // Email inexistente: AuthService.login falla en el primer findFirst, sin pasar por
      // bcrypt.compare (ver BE-AUTH-03) — la ráfaga corre rápido y no depende del costo de hash.
      const email = uniqueEmail('sec02');
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) {
        const res = await loginViaApi(t, email, DEFAULT_PASSWORD, UA);
        statuses.push(res.status);
      }

      // SEGURO: pasado cierto umbral, el exceso de intentos responde 429. Hoy no hay throttling
      // en ningún endpoint (SEC-05): los 25 intentos responden 401 igual, y la fuerza bruta
      // contra /auth/login queda libre — lo mismo que ya prueba BE-AUTH-19 para /verify-otp.
      expect(statuses.some((s) => s === 429)).toBe(true);
    },
  );

  it.failing(
    'BE-SEC-03: un Origin arbitrario con credenciales no debería reflejarse en Access-Control-Allow-Origin (SEC-12) @invertido',
    async () => {
      // `main.ts` configura CORS dentro de `bootstrap()` (NestFactory.create → enableCors →
      // listen), función que no se puede invocar tal cual en un test (no hay puerto real ni
      // sentido en llamar `app.listen()`). Se arma acá una app aparte que replica el MISMO orden
      // — `enableCors()` ANTES de `init()` — con la MISMA configuración que main.ts aplica hoy.
      // El orden importa de verdad: `enableCors` registra un middleware Express (`.use(cors(...))`)
      // al FINAL de la pila; si se llama DESPUÉS de `init()` (que es cuando `AppModule` monta sus
      // controladores), la pila ya tiene las rutas montadas antes que el middleware de CORS y éste
      // nunca llega a correr — el header de CORS queda simplemente ausente y el test "pasa" sin
      // haber ejercitado nada real. Por eso NO se reusa `t.app` (ya inicializada) para esto.
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const corsApp = moduleRef.createNestApplication();
      corsApp.enableCors({
        origin: true,
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', TENANT_HEADER],
        exposedHeaders: ['X-Access-Token'],
      });
      await corsApp.init();

      try {
        const origenArbitrario = 'https://origen-arbitrario-be-sec-03.example.test';
        const res = await request(corsApp.getHttpServer()).get('/').set('Origin', origenArbitrario);

        // SEGURO: sólo un origen de una lista conocida debería reflejarse. Hoy `origin:true` con
        // `credentials:true` refleja CUALQUIER Origin en Access-Control-Allow-Origin (SEC-12).
        expect(res.headers['access-control-allow-origin']).not.toBe(origenArbitrario);
      } finally {
        await corsApp.close();
      }
    },
  );
});
