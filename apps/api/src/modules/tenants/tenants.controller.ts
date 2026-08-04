import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { TenantsService } from './tenants.service';
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
   * Todos los tenants del sistema, no solo el activo. Cross-tenant a propósito
   * (mismo criterio que /settings): asignar un flujo a varios tenants, o listar
   * todas las empresas dadas de alta, exige ver más allá del tenant propio.
   */
  @Get('all')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('tenants', 'read')
  async findAllTenants() {
    return this.tenantsService.findAll();
  }

  @Post()
  @RequirePermission('tenants', 'create')
  async create(@Body() dto: { name: string; slug: string }) {
    return this.tenantsService.create(dto.name, dto.slug);
  }
}
