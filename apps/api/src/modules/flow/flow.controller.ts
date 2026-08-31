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
import { CreateFlowVariantDto } from './dto/flow-alternative.dto';
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
  async create(@Body() dto: CreateFlowDto, @CurrentTenant() tenantId: string, @Req() req: any) {
    // Un flujo nace sin empresas asignadas: las empresas y sus roles se definen
    // desde el modal "Empresas y roles" del editor. (Antes se auto-asignaba al
    // tenant actual, pero con el modelo por rol esa asignación vendría sin roles y
    // no la recibiría nadie, así que confundía más de lo que aportaba.)
    //
    // `tenantId` (empresa activa) va al saneo multitenant de referencias: un flujo
    // importado no puede quedar apuntando a la fuente/skill/usuarios de otra empresa.
    // El `userId` del llamante se usa para dos cosas: registrar quién creó el flujo
    // y validar que las empresas que trae el payload sean realmente suyas (el saneo
    // cross-tenant no puede confiar en un `tenantId` que mande el cliente).
    return this.flowService.create(dto, req.user.userId, tenantId, req.userTenant);
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
  async findById(@Param('id') id: string, @Req() req: any) {
    // Corte de pertenencia: solo se ve un flujo de alguna de las empresas del usuario (el
    // superadmin, cualquiera). El `@RequirePermission` valida el permiso en TU empresa, no de
    // quién es el flujo.
    return this.flowService.findByIdScoped(id, req.userTenant);
  }

  @Patch(':id')
  @RequirePermission('flows', 'update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateFlowDto,
    @CurrentTenant() tenantId: string,
    @Req() req: any,
  ) {
    return this.flowService.update(id, dto, tenantId, req.userTenant);
  }

  @Delete(':id')
  @RequirePermission('flows', 'delete')
  async delete(@Param('id') id: string, @Req() req: any) {
    return this.flowService.delete(id, req.userTenant);
  }

  /**
   * Autoridad sobre las empresas destino: un usuario solo puede vincular un flujo a empresas
   * a las que pertenece; el superadmin puede asignar a cualquiera. Además, corte de pertenencia
   * sobre el flujo de origen: no se reasigna un flujo de otra empresa (ambos los valida
   * `FlowService.assignTenants`). No se usa `SystemTenantGuard` acá a propósito: la
   * administración de flujos también se hace desde cada empresa, no solo desde sistema (ver los
   * e2e BE-FLW-05/06/20).
   */
  @Post(':id/assign-tenants')
  @RequirePermission('flows', 'update')
  async assignTenants(
    @Param('id') id: string,
    @Body() dto: AssignTenantsDto,
    @Req() req: any,
  ) {
    return this.flowService.assignTenants(id, dto.assignments, !!dto.isStart, req.userTenant);
  }

  @Post(':id/default')
  @RequirePermission('flows', 'update')
  async setDefault(@Param('id') id: string) {
    return this.flowService.setDefault(id);
  }

  /** Variantes (Feriado/Guardia) configuradas para este flow como Principal. */
  @Get(':id/variants')
  @RequirePermission('flows', 'read')
  async listVariants(@Param('id') id: string) {
    return this.flowService.listAlternatives(id);
  }

  /** Crea la variante de `dto.type` — ver CreateFlowVariantDto para las 3 fuentes posibles. */
  @Post(':id/variants')
  @RequirePermission('flows', 'create')
  async createVariant(@Param('id') id: string, @Body() dto: CreateFlowVariantDto) {
    return this.flowService.createVariant(id, dto.type, {
      blank: dto.blank,
      sourceFlowId: dto.sourceFlowId,
    });
  }

  @Delete(':id/variants/:type')
  @RequirePermission('flows', 'delete')
  async deleteVariant(@Param('id') id: string, @Param('type') type: string) {
    return this.flowService.deleteVariant(id, type);
  }
}
