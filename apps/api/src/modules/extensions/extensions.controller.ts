import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { ExtensionsService } from './extensions.service';
import { CreateExtensionDto, UpdateExtensionDto } from './dto/extension.dto';

/**
 * ABM de internos del voicebot (*Mensajería → Voicebot → Internos* en `/settings`).
 *
 * Mismo doble candado que `/settings`, porque es la misma pantalla y la misma clase de dato
 * (infra global, D3): `SystemTenantGuard` + permiso `settings:*`.
 */
@Controller('voicebot/extensions')
@UseGuards(JwtAuthGuard, TenantGuard, SystemTenantGuard, RolesGuard)
export class ExtensionsController {
  constructor(private readonly extensions: ExtensionsService) {}

  @Get()
  @RequirePermission('settings', 'read')
  findAll() {
    return this.extensions.findAll();
  }

  /** Flujos de voz elegibles para un interno de esa empresa (selector de la pantalla de Internos). */
  @Get('flow-options')
  @RequirePermission('settings', 'read')
  flowOptions(@Query('tenantId') tenantId?: string) {
    if (!tenantId) throw new BadRequestException('Falta tenantId');
    return this.extensions.flowOptions(tenantId);
  }

  @Post()
  @RequirePermission('settings', 'update')
  create(@Body() dto: CreateExtensionDto) {
    return this.extensions.create(dto);
  }

  @Patch(':id')
  @RequirePermission('settings', 'update')
  update(@Param('id') id: string, @Body() dto: UpdateExtensionDto) {
    return this.extensions.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('settings', 'delete')
  remove(@Param('id') id: string) {
    return this.extensions.remove(id);
  }
}
