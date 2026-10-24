import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { ServiceTokenGuard } from '../../common/guards/service-token.guard';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsConfigService } from './integrations-config.service';

// Integración con el voicebot y el stt (repo voicebot: docs/integracion-pci/contrato.md).
// pci es la fuente de verdad de su configuración: la sirve por HTTP con token de servicio y
// avisa los cambios por `config.changed`. Exporta el servicio para que `SettingsService` le
// avise cada cambio de clave; no importa SettingsModule, así no hay ciclo.
@Module({
  imports: [BrokerModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsConfigService, ServiceTokenGuard],
  exports: [IntegrationsConfigService],
})
export class IntegrationsModule {}
