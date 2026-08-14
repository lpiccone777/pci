import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { TENANT_HEADER } from './common/guards/tenant.guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
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
