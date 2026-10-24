import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { FlowService } from './flow.service';
import { CreateFlowDto, UpdateFlowDto, AssignTenantsDto } from './dto/create-flow.dto';
import { CreateFlowVariantDto } from './dto/flow-alternative.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { VoicebotEnabledGuard } from '../../common/guards/voicebot-enabled.guard';

/**
 * Flujos de voz (*Flujos de voz* del menú, contrato de integración C52): las mismas operaciones
 * que `FlowController`, sobre `Flow.channel = "voice"` y con su propio permiso `voice_flows`
 * [DA6]. Cada operación sobre un `:id` exige el canal (`FlowService.assertFlowAccessible`), así
 * que esta API no toca flujos de texto ni `/flows` los de voz.
 *
 * Diferencias con texto: no hay `default` (el `isDefault` global es solo de texto, DA8) y la
 * asignación a empresas no lleva roles (la llamada entra sin usuario). Todo responde 404 con el
 * voicebot apagado (`VoicebotEnabledGuard`). La explicación de cada ruta está en `FlowController`.
 */
@Controller('voice-flows')
@UseGuards(JwtAuthGuard, VoicebotEnabledGuard, TenantGuard, RolesGuard)
export class VoiceFlowController {
  constructor(private readonly flowService: FlowService) {}

  @Post()
  @RequirePermission('voice_flows', 'create')
  async create(@Body() dto: CreateFlowDto, @CurrentTenant() tenantId: string, @Req() req: any) {
    return this.flowService.create(dto, req.user.userId, tenantId, req.userTenant, 'voice');
  }

  @Get()
  @RequirePermission('voice_flows', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.flowService.findAll(tenantId, 'voice');
  }

  @Get('all')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('voice_flows', 'read')
  async findAllSystem() {
    return this.flowService.findAll(undefined, 'voice');
  }

  @Get('mine')
  async findMine(@Req() req: any) {
    return this.flowService.findMine(req.user.userId, 'voice');
  }

  @Get(':id')
  @RequirePermission('voice_flows', 'read')
  async findById(@Param('id') id: string, @Req() req: any) {
    return this.flowService.findByIdScoped(id, req.userTenant, 'voice');
  }

  @Patch(':id')
  @RequirePermission('voice_flows', 'update')
  async update(@Param('id') id: string, @Body() dto: UpdateFlowDto, @CurrentTenant() tenantId: string, @Req() req: any) {
    return this.flowService.update(id, dto, tenantId, req.userTenant, 'voice');
  }

  @Delete(':id')
  @RequirePermission('voice_flows', 'delete')
  async delete(@Param('id') id: string, @Req() req: any) {
    return this.flowService.delete(id, req.userTenant, 'voice');
  }

  @Post(':id/assign-tenants')
  @RequirePermission('voice_flows', 'update')
  async assignTenants(@Param('id') id: string, @Body() dto: AssignTenantsDto, @Req() req: any) {
    return this.flowService.assignTenants(id, dto.assignments, !!dto.isStart, req.userTenant, 'voice');
  }

  @Get(':id/variants')
  @RequirePermission('voice_flows', 'read')
  async listVariants(@Param('id') id: string, @Req() req: any) {
    return this.flowService.listAlternatives(id, req.userTenant, 'voice');
  }

  @Post(':id/variants')
  @RequirePermission('voice_flows', 'create')
  async createVariant(@Param('id') id: string, @Body() dto: CreateFlowVariantDto, @Req() req: any) {
    return this.flowService.createVariant(
      id,
      dto.type,
      { blank: dto.blank, sourceFlowId: dto.sourceFlowId },
      req.userTenant,
      'voice',
    );
  }

  @Delete(':id/variants/:type')
  @RequirePermission('voice_flows', 'delete')
  async deleteVariant(@Param('id') id: string, @Param('type') type: string, @Req() req: any) {
    return this.flowService.deleteVariant(id, type, req.userTenant, 'voice');
  }
}
