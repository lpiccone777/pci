import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { RoleService } from './role.service';
import { PermissionService } from './permission.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { CreatePermissionDto } from './dto/permission.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { RequirePermission } from './decorators/require-permission.decorator';
import { RolesGuard } from './guards/roles.guard';

@Controller('roles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RbacController {
  constructor(
    private readonly roleService: RoleService,
    private readonly permissionService: PermissionService,
  ) {}

  @Post()
  @RequirePermission('roles', 'create')
  async create(@Body() dto: CreateRoleDto, @CurrentTenant() tenantId: string) {
    return this.roleService.create(tenantId, dto);
  }

  @Get()
  @RequirePermission('roles', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.roleService.findAll(tenantId);
  }

  @Get(':id')
  @RequirePermission('roles', 'read')
  async findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.roleService.findOne(tenantId, id);
  }

  @Patch(':id')
  @RequirePermission('roles', 'update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.roleService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('roles', 'delete')
  async remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.roleService.remove(tenantId, id);
  }

  @Post(':roleId/permissions')
  @RequirePermission('permissions', 'create')
  async addPermission(
    @Param('roleId') roleId: string,
    @Body() dto: CreatePermissionDto,
  ) {
    return this.permissionService.create(roleId, dto);
  }

  @Get(':roleId/permissions')
  @RequirePermission('permissions', 'read')
  async findPermissions(@Param('roleId') roleId: string) {
    return this.permissionService.findByRole(roleId);
  }

  @Delete('permissions/:id')
  @RequirePermission('permissions', 'delete')
  async removePermission(@Param('id') id: string) {
    return this.permissionService.remove(id);
  }
}
