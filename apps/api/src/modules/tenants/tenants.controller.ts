import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { CreateTenantDto, UpdateTenantDto } from './dto/tenant.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RolesGuard } from '../rbac/guards/roles.guard';

@Controller('tenants')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  @RequirePermission('tenants', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.tenantsService.findMyTenants(tenantId);
  }

  /**
   * Todas las empresas del sistema, no solo la activa. Cross-tenant a propósito
   * (mismo criterio que /settings): administrar empresas —listarlas, crearlas,
   * editarlas o darlas de baja— exige ver más allá de la empresa propia. Por eso
   * todo el CRUD, no solo la lectura, va con `SystemTenantGuard`.
   */
  @Get('all')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('tenants', 'read')
  async findAllTenants() {
    return this.tenantsService.findAll();
  }

  @Post()
  @UseGuards(SystemTenantGuard)
  @RequirePermission('tenants', 'create')
  async create(@Body() dto: CreateTenantDto) {
    return this.tenantsService.create(dto);
  }

  @Patch(':id')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('tenants', 'update')
  async update(@Param('id') id: string, @Body() dto: UpdateTenantDto) {
    return this.tenantsService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('tenants', 'delete')
  async remove(@Param('id') id: string) {
    return this.tenantsService.remove(id);
  }
}
