import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../../prisma/prisma.service';
import { PERMISSION_KEY, PermissionMetadata } from '../decorators/require-permission.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionMetadata>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required) return true; // Si no hay @RequirePermission, permitir

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) throw new ForbiddenException('No autenticado');

    // Buscar los roles del usuario en el tenant activo
    const userTenants = await this.prisma.userTenant.findMany({
      where: {
        userId: user.userId,
        tenantId: user.tenantId,
      },
      include: {
        role: {
          include: {
            permissions: true,
          },
        },
      },
    });

    const hasPermission = userTenants.some((ut) =>
      ut.role.permissions.some(
        (p) => p.resource === required.resource && p.action === required.action,
      ),
    );

    if (!hasPermission) {
      throw new ForbiddenException(
        `Permiso denegado: ${required.resource}:${required.action}`,
      );
    }

    return true;
  }
}
