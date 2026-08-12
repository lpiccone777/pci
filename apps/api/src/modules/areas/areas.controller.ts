import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AreasService } from './areas.service';
import { CreateAreaDto, UpdateAreaDto } from './dto/area.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RolesGuard } from '../rbac/guards/roles.guard';

@Controller('areas')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class AreasController {
  constructor(private readonly areasService: AreasService) {}

  @Get()
  @RequirePermission('areas', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.areasService.findAll(tenantId);
  }

  /**
   * Áreas de TODAS las empresas (modo lectura "Todas las empresas" del superadmin).
   * Operación cross-tenant, así que va con `SystemTenantGuard` — mismo criterio que
   * `GET /tenants/all`. Declarado antes de `@Get(':id')` para que `all` no entre como id.
   */
  @Get('all')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('areas', 'read')
  async findAllCrossTenant() {
    return this.areasService.findAllCrossTenant();
  }

  /**
   * Áreas de TODAS las empresas del propio usuario (vista "Todas las empresas" del usuario
   * común). Contraparte no-privilegiada de `/areas/all`: el scope lo pone su userId, no el
   * header, y cada empresa se filtra por si su rol tiene `areas:read` ahí. Por eso no lleva
   * `SystemTenantGuard` ni `@RequirePermission` — la autorización es por-empresa, adentro del
   * servicio. Espejo de `GET /users/mine`. Va antes de `@Get(':id')` para que `mine` no entre
   * como id.
   */
  @Get('mine')
  async findMine(@Req() req: any) {
    return this.areasService.findMine(req.user.userId);
  }

  /**
   * Áreas de OTRA empresa (no la activa), para el alta multiempresa de usuarios: por cada
   * empresa elegida hay que ofrecer sus áreas. Espejo de `GET /roles/by-tenant/:tenantId`.
   * El `tenantId` sale del path; el tenant activo sigue siendo el de sistema.
   */
  @Get('by-tenant/:tenantId')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('areas', 'read')
  async findAllForTenant(@Param('tenantId') tenantId: string) {
    return this.areasService.findAll(tenantId);
  }

  @Get(':id')
  @RequirePermission('areas', 'read')
  async findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.areasService.findOne(tenantId, id);
  }

  /**
   * Quiénes están en el área. Pide `areas:read` y no `users:read` a propósito, igual que
   * la lista equivalente de Roles: es lo que abre el número de la columna Usuarios, y
   * mirar quién está en un área no es administrar usuarios.
   */
  @Get(':id/users')
  @RequirePermission('areas', 'read')
  async findUsers(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.areasService.findUsers(tenantId, id);
  }

  @Post()
  @RequirePermission('areas', 'create')
  async create(@Body() dto: CreateAreaDto, @CurrentTenant() tenantId: string) {
    return this.areasService.create(tenantId, dto);
  }

  @Patch(':id')
  @RequirePermission('areas', 'update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAreaDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.areasService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('areas', 'delete')
  async remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.areasService.remove(tenantId, id);
  }
}
