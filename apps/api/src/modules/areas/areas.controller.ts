import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AreasService } from './areas.service';
import { CreateAreaDto, UpdateAreaDto } from './dto/area.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
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
