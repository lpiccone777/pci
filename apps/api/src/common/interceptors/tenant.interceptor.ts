import { Injectable, NestInterceptor, ExecutionContext, CallHandler, ForbiddenException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      // Si no hay usuario, el endpoint es público o JwtAuthGuard no está aplicado
      return next.handle();
    }

    const tenantId = user.tenantId;

    if (!tenantId) {
      throw new ForbiddenException('No se especificó un tenant');
    }

    // Validar que el usuario pertenezca al tenant
    const userTenant = await this.prisma.userTenant.findUnique({
      where: {
        userId_tenantId: {
          userId: user.userId,
          tenantId,
        },
      },
    });

    if (!userTenant) {
      throw new ForbiddenException('No tienes acceso a este tenant');
    }

    // Inyectar tenantId en el request para downstream
    request.tenantId = tenantId;
    request.userTenant = userTenant;

    return next.handle();
  }
}
