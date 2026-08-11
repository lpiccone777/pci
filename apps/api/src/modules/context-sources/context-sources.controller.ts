import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ContextSourcesService } from './context-sources.service';
import { CreateContextSourceDto, UpdateContextSourceDto } from './dto/context-source.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RolesGuard } from '../rbac/guards/roles.guard';

@Controller('context-sources')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class ContextSourcesController {
  constructor(private readonly contextSourcesService: ContextSourcesService) {}

  /** Catálogo de tipos (mcp/rag/n8n/broker) y sus campos, para armar el formulario dinámico. */
  @Get('types')
  @RequirePermission('context-sources', 'read')
  getTypes() {
    return this.contextSourcesService.getTypes();
  }

  @Get()
  @RequirePermission('context-sources', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.contextSourcesService.findAll(tenantId);
  }

  @Get(':id')
  @RequirePermission('context-sources', 'read')
  async findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.contextSourcesService.findOne(tenantId, id);
  }

  @Post()
  @RequirePermission('context-sources', 'create')
  async create(@Body() dto: CreateContextSourceDto, @CurrentTenant() tenantId: string) {
    return this.contextSourcesService.create(tenantId, dto);
  }

  @Patch(':id')
  @RequirePermission('context-sources', 'update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateContextSourceDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.contextSourcesService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('context-sources', 'delete')
  async remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.contextSourcesService.remove(tenantId, id);
  }

  @Post(':id/test-connection')
  @RequirePermission('context-sources', 'read')
  async testConnection(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.contextSourcesService.testConnection(tenantId, id);
  }
}
