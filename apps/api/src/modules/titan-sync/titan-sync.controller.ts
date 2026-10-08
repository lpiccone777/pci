import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { TitanSyncService } from './titan-sync.service';
import {
  ImportTitanUsersDto,
  UpsertTitanConnectionDto,
} from './dto/titan-sync.dto';

/**
 * Importación de usuarios desde TitanHR hacia la empresa activa. Todo por tenant (el de
 * `X-Tenant-Id`): cada empresa tiene su propia conexión y sus propios vínculos.
 * Con `TITAN_SYNC_ENABLED=false` todo responde 404 salvo `status`.
 */
@Controller('titan-sync')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class TitanSyncController {
  constructor(private readonly titanSync: TitanSyncService) {}

  /** Si el módulo está activo y la conexión de esta empresa (contraseña enmascarada). */
  @Get('status')
  @RequirePermission('titan-sync', 'read')
  status(@CurrentTenant() tenantId: string) {
    return this.titanSync.getStatus(tenantId);
  }

  @Put('connection')
  @RequirePermission('titan-sync', 'update')
  upsertConnection(
    @CurrentTenant() tenantId: string,
    @Body() dto: UpsertTitanConnectionDto,
  ) {
    return this.titanSync.upsertConnection(tenantId, dto);
  }

  /** Prueba la conexión GUARDADA: login del usuario técnico + lectura de usuarios. */
  @Post('connection/test')
  @RequirePermission('titan-sync', 'read')
  testConnection(@CurrentTenant() tenantId: string) {
    return this.titanSync.testConnection(tenantId);
  }

  /** Usuarios de Titan con su estado respecto de PCI, para elegir cuáles importar. */
  @Get('users')
  @RequirePermission('titan-sync', 'read')
  preview(@CurrentTenant() tenantId: string) {
    return this.titanSync.previewUsers(tenantId);
  }

  @Post('import')
  @RequirePermission('titan-sync', 'create')
  import(@CurrentTenant() tenantId: string, @Body() dto: ImportTitanUsersDto) {
    return this.titanSync.importUsers(tenantId, dto);
  }
}
