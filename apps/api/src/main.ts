import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import { AppModule } from './app.module';
import { TENANT_HEADER } from './common/guards/tenant.guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // El default de Express (100kb) alcanza para el resto de la API, pero no para la carga
  // masiva de usuarios: un archivo de unos pocos miles de filas ya lo supera y Express corta
  // la request con "PayloadTooLargeException" antes de que llegue al controller. 10mb da
  // margen de sobra (miles de filas de texto corto) sin dejar de ser un límite razonable.
  app.use(json({ limit: '10mb' }));
  app.enableCors({
    origin: true,
    credentials: true,
    // Sin esto el browser bloquea el header con el que viaja el tenant activo.
    allowedHeaders: ['Content-Type', 'Authorization', TENANT_HEADER],
    // Por default el browser no deja leer headers custom de la respuesta desde JS aunque el
    // server los mande — sin esto, `apiFetch` nunca ve el JWT renovado de
    // SlidingSessionInterceptor (X-Access-Token) por más que viaje en la respuesta.
    exposedHeaders: ['X-Access-Token'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // El tenant se resuelve con TenantGuard a nivel controlador, no con un
  // interceptor global: los guards corren antes, y RolesGuard lo necesita resuelto.

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
