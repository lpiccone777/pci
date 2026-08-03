import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RolesGuard } from '../rbac/guards/roles.guard';

@Controller('tenants')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  @RequirePermission('tenants', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.tenantsService.findMyTenants(tenantId);
  }

  @Post()
  @RequirePermission('tenants', 'create')
  async create(@Body() dto: { name: string; slug: string }) {
    return this.tenantsService.create(dto.name, dto.slug);
  }
}
