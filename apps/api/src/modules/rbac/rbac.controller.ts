import { Controller, Get, Post, Patch, Put, Delete, Body, Param, Req, UseGuards } from '@nestjs/common';
import { RoleService } from './role.service';
import { PermissionService } from './permission.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { PermissionEntryDto, ReplacePermissionsDto } from './dto/permission.dto';
import { getPermissionCatalog } from './permissions.catalog';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import {
  RequirePermission,
  RequireAnyPermission,
} from './decorators/require-permission.decorator';
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

  /**
   * Roles de OTRA empresa (no la activa). El editor de flujos corre en el tenant de
   * sistema y necesita listar los roles de cada empresa para el modal "Empresas y
   * roles"; `GET /roles` (findAll) solo trae los del tenant activo.
   *
   * Operación cross-tenant, así que va con `SystemTenantGuard` (mismo criterio que
   * `GET /tenants/all`), no con un permiso RBAC a secas. La ruta lleva dos segmentos
   * tras `/roles`, así que no compite con `@Get(':id')`; igual va antes por las dudas.
   */
  @Get('by-tenant/:tenantId')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('roles', 'read')
  async findAllForTenant(@Param('tenantId') tenantId: string) {
    return this.roleService.findAll(tenantId);
  }

  /**
   * Roles de TODAS las empresas (modo lectura "Todas las empresas" del superadmin).
   * Cross-tenant, con `SystemTenantGuard` como `GET /tenants/all`. Va antes de `@Get(':id')`
   * para que `all` no entre como id.
   */
  @Get('all')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('roles', 'read')
  async findAllCrossTenant() {
    return this.roleService.findAllCrossTenant();
  }

  /**
   * Roles de TODAS las empresas del propio usuario (vista "Todas las empresas" del usuario
   * común). Contraparte no-privilegiada de `/roles/all`: el scope lo pone su userId, no el
   * header, y cada empresa se filtra por si su rol tiene `roles:read` ahí. Por eso no lleva
   * `SystemTenantGuard` ni `@RequirePermission` — la autorización es por-empresa, adentro del
   * servicio. Espejo de `GET /users/mine`. Va antes de `@Get(':id')` para que `mine` no entre
   * como id.
   */
  @Get('mine')
  async findMine(@Req() req: any) {
    return this.roleService.findMine(req.user.userId);
  }

  @Post()
  @RequirePermission('roles', 'create')
  async create(@Body() dto: CreateRoleDto, @CurrentTenant() tenantId: string) {
    return this.roleService.create(tenantId, dto);
  }

  /**
   * Roles de la empresa activa. Accesible con `roles:read` (administrar roles) O
   * `users:create`: el alta de usuarios necesita listar los roles para asignarlos, y sin
   * esto un rol con `users:create` pero sin `roles:read` dejaba el desplegable de rol vacío
   * y el alta trabada (FE-USR-16). Es lectura de la lista de roles, dependencia natural de
   * la gestión de usuarios — no habilita administrar roles.
   *
   * El detalle de permisos de cada rol solo viaja para quien administra roles (`roles:read`)
   * o el superusuario del sistema. Al que entra solo por `users:create` se le devuelve id y
   * nombre: lo que el desplegable de asignación necesita, sin exponerle la matriz de permisos
   * de cada rol de la empresa. `req.userTenant` lo dejó resuelto `TenantGuard`.
   */
  @Get()
  @RequireAnyPermission(
    { resource: 'roles', action: 'read' },
    { resource: 'users', action: 'create' },
  )
  async findAll(@CurrentTenant() tenantId: string, @Req() req: any) {
    const includePermissions = await this.roleService.callerCanReadRoles(
      req.userTenant.roleId,
    );
    return this.roleService.findAll(tenantId, { includePermissions });
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
