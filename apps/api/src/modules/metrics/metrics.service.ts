import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Números del dashboard. `tenants` es la única cifra que no se recorta por `tenantId`:
   * es un contador global (no expone datos de otras empresas, solo un total), a diferencia
   * de usuarios/conversaciones/tickets que sí son del tenant activo.
   */
  async getDashboardMetrics(tenantId: string) {
    const [users, tenants, conversations, tickets] = await Promise.all([
      this.prisma.userTenant.count({ where: { tenantId, user: { deletedAt: null } } }),
      this.prisma.tenant.count({ where: { deletedAt: null } }),
      this.prisma.conversation.count({ where: { tenantId } }),
      this.prisma.ticket.count({ where: { tenantId } }),
    ]);

    return { users, tenants, conversations, tickets };
  }
}
