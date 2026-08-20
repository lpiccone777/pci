/**
 * Helpers de autenticación para los tests e2e.
 *
 * `tokenFor` firma un JWT con el `JwtService` REAL de la app (mismo `JWT_SECRET`), sin pasar
 * por el login — para los tests que solo necesitan "un token válido de la persona X" sin
 * ejercitar el 2FA. El bloque de auth (BE-AUTH-*) usa los endpoints reales (`loginViaApi`),
 * no esto.
 *
 * `withAuth` setea `Authorization` y `X-Tenant-Id` sobre una request de supertest.
 */
import { JwtService } from '@nestjs/jwt';
import type { Test as SupertestTest } from 'supertest';
import request from 'supertest';
import { TestApp } from './app';

/** Firma un access token válido (15 min) para la persona, igual que `AuthService.buildTokens`. */
export function tokenFor(t: TestApp, user: { id: string; email: string }): string {
  const jwt = t.moduleRef.get(JwtService, { strict: false });
  return jwt.sign({ sub: user.id, email: user.email }, { expiresIn: '15m' });
}

/** Firma un token con `expiresIn` custom (para BE-AUTH-24: token vencido). */
export function tokenForWithExpiry(
  t: TestApp,
  user: { id: string; email: string },
  expiresIn: string | number,
): string {
  const jwt = t.moduleRef.get(JwtService, { strict: false });
  return jwt.sign({ sub: user.id, email: user.email }, { expiresIn });
}

/** Setea `Authorization: Bearer` y, si se pasa, `X-Tenant-Id` sobre la request. */
export function withAuth(req: SupertestTest, token: string, tenantId?: string): SupertestTest {
  req.set('Authorization', `Bearer ${token}`);
  if (tenantId) req.set('X-Tenant-Id', tenantId);
  return req;
}

/** POST /auth/login contra el endpoint real (con User-Agent, que el controlador exige). */
export function loginViaApi(
  t: TestApp,
  email: string,
  password: string,
  userAgent = 'jest-e2e',
): SupertestTest {
  return request(t.app.getHttpServer())
    .post('/auth/login')
    .set('User-Agent', userAgent)
    .send({ email, password });
}

/** El agente supertest crudo, para armar requests a mano. */
export function http(t: TestApp) {
  return request(t.app.getHttpServer());
}
