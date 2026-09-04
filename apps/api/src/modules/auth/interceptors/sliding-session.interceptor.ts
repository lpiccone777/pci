import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Observable } from 'rxjs';
import type { Request, Response } from 'express';

/**
 * Sesión deslizante: reemite un JWT fresco (mismos 15 minutos que `JwtStrategy`/`AuthModule`)
 * en cada request autenticado, así una sesión con actividad real no expira nunca — antes el
 * `accessToken` era un techo duro de 15 minutos sin importar cuánto se usara el panel en el
 * medio (pedido 2026-08-14, después de que el fix de sesión-caída hiciera visible el problema:
 * antes fallaba en silencio, ahora redirige al toque, y quedó claro que pasaba cada 15 minutos
 * aunque el usuario siguiera activo).
 *
 * Global (`APP_INTERCEPTOR` en `AuthModule`), no por ruta: corre después de los guards, así
 * que `request.user` ya está poblado si `JwtAuthGuard` autenticó esta request — en rutas
 * públicas (login, webhooks) `request.user` es `undefined` y no hace nada. El token nuevo va
 * en el header `X-Access-Token` (necesita `exposedHeaders` en el CORS de `main.ts` para que el
 * browser se lo deje leer a `apiFetch`) — no se pisa el `Authorization` de la request en curso,
 * que ya se autenticó con el viejo; el nuevo se usa recién en la próxima.
 *
 * El `refreshToken` de 7 días que devuelve `AuthService.buildTokens()` queda sin usar (nunca
 * hubo un endpoint `/auth/refresh` que lo consuma, ni el frontend lo guarda) — con la sesión
 * deslizante no hace falta: mientras haya actividad, nunca se llega a necesitar.
 */
@Injectable()
export class SlidingSessionInterceptor implements NestInterceptor {
  constructor(private readonly jwtService: JwtService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & { user?: { userId: string; email: string } }>();
    const user = request.user;

    if (user) {
      const response = context.switchToHttp().getResponse<Response>();
      const freshToken = this.jwtService.sign({ sub: user.userId, email: user.email });
      response.setHeader('X-Access-Token', freshToken);
    }

    return next.handle();
  }
}
