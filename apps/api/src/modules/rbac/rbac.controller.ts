import { Controller, Get, Post, Patch, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { RoleService } from './role.service';
import { PermissionService } from './permission.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { PermissionEntryDto, ReplacePermissionsDto } from './dto/permission.dto';
import { getPermissionCatalog } from './permissions.catalog';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RequirePermission } from './decorators/require-permission.decorator';
import { RolesGuard } from './guards/roles.guard';

@Controller('roles')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class RbacController {
  constructor(
    private readonly roleService: RoleService,
    private readonly permissionService: PermissionService,
  ) {}

  /**
   * El catálogo de permisos con sus etiquetas legibles, para que la matriz del backoffice
   * no duplique la lista de recursos.
   *
   * Va declarado **antes** que `@Get(':id')`: en NestJS gana la primera ruta que matchea,
   * así que al revés la palabra `catalog` entraría como id y esto devolvería
   * "Rol no encontrado".
   */
  @Get('catalog')
  @RequirePermission('roles', 'read')
  getCatalog() {
    return getPermissionCatalog();
  }

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

  /**
   * Quiénes tienen el rol. Pide `roles:read` y no `users:read` a propósito: es la lista
   * que abre el número de la columna Usuarios, y tiene que seguir disponible para quien
   * entra a esta pantalla en modo lectura. Mirar quién tiene un rol no es administrar
   * usuarios.
   */
  @Get(':id/users')
  @RequirePermission('roles', 'read')
  async findUsers(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.roleService.findUsers(tenantId, id);
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

  @Get(':roleId/permissions')
  @RequirePermission('permissions', 'read')
  async findPermissions(
    @Param('roleId') roleId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.permissionService.findByRole(tenantId, roleId);
  }

  /**
   * Reemplaza el conjunto completo de permisos del rol en una sola operación.
   *
   * Es el que usa la pantalla: la ventana guarda toda la matriz junta, y hacerlo con las
   * altas y bajas de a una serían hasta 48 llamadas que pueden cortarse por la mitad y
   * dejar el rol a mitad de camino.
   */
  @Put(':id/permissions')
  @RequirePermission('permissions', 'update')
  async replacePermissions(
    @Param('id') id: string,
    @Body() dto: ReplacePermissionsDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.permissionService.replaceForRole(tenantId, id, dto.permissions);
  }

  /**
   * Agrega un permiso suelto al rol.
   *
   * Convive con el `PUT` en vez de haber sido reemplazado por él: la pantalla guarda la
   * matriz entera, pero un cliente de API que solo quiere sumar un permiso no tiene por
   * qué armar el conjunto completo —y mandarlo incompleto le borraría el resto—.
   */
  @Post(':roleId/permissions')
  @RequirePermission('permissions', 'create')
  async addPermission(
    @Param('roleId') roleId: string,
    @Body() dto: PermissionEntryDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.permissionService.create(tenantId, roleId, dto);
  }

  /**
   * Quita un permiso por el id de su fila.
   *
   * La ruta lleva dos segmentos después de `/roles`, así que no compite con `DELETE :id`,
   * que borra un rol y lleva uno solo.
   */
  @Delete('permissions/:id')
  @RequirePermission('permissions', 'delete')
  async removePermission(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.permissionService.remove(tenantId, id);
  }
}
