import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { LlmModule } from '../llm/llm.module';

// Configuración del sistema (tabla `Setting`): parámetros de seguridad y de LLM
// editables desde el backoffice, sin redeploy. Acceso restringido al tenant de
// sistema + permiso `settings:*` (ver settings.controller.ts).
//
// Importa LlmModule para poder listar los modelos disponibles de cada proveedor.
@Module({
  imports: [LlmModule],
  controllers: [SettingsController],
  providers: [SettingsService, SystemTenantGuard],
  exports: [SettingsService],
})
export class SettingsModule {}
