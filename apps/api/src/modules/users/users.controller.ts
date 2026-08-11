import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import {
  CreateUserDto,
  CreateUserMultiTenantDto,
  UpdateUserDto,
  UpdateUserFullDto,
} from './dto/user.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RolesGuard } from '../rbac/guards/roles.guard';

@Controller('users')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @RequirePermission('users', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.usersService.findAll(tenantId);
  }

  /**
   * Usuarios de TODAS las empresas (modo lectura "Todas las empresas" del superadmin).
   * Cross-tenant, con `SystemTenantGuard` como `GET /tenants/all`. Va antes de `@Get(':id')`
   * para que `all` no entre como id.
   */
  @Get('all')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('users', 'read')
  async findAllCrossTenant() {
    return this.usersService.findAllCrossTenant();
  }

  /**
   * Usuarios de TODAS las empresas del propio usuario (vista "Todas las empresas" del
   * usuario común). Contraparte no-privilegiada de `/users/all`: el scope lo pone su userId,
   * no el header, y cada empresa se filtra por si su rol tiene `users:read` ahí. Por eso no
   * lleva `SystemTenantGuard` ni `@RequirePermission` — la autorización es por-empresa,
   * adentro del servicio. Va antes de `@Get(':id')` para que `mine` no entre como id.
   */
  @Get('mine')
  async findMine(@Req() req: any) {
    return this.usersService.findMine(req.user.userId);
  }

  @Get(':id')
  @RequirePermission('users', 'read')
  async findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.usersService.findOne(tenantId, id);
  }

  /**
   * Datos de la persona y sus membresías en las empresas que quien consulta puede ver, para
   * poblar el editor multiempresa. No lleva `@RequirePermission` porque la autorización es
   * por-empresa dentro del servicio (`findMembershipsForEditor` filtra por `users:read` en
   * cada una). Dos segmentos tras `/users`, así que no compite con `@Get(':id')`.
   */
  @Get(':id/memberships')
  async findMemberships(@Param('id') id: string, @Req() req: any) {
    return this.usersService.findMembershipsForEditor(req.user.userId, id);
  }

  @Post()
  @RequirePermission('users', 'create')
  async create(@Body() dto: CreateUserDto, @CurrentTenant() tenantId: string) {
    return this.usersService.create(tenantId, dto);
  }

  /**
   * Alta de una persona en varias empresas a la vez. Operación cross-tenant: los destinos
   * vienen en el body, no del header. Ya no es exclusiva del superadmin — la autorización se
   * hace por-empresa adentro del servicio (`assertCanManageUsersInTenant`), que valida que
   * `requesterId` pueda crear usuarios en cada empresa destino. Por eso no lleva
   * `SystemTenantGuard` ni `@RequirePermission`: esos validan contra el header, y acá el
   * corte real es por empresa del body.
   */
  @Post('multi')
  async createMultiTenant(@Body() dto: CreateUserMultiTenantDto, @Req() req: any) {
    return this.usersService.createMultiTenant(req.user.userId, dto);
  }

  @Patch(':id')
  @RequirePermission('users', 'update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.usersService.update(tenantId, id, dto);
  }

  /**
   * Edición multiempresa: datos de la persona + estado deseado de sus membresías. Operación
   * cross-tenant (las empresas vienen en el body), así que —igual que `POST /users/multi`— no
   * lleva `SystemTenantGuard` ni `@RequirePermission`: la autorización es por-empresa dentro
   * del servicio (`updateFull`), que valida create/update/delete según lo que cambie en cada
   * una. Dos segmentos tras `/users`, así que no compite con `@Patch(':id')`.
   */
  @Patch(':id/full')
  async updateFull(
    @Param('id') id: string,
    @Body() dto: UpdateUserFullDto,
    @Req() req: any,
  ) {
    return this.usersService.updateFull(req.user.userId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('users', 'delete')
  async remove(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Req() req: any,
  ) {
    return this.usersService.remove(tenantId, id, req.user.userId);
  }
}
