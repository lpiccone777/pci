import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { LlmModule } from '../llm/llm.module';
import { InvgateModule } from '../invgate/invgate.module';

// Configuración del sistema (tabla `Setting`): parámetros de seguridad y de LLM
// editables desde el backoffice, sin redeploy. Acceso restringido al tenant de
// sistema + permiso `settings:*` (ver settings.controller.ts).
//
// Importa LlmModule para poder listar los modelos disponibles de cada proveedor, e
// InvgateModule para el botón que recarga el catálogo de categorías sin reiniciar la API.
@Module({
  imports: [LlmModule, InvgateModule],
  controllers: [SettingsController],
  providers: [SettingsService, SystemTenantGuard],
  exports: [SettingsService],
})
export class SettingsModule {}
