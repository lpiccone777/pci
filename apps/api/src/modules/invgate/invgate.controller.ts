import { Controller, Get, UseGuards } from '@nestjs/common';
import { InvgateService } from './invgate.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';

/**
 * Catálogo de InvGate para el editor de flujos — el nodo "Generar ticket" necesita
 * mostrarle al usuario categorías/prioridades/tipos REALES de la instancia (no que
 * memorice IDs numéricos a mano). Mismo criterio de guards que `/flows`
 * (`@RequirePermission('flows', 'read')`, no un permiso nuevo): quien puede ver/editar
 * flujos puede consultar este catálogo, nadie más lo necesita.
 *
 * InvGate es una integración global, no por tenant — por eso no lleva `@CurrentTenant()`
 * ni filtra nada por empresa, a diferencia de `/flows`.
 */
@Controller('invgate/catalog')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class InvgateController {
  constructor(private readonly invgateService: InvgateService) {}

  /**
   * Subcategorías de `INVGATE_DEFAULT_CATEGORY_ID`... no, de `INVGATE_CATEGORY_PARENT_ID`
   * (ver `/settings`) — acotado a propósito a una rama puntual del árbol, no el catálogo
   * completo de InvGate (puede tener cientos de categorías organizacionales ajenas al
   * chatbot). `[]` si el setting no está configurado.
   */
  @Get('categories')
  @RequirePermission('flows', 'read')
  async categories() {
    return this.invgateService.listTicketCategories();
  }

  @Get('priorities')
  @RequirePermission('flows', 'read')
  async priorities() {
    return this.invgateService.listPriorities();
  }

  @Get('types')
  @RequirePermission('flows', 'read')
  async types() {
    return this.invgateService.listIncidentTypes();
  }
}
