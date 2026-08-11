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

  @Get(':id')
  @RequirePermission('users', 'read')
  async findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.usersService.findOne(tenantId, id);
  }

  @Post()
  @RequirePermission('users', 'create')
  async create(@Body() dto: CreateUserDto, @CurrentTenant() tenantId: string) {
    return this.usersService.create(tenantId, dto);
  }

  /**
   * Alta de una persona en varias empresas a la vez. Operación cross-tenant (los destinos
   * vienen en el body, no del header), así que va con `SystemTenantGuard`: solo el superadmin
   * parado en la empresa de sistema. No usa `@CurrentTenant`.
   */
  @Post('multi')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('users', 'create')
  async createMultiTenant(@Body() dto: CreateUserMultiTenantDto) {
    return this.usersService.createMultiTenant(dto);
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
