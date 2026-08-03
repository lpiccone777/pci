import { Module } from '@nestjs/common';
import { RbacController } from './rbac.controller';
import { RoleService } from './role.service';
import { PermissionService } from './permission.service';
import { RolesGuard } from './guards/roles.guard';

@Module({
  controllers: [RbacController],
  providers: [RoleService, PermissionService, RolesGuard],
  exports: [RolesGuard, RoleService, PermissionService],
})
export class RbacModule {}
