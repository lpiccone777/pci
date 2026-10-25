import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { VoicebotEnabledGuard } from '../../common/guards/voicebot-enabled.guard';
import { VoiceOutboundService } from './voice-outbound.service';
import { CreateVoiceOutboundDto } from './dto/voice-outbound.dto';

/**
 * Llamadas salientes desde pci (H5, C63): la pantalla `/dashboard/voice-calls` y cualquier
 * integración (n8n) usan esta API. Siempre en la empresa activa (`X-Tenant-Id`), con el permiso
 * `voice_outbound`, y 404 con el voicebot apagado. Los números tienen que estar en
 * `VOICEBOT_OUTBOUND_ALLOWED_PREFIXES` (vacía = no se puede llamar a nada).
 */
@Controller('voice/outbound-calls')
@UseGuards(JwtAuthGuard, VoicebotEnabledGuard, TenantGuard, RolesGuard)
export class VoiceOutboundController {
  constructor(private readonly outbound: VoiceOutboundService) {}

  @Post()
  @RequirePermission('voice_outbound', 'create')
  create(@Body() dto: CreateVoiceOutboundDto, @CurrentTenant() tenantId: string, @Req() req: any) {
    return this.outbound.create(tenantId, req.user.userId, dto);
  }

  @Get()
  @RequirePermission('voice_outbound', 'read')
  findAll(@CurrentTenant() tenantId: string) {
    return this.outbound.findAll(tenantId);
  }

  @Get(':id')
  @RequirePermission('voice_outbound', 'read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.outbound.findOne(tenantId, id);
  }

  @Post(':id/cancel')
  @RequirePermission('voice_outbound', 'update')
  cancel(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.outbound.cancel(tenantId, id);
  }
}
