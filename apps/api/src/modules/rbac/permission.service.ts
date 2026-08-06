import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RoleService } from './role.service';
import { PermissionEntryDto } from './dto/permission.dto';
import { isCatalogedPermission, isValidPermission } from './permissions.catalog';

@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roleService: RoleService,
  ) {}

  /**
   * Permisos del rol, verificando primero que el rol sea del tenant activo.
   *
   * Antes esto buscaba por `roleId` a secas: con el id de un rol ajeno se leían —y se
   * alteraban— los permisos de otra empresa. Toda operación sobre permisos pasa ahora
   * por `RoleService`, que es quien sabe filtrar por tenant.
   */
  async findByRole(tenantId: string, roleId: string) {
    const role = await this.roleService.findEntity(tenantId, roleId);
    // Pasa por `effectivePermissions` como todas las lecturas: el superusuario del sistema
    // informa el catálogo completo, no las filas que tenga guardadas.
    return this.roleService.permissionsOf(role);
  }

  /**
   * Agrega un permiso suelto al rol.
   *
   * Es el camino de a uno, para clientes de API que quieran sumar un permiso sin mandar
   * la matriz entera. La pantalla usa `replaceForRole`.
   *
   * **Es idempotente:** si el rol ya lo tiene, devuelve la fila que ya estaba en vez de
   * fallar con el choque del `@@unique`. El resultado pedido —que el rol tenga ese
   * permiso— se cumple igual, y así los dos caminos de escritura se comportan parecido:
   * el reemplazo masivo también tolera repetidos.
   */
  async create(tenantId: string, roleId: string, dto: PermissionEntryDto) {
    const role = await this.roleService.findEntity(tenantId, roleId);
    this.roleService.assertNotProtected(role);

    if (!isValidPermission(dto.resource, dto.action)) {
      throw new BadRequestException(
        `Permiso desconocido: ${dto.resource}:${dto.action}. Solo se pueden asignar los del catálogo del sistema.`,
      );
    }

    return this.prisma.rolePermission.upsert({
      where: {
        roleId_resource_action: {
          roleId,
          resource: dto.resource,
          action: dto.action,
        },
      },
      update: {},
      create: { roleId, resource: dto.resource, action: dto.action },
    });
  }

  /**
   * Quita un permiso por el id de su fila.
   *
   * El id de un `RolePermission` no dice a qué empresa pertenece, así que primero se
   * resuelve su rol y se lo hace pasar por `findEntity`: sin eso, el id de un permiso
   * ajeno borraba datos de otra empresa —el mismo agujero que ya se cerró en las demás
   * operaciones sobre permisos—. Un permiso de otro tenant responde igual que uno que
   * no existe: 404, sin revelar que existe en otro lado.
   */
  async remove(tenantId: string, id: string) {
    const permission = await this.prisma.rolePermission.findUnique({
      where: { id },
      select: { id: true, roleId: true },
    });
    if (!permission) throw new NotFoundException('Permiso no encontrado');

    const role = await this.roleService.findEntity(tenantId, permission.roleId);
    this.roleService.assertNotProtected(role);

    return this.prisma.rolePermission.delete({ where: { id } });
  }

  /**
   * Deja el rol exactamente con los permisos recibidos.
   *
   * Recibe el conjunto completo, no un delta: la ventana del backoffice guarda toda la
   * matriz de una vez. Borra los que sobran, crea los que faltan y no toca los que ya
   * estaban, así los ids y las fechas de los permisos que no cambiaron se conservan.
   *
   * **Solo opera sobre el universo del catálogo.** Los `RolePermission` cargados a mano
   * con nombres fuera de catálogo quedan intactos: la pantalla no los conoce, así que
   * nunca vendrían en la lista y un reemplazo total los borraría en silencio.
   *
   * El rol de superusuario del sistema queda afuera: no hace falta escribirle permisos
   * porque los tiene todos por definición (ver `protected-role.ts`), y la API rechaza
   * el intento.
   */
  async replaceForRole(
    tenantId: string,
    roleId: string,
    entries: PermissionEntryDto[],
  ) {
    const role = await this.roleService.findEntity(tenantId, roleId);
    this.roleService.assertNotProtected(role);

    // Validar todo antes de tocar la base: o entra el conjunto entero, o no entra nada.
    // Si validáramos entrada por entrada mientras escribimos, un par inválido en el medio
    // dejaría el rol con la mitad de los permisos nuevos.
    const invalid = entries.filter((e) => !isValidPermission(e.resource, e.action));
    if (invalid.length > 0) {
      const listed = invalid.map((e) => `${e.resource}:${e.action}`).join(', ');
      throw new BadRequestException(
        `Permisos desconocidos: ${listed}. Solo se pueden asignar los del catálogo del sistema.`,
      );
    }

    // El mismo par puede venir repetido; el @@unique lo rechazaría al crear.
    const wanted = new Set(entries.map((e) => `${e.resource}:${e.action}`));

    const cataloged = role.permissions.filter((p) =>
      isCatalogedPermission(p.resource, p.action),
    );
    const existing = new Set(cataloged.map((p) => `${p.resource}:${p.action}`));

    // Los ids a borrar salen de `cataloged`, así que un permiso fuera de catálogo no
    // puede colarse en el deleteMany aunque no esté en `wanted`.
    const toDelete = cataloged
      .filter((p) => !wanted.has(`${p.resource}:${p.action}`))
      .map((p) => p.id);

    const toCreate = [...wanted]
      .filter((key) => !existing.has(key))
      .map((key) => {
        const [resource, action] = key.split(':');
        return { roleId, resource, action };
      });

    if (toDelete.length === 0 && toCreate.length === 0) {
      return this.roleService.findOne(tenantId, roleId);
    }

    await this.prisma.$transaction(async (tx) => {
      if (toDelete.length > 0) {
        await tx.rolePermission.deleteMany({ where: { id: { in: toDelete } } });
      }
      if (toCreate.length > 0) {
        await tx.rolePermission.createMany({ data: toCreate, skipDuplicates: true });
      }
    });

    return this.roleService.findOne(tenantId, roleId);
  }
}
