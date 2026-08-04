import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Todos los tenants del sistema. Cross-tenant a propósito: ver SystemTenantGuard. */
  async findAll() {
    return this.prisma.tenant.findMany({ orderBy: { name: 'asc' } });
  }

  async findMyTenants(tenantId: string) {
    // Aislamiento: solo devuelve el tenant activo (el frontend obtiene todos desde /auth/me)
    return this.prisma.tenant.findMany({
      where: { id: tenantId },
    });
  }

  async create(name: string, slug: string) {
    return this.prisma.tenant.create({ data: { name, slug } });
  }
}
