import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { SkillsService } from './skills.service';
import { CreateSkillDto, UpdateSkillDto } from './dto/skill.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RolesGuard } from '../rbac/guards/roles.guard';

@Controller('skills')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  @Get()
  @RequirePermission('skills', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.skillsService.findAll(tenantId);
  }

  /**
   * Skills de TODAS las empresas (modo "Todas las empresas" del superadmin). Cross-tenant →
   * `SystemTenantGuard`, mismo criterio que `GET /areas/all`. Antes de `@Get(':id')`.
   */
  @Get('all')
  @UseGuards(SystemTenantGuard)
  @RequirePermission('skills', 'read')
  async findAllCrossTenant() {
    return this.skillsService.findAllCrossTenant();
  }

  /**
   * Skills de TODAS las empresas del propio usuario (vista "Todas mis empresas"). Autorización
   * por-empresa adentro del servicio, espejo de `GET /areas/mine`. Antes de `@Get(':id')`.
   */
  @Get('mine')
  async findMine(@Req() req: any) {
    return this.skillsService.findMine(req.user.userId);
  }

  @Get(':id')
  @RequirePermission('skills', 'read')
  async findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.skillsService.findOne(tenantId, id);
  }

  @Post()
  @RequirePermission('skills', 'create')
  async create(@Body() dto: CreateSkillDto, @CurrentTenant() tenantId: string) {
    return this.skillsService.create(tenantId, dto);
  }

  @Patch(':id')
  @RequirePermission('skills', 'update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSkillDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.skillsService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('skills', 'delete')
  async remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.skillsService.remove(tenantId, id);
  }
}
