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
import { CreateFlowVariantDto } from './dto/flow-alternative.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';

@Controller('flows')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class FlowController {
  constructor(private readonly flowService: FlowService) {}

  @Post()
  @RequirePermission('flows', 'create')
  async create(@Body() dto: CreateFlowDto) {
    // Un flujo nace sin empresas asignadas: las empresas y sus roles se definen
    // desde el modal "Empresas y roles" del editor. (Antes se auto-asignaba al
    // tenant actual, pero con el modelo por rol esa asignación vendría sin roles y
    // no la recibiría nadie, así que confundía más de lo que aportaba.)
    return this.flowService.create(dto);
  }

  @Get()
  @RequirePermission('flows', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.flowService.findAll(tenantId);
  }

  /**
   * Todos los flujos del sistema, tengan o no empresas asignadas. El backoffice de
   * flujos vive en el tenant de sistema y los administra de forma global; `GET /flows`
   * (findAll) los filtra por asignación al tenant activo, así que un flujo sin empresas
   * no aparecería en ningún lado y parecería "perdido".
   *
   * Cross-tenant → `SystemTenantGuard` (mismo criterio que `GET /tenants/all`). Va antes
   * de `@Get(':id')` para que 'all' no entre como id.
   */
  @Get('all')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('flows', 'read')
  async findAllSystem() {
    return this.flowService.findAll();
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
    return this.flowService.assignTenants(id, dto.assignments, !!dto.isStart);
  }

  @Post(':id/default')
  @RequirePermission('flows', 'update')
  async setDefault(@Param('id') id: string) {
    return this.flowService.setDefault(id);
  }

  /** Variantes (Feriado/Guardia) configuradas para este flow como Principal. */
  @Get(':id/variants')
  @RequirePermission('flows', 'read')
  async listVariants(@Param('id') id: string) {
    return this.flowService.listAlternatives(id);
  }

  /** Crea la variante de `dto.type` — ver CreateFlowVariantDto para las 3 fuentes posibles. */
  @Post(':id/variants')
  @RequirePermission('flows', 'create')
  async createVariant(@Param('id') id: string, @Body() dto: CreateFlowVariantDto) {
    return this.flowService.createVariant(id, dto.type, {
      blank: dto.blank,
      sourceFlowId: dto.sourceFlowId,
    });
  }

  @Delete(':id/variants/:type')
  @RequirePermission('flows', 'delete')
  async deleteVariant(@Param('id') id: string, @Param('type') type: string) {
    return this.flowService.deleteVariant(id, type);
  }
}
