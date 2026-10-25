import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { VoicebotEnabledGuard } from '../../common/guards/voicebot-enabled.guard';
import { IntegrationsConfigService } from './integrations-config.service';

/**
 * Botones de la subpestaña Voicebot de `/settings` (H5, contrato §6): "Probar conexión"
 * (`health.check`) y "Re-provisionar SIP" (`sip.provision`). Mismo doble candado que
 * `/settings`: tenant de sistema + permiso `settings`.
 */
@Controller('integrations/voicebot')
@UseGuards(JwtAuthGuard, VoicebotEnabledGuard, TenantGuard, SystemTenantGuard, RolesGuard)
export class VoicebotAdminController {
  constructor(private readonly integrations: IntegrationsConfigService) {}

  @Post('health')
  @RequirePermission('settings', 'read')
  health() {
    return this.integrations.voicebotHealth();
  }

  @Post('sip-provision')
  @RequirePermission('settings', 'update')
  sipProvision() {
    return this.integrations.voicebotSipProvision();
  }
}
