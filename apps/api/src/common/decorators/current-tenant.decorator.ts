import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Lee el tenant que dejó resuelto TenantGuard. Requiere que el controlador use
// `@UseGuards(JwtAuthGuard, TenantGuard, ...)`; sin TenantGuard esto es siempre null.
export const CurrentTenant = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.tenantId ?? null;
  },
);
