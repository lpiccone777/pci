import { Module } from '@nestjs/common';
import { RbacController } from './rbac.controller';
import { RoleService } from './role.service';
import { PermissionService } from './permission.service';
import { RolesGuard } from './guards/roles.guard';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';

@Module({
  controllers: [RbacController],
  // SystemTenantGuard inyecta PrismaService + ConfigService, así que va como
  // provider para que Nest lo pueda instanciar en `GET /roles/by-tenant/:tenantId`.
  providers: [RoleService, PermissionService, RolesGuard, SystemTenantGuard],
  exports: [RolesGuard, RoleService, PermissionService],
})
export class RbacModule {}
