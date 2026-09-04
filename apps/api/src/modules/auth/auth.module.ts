import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { DeviceService } from './device.service';
import { EmailService } from './email.service';
import { SmtpEmailService } from './smtp-email.service';
import { SlidingSessionInterceptor } from './interceptors/sliding-session.interceptor';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtAuthGuard,
    DeviceService,
    { provide: EmailService, useClass: SmtpEmailService },
    // Global aunque esté declarado acá (Nest registra cualquier APP_INTERCEPTOR de cualquier
    // módulo importado en el árbol) — necesita el JwtService de este módulo, así que vive
    // acá y no en AppModule.
    { provide: APP_INTERCEPTOR, useClass: SlidingSessionInterceptor },
  ],
  exports: [JwtAuthGuard, AuthService, EmailService],
})
export class AuthModule {}
