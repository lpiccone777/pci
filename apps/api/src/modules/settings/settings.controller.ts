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
import { SettingsService } from './settings.service';
import { LlmModelsService } from '../llm/llm-models.service';
import { InvgateService } from '../invgate/invgate.service';
import { UpsertSettingDto, UpdateSettingDto } from './dto/setting.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';

/**
 * Configuración del sistema (tabla `Setting`), editable desde el backoffice.
 *
 * Doble candado — ambos deben cumplirse:
 *  1. `SystemTenantGuard`: el tenant activo del JWT tiene que ser el de sistema.
 *  2. `@RequirePermission('settings', ...)`: el rol necesita el permiso puntual.
 *     El seed solo se lo da a SuperAdmin.
 */
@Controller('settings')
@UseGuards(JwtAuthGuard, TenantGuard, SystemTenantGuard, RolesGuard)
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly llmModels: LlmModelsService,
    private readonly invgate: InvgateService,
  ) {}

  @Get()
  @RequirePermission('settings', 'read')
  async findAll() {
    return this.settingsService.findAll();
  }

  /** Qué proveedor está activo y a cuáles les falta configuración. */
  @Get('providers/status')
  @RequirePermission('settings', 'read')
  async providerStatus() {
    return this.settingsService.providerStatus();
  }

  /**
   * Modelos disponibles del proveedor, consultados a su API con la key guardada.
   * Si no responde (sin key, timeout, host mal configurado) devuelve una lista
   * conocida como fallback más el motivo, para que el dropdown nunca quede vacío.
   */
  @Get('providers/:provider/models')
  @RequirePermission('settings', 'read')
  async listModels(
    @Param('provider') provider: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.llmModels.listModels(provider, refresh === 'true');
  }

  /**
   * Vacía el cache de subcategorías de InvGate y vuelve a paginar el catálogo — botón
   * "Recargar categorías" de la tarjeta `INVGATE_CATEGORY_PARENT_ID`.
   *
   * `InvgateService.categoryChildrenCache` no tiene TTL ni invalidación: se llena una vez
   * por proceso, así que una categoría creada en InvGate DESPUÉS del arranque no aparecía
   * en el selector del nodo "Generar ticket" hasta reiniciar la API. Vive acá y no en
   * `/invgate/catalog` (que es de solo lectura, con `flows:read`) porque es una acción de
   * administración: mismo doble candado que el resto de `/settings` (tenant de sistema +
   * `settings:update`, el mismo permiso que habilita el "Guardar" de esa tarjeta).
   *
   * Es un POST y no un `?refresh=true` sobre el GET del catálogo a propósito: fuerza
   * repaginar ~700 categorías contra InvGate, no es una lectura idempotente barata.
   */
  @Post('invgate/categories/refresh')
  @RequirePermission('settings', 'update')
  async refreshInvgateCategories() {
    return this.invgate.refreshTicketCategories();
  }

  @Get(':key')
  @RequirePermission('settings', 'read')
  async findOne(@Param('key') key: string) {
    return this.settingsService.findOne(key);
  }

  @Post()
  @RequirePermission('settings', 'create')
  async upsert(@Body() dto: UpsertSettingDto) {
    return this.settingsService.upsert(dto.key, dto.value);
  }

  @Patch(':key')
  @RequirePermission('settings', 'update')
  async update(@Param('key') key: string, @Body() dto: UpdateSettingDto) {
    return this.settingsService.upsert(key, dto.value);
  }

  @Delete(':key')
  @RequirePermission('settings', 'delete')
  async remove(@Param('key') key: string) {
    return this.settingsService.remove(key);
  }
}
