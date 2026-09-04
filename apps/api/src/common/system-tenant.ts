import { ConfigService } from '@nestjs/config';
import { DEFAULT_SYSTEM_TENANT_SLUG } from '../modules/rbac/protected-role';

/**
 * El slug de la empresa de sistema, resuelto igual en todos lados.
 *
 * De este valor dependen cosas que tienen que coincidir sí o sí: qué rol está protegido,
 * quién puede pararse en otra empresa, quién llega a la configuración global y quién ve
 * todas las empresas. Cada copia del `config.get(...)` con su default era una forma más de
 * que uno dijera algo distinto del resto.
 *
 * El default vive en `protected-role.ts` junto al nombre del rol protegido, que es lo otro
 * que define al superusuario.
 */
export function systemTenantSlug(config: ConfigService): string {
  return config.get<string>(
    'SYSTEM_TENANT_SLUG',
    DEFAULT_SYSTEM_TENANT_SLUG,
  );
}
