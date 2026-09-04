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
import { TenantsService } from './tenants.service';
import { CreateTenantDto, UpdateTenantDto } from './dto/tenant.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RolesGuard } from '../rbac/guards/roles.guard';

@Controller('tenants')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  @RequirePermission('tenants', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.tenantsService.findMyTenants(tenantId);
  }

  /**
   * Todas las empresas del sistema, no solo la activa. Cross-tenant a propósito
   * (mismo criterio que /settings): administrar empresas —listarlas, crearlas,
   * editarlas o darlas de baja— exige ver más allá de la empresa propia. Por eso
   * todo el CRUD, no solo la lectura, va con `SystemTenantGuard`.
   */
  @Get('all')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('tenants', 'read')
  async findAllTenants(@Query('includeDeleted') includeDeleted?: string) {
    return this.tenantsService.findAll(includeDeleted === 'true');
  }

  @Post()
  @UseGuards(SystemTenantGuard)
  @RequirePermission('tenants', 'create')
  async create(@Body() dto: CreateTenantDto) {
    return this.tenantsService.create(dto);
  }

  @Patch(':id')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('tenants', 'update')
  async update(@Param('id') id: string, @Body() dto: UpdateTenantDto) {
    return this.tenantsService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('tenants', 'delete')
  async remove(@Param('id') id: string) {
    return this.tenantsService.remove(id);
  }

  /**
   * Reactivar (revertir la baja lógica). Va con `tenants:update`, no con una acción propia:
   * el catálogo RBAC es un producto cartesiano cerrado de 4 acciones y no existe `restore`;
   * reactivar es, conceptualmente, volver a poner activa la empresa —una modificación de su
   * estado—, así que reusa el permiso de edición.
   */
  @Post(':id/restore')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('tenants', 'update')
  async restore(@Param('id') id: string) {
    return this.tenantsService.restore(id);
  }
}
