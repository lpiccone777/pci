import { Module } from '@nestjs/common';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ExtensionsController } from './extensions.controller';
import { ExtensionsService } from './extensions.service';

// Internos que atiende el voicebot (contrato de integración §3.5). Importa IntegrationsModule
// para avisarle al voicebot de cada cambio; los internos viajan en su config.
@Module({
  imports: [IntegrationsModule],
  controllers: [ExtensionsController],
  providers: [ExtensionsService, SystemTenantGuard],
})
export class ExtensionsModule {}
