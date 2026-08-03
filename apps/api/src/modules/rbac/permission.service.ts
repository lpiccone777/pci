import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePermissionDto } from './dto/permission.dto';

@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(roleId: string, dto: CreatePermissionDto) {
    // Verificar que el rol existe
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Rol no encontrado');

    return this.prisma.rolePermission.create({
      data: {
        roleId,
        resource: dto.resource,
        action: dto.action,
      },
    });
  }

  async findByRole(roleId: string) {
    return this.prisma.rolePermission.findMany({
      where: { roleId },
    });
  }

  async remove(id: string) {
    return this.prisma.rolePermission.delete({ where: { id } });
  }
}
