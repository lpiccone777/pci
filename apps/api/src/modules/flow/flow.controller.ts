import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FlowService } from './flow.service';
import { CreateFlowDto, UpdateFlowDto, AssignTenantsDto } from './dto/create-flow.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';

@Controller('flows')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class FlowController {
  constructor(private readonly flowService: FlowService) {}

  @Post()
  @RequirePermission('flows', 'create')
  async create(@Body() dto: CreateFlowDto) {
    // Un flujo nace sin empresas asignadas: las empresas y sus roles se definen
    // desde el modal "Empresas y roles" del editor. (Antes se auto-asignaba al
    // tenant actual, pero con el modelo por rol esa asignación vendría sin roles y
    // no la recibiría nadie, así que confundía más de lo que aportaba.)
    return this.flowService.create(dto);
  }

  @Get()
  @RequirePermission('flows', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.flowService.findAll(tenantId);
  }

  /**
   * Todos los flujos del sistema, tengan o no empresas asignadas. El backoffice de
   * flujos vive en el tenant de sistema y los administra de forma global; `GET /flows`
   * (findAll) los filtra por asignación al tenant activo, así que un flujo sin empresas
   * no aparecería en ningún lado y parecería "perdido".
   *
   * Cross-tenant → `SystemTenantGuard` (mismo criterio que `GET /tenants/all`). Va antes
   * de `@Get(':id')` para que 'all' no entre como id.
   */
  @Get('all')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('flows', 'read')
  async findAllSystem() {
    return this.flowService.findAll();
  }

  /**
   * Flujos de TODAS las empresas del propio usuario (vista "Todas mis empresas" del usuario
   * común). El scope lo pone el userId, no el header, así que no lleva `SystemTenantGuard` ni
   * `@RequirePermission` — la autorización es por-empresa, adentro del servicio: cada empresa
   * se filtra por el `flows:read` que el usuario tenga en ella. Poner `@RequirePermission`
   * acá lo evaluaría contra el rol del tenant ACTIVO (el del header) y tiraría 403 a quien
   * tiene el permiso en otra empresa pero no en la activa — justo lo contrario de esta vista.
   * Mismo criterio que `/areas/mine`, `/users/mine` y `/roles/mine`. Contraparte no-privilegiada
   * de `GET /flows/all`. Va antes de `@Get(':id')` para que 'mine' no entre como id.
   */
  @Get('mine')
  async findMine(@Req() req: any) {
    return this.flowService.findMine(req.user.userId);
  }

  @Get(':id')
  @RequirePermission('flows', 'read')
  async findById(@Param('id') id: string) {
    return this.flowService.findById(id);
  }

  @Patch(':id')
  @RequirePermission('flows', 'update')
  async update(@Param('id') id: string, @Body() dto: UpdateFlowDto) {
    return this.flowService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('flows', 'delete')
  async delete(@Param('id') id: string) {
    return this.flowService.delete(id);
  }

  @Post(':id/assign-tenants')
  @RequirePermission('flows', 'update')
  async assignTenants(@Param('id') id: string, @Body() dto: AssignTenantsDto) {
    return this.flowService.assignTenants(id, dto.assignments, !!dto.isStart);
  }

  @Post(':id/default')
  @RequirePermission('flows', 'update')
  async setDefault(@Param('id') id: string) {
    return this.flowService.setDefault(id);
  }
}
