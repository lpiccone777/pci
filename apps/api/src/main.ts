import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { TenantInterceptor } from './common/interceptors/tenant.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const tenantInterceptor = app.get(TenantInterceptor);
  app.useGlobalInterceptors(tenantInterceptor);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
