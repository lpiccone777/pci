import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { FlowService } from './flow.service';
import { CreateFlowDto, UpdateFlowDto, AssignTenantsDto } from './dto/create-flow.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';

@Controller('flows')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class FlowController {
  constructor(private readonly flowService: FlowService) {}

  @Post()
  @RequirePermission('flows', 'create')
  async create(@Body() dto: CreateFlowDto, @CurrentTenant() tenantId: string) {
    // If no tenantIds provided, auto-assign to current tenant
    if (!dto.tenantIds?.length && tenantId) {
      dto.tenantIds = [tenantId];
    }
    return this.flowService.create(dto);
  }

  @Get()
  @RequirePermission('flows', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.flowService.findAll(tenantId);
  }

  @Get(':id')
  @RequirePermission('flows', 'read')
  async findById(@Param('id') id: string) {
    return this.flowService.findById(id);
  }

  @Patch(':id')
  @RequirePermission('flows', 'update')
  async update(@Param('id') id: string, @Body() dto: UpdateFlowDto) {
    return this.flowService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('flows', 'delete')
  async delete(@Param('id') id: string) {
    return this.flowService.delete(id);
  }

  @Post(':id/assign-tenants')
  @RequirePermission('flows', 'update')
  async assignTenants(@Param('id') id: string, @Body() dto: AssignTenantsDto) {
    return this.flowService.assignTenants(id, dto.tenantIds, !!dto.isStart);
  }

  @Post(':id/default')
  @RequirePermission('flows', 'update')
  async setDefault(@Param('id') id: string) {
    return this.flowService.setDefault(id);
  }
}
