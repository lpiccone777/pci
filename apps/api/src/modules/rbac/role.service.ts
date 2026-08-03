import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';

@Injectable()
export class RoleService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateRoleDto) {
    return this.prisma.role.create({
      data: {
        name: dto.name,
        tenantId,
      },
    });
  }

  async findAll(tenantId: string) {
    return this.prisma.role.findMany({
      where: { tenantId },
      include: { permissions: true },
    });
  }

  async findOne(tenantId: string, id: string) {
    const role = await this.prisma.role.findFirst({
      where: { id, tenantId },
      include: { permissions: true },
    });
    if (!role) throw new NotFoundException('Rol no encontrado');
    return role;
  }

  async update(tenantId: string, id: string, dto: UpdateRoleDto) {
    await this.findOne(tenantId, id);
    return this.prisma.role.update({
      where: { id },
      data: { name: dto.name },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    return this.prisma.role.delete({ where: { id } });
  }
}
