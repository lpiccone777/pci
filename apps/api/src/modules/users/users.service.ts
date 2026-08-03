import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string) {
    return this.prisma.user.findMany({
      where: {
        tenants: {
          some: { tenantId },
        },
      },
      select: { id: true, email: true, name: true, phone: true, createdAt: true },
    });
  }

  async findByPhone(phone: string) {
    return this.prisma.user.findUnique({
      where: { phone },
    });
  }

  async findOrCreateByPhone(phone: string, name?: string) {
    let user = await this.prisma.user.findUnique({
      where: { phone },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email: `whatsapp-${phone}@local.pci`,
          phone,
          name: name || 'Usuario WhatsApp',
          passwordHash: await bcrypt.hash(Math.random().toString(36), 10),
        },
      });
    }

    return user;
  }
}
