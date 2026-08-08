import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTenantDto, UpdateTenantDto } from './dto/tenant.dto';
import { systemTenantSlug } from '../../common/system-tenant';

/**
 * Trae los contadores de uso junto con la empresa, en una sola consulta.
 *
 * Son los números que la pantalla muestra en el detalle y con los que se entiende de un
 * vistazo qué tan "cargada" está una empresa. Pedirlos con `_count` evita traer las
 * membresías, roles y áreas enteras solo para contarlas.
 */
const TENANT_INCLUDE = {
  _count: { select: { users: true, roles: true, areas: true } },
} as const;

type TenantWithCount = Prisma.TenantGetPayload<{ include: typeof TENANT_INCLUDE }>;

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get systemSlug(): string {
    return systemTenantSlug(this.config);
  }

  /** `true` si es la empresa de sistema: no se puede dar de baja ni cambiarle el slug. */
  private isSystem(tenant: { slug: string }): boolean {
    return tenant.slug === this.systemSlug;
  }

  /**
   * Forma en que la pantalla consume una empresa.
   *
   * `isSystem` viaja para que la pantalla muestre la empresa de sistema en modo protegido
   * (slug congelado, sin botón de baja). Sin ese dato el bloqueo funciona igual, pero se
   * manifiesta como un error inesperado recién al guardar.
   */
  private toResponse(tenant: TenantWithCount) {
    const { _count, ...rest } = tenant;
    return {
      ...rest,
      userCount: _count.users,
      roleCount: _count.roles,
      areaCount: _count.areas,
      isSystem: this.isSystem(tenant),
    };
  }

  /**
   * Todas las empresas activas del sistema. Cross-tenant a propósito: ver SystemTenantGuard.
   *
   * Filtra las dadas de baja (`deletedAt != null`): siguen en la base con todos sus datos,
   * pero no se listan.
   */
  async findAll() {
    const tenants = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      include: TENANT_INCLUDE,
      orderBy: { name: 'asc' },
    });
    return tenants.map((t) => this.toResponse(t));
  }

  async findMyTenants(tenantId: string) {
    // Aislamiento: solo devuelve el tenant activo (el frontend obtiene todos desde /auth/me)
    return this.prisma.tenant.findMany({
      where: { id: tenantId, deletedAt: null },
    });
  }

  async create(dto: CreateTenantDto) {
    try {
      const tenant = await this.prisma.tenant.create({
        data: { name: dto.name.trim(), slug: dto.slug.trim() },
        include: TENANT_INCLUDE,
      });
      return this.toResponse(tenant);
    } catch (err) {
      throw this.translateWriteError(err, dto.slug.trim());
    }
  }

  /**
   * La empresa cruda por id, entre las activas.
   *
   * Es el "verificar antes de operar" de update y remove. No se scopea por tenant activo
   * como en roles: acá el recurso ES la empresa, no algo dentro de ella, y `SystemTenantGuard`
   * ya garantizó que quien llega es el superusuario del sistema.
   */
  private async findEntity(id: string): Promise<TenantWithCount> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id, deletedAt: null },
      include: TENANT_INCLUDE,
    });
    if (!tenant) throw new NotFoundException('Empresa no encontrada');
    return tenant;
  }

  async findOne(id: string) {
    const tenant = await this.findEntity(id);
    return this.toResponse(tenant);
  }

  async update(id: string, dto: UpdateTenantDto) {
    const current = await this.findEntity(id);
    const name = dto.name.trim();
    const slug = dto.slug.trim();

    // El nombre de la empresa de sistema sí se puede editar (es cosmético); el slug no,
    // porque de él dependen los cortes de superusuario (SystemTenantGuard, rol protegido).
    if (this.isSystem(current) && slug !== current.slug) {
      throw new ConflictException(
        'No se puede cambiar el slug de la empresa de sistema: de él dependen los ' +
          'permisos de superusuario y la configuración global.',
      );
    }

    try {
      const tenant = await this.prisma.tenant.update({
        where: { id },
        data: { name, slug },
        include: TENANT_INCLUDE,
      });
      return this.toResponse(tenant);
    } catch (err) {
      throw this.translateWriteError(err, slug);
    }
  }

  /**
   * Baja lógica: marca `deletedAt` y deja la empresa (y todos sus datos) donde están.
   *
   * No es un `delete` físico a propósito — borrar arrastraría en cascada usuarios, áreas,
   * settings y flujos, y fallaría de todos modos si la empresa tiene conversaciones o
   * tickets (relaciones que restringen). La baja lógica la saca del listado sin destruir
   * nada. El slug queda ocupado: una empresa dada de baja no libera su slug.
   */
  async remove(id: string) {
    const tenant = await this.findEntity(id);
    if (this.isSystem(tenant)) {
      throw new ConflictException(
        `${tenant.name} es la empresa de sistema: no se puede dar de baja.`,
      );
    }

    await this.prisma.tenant.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { message: `Empresa ${tenant.name} dada de baja.` };
  }

  /**
   * El slug es `@unique` global. Un P2002 sin traducir no le dice nada a quien está dando
   * de alta o editando una empresa. Lo traducimos acá, una sola vez, para create y update.
   *
   * El choque puede ser incluso contra una empresa dada de baja: sigue ocupando su slug.
   */
  private translateWriteError(err: unknown, slug: string): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException(
        `Ya existe una empresa con el slug ${slug} (puede estar dada de baja).`,
      );
    }
    return err;
  }
}
