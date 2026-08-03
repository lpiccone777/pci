import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';

@Injectable()
export class DeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async createFingerprint(
    userId: string,
    phone: string | null,
    userAgent: string,
  ): Promise<string> {
    const ttlDays = await this.config.deviceFingerprintTtlDays();
    const fingerprint = this.computeFingerprint(phone, userAgent);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + ttlDays);

    await this.prisma.device.upsert({
      where: { fingerprint },
      update: { expiresAt, userId },
      create: { userId, fingerprint, userAgent, expiresAt },
    });

    return fingerprint;
  }

  async validateFingerprint(
    userId: string,
    phone: string | null,
    userAgent: string,
  ): Promise<boolean> {
    const fingerprint = this.computeFingerprint(phone, userAgent);
    const device = await this.prisma.device.findUnique({
      where: { fingerprint },
    });

    if (!device) return false;
    if (device.userId !== userId) return false;
    if (new Date() > device.expiresAt) return false;

    return true;
  }

  private computeFingerprint(phone: string | null, userAgent: string): string {
    const raw = `${phone ?? ''}:${userAgent}`;
    // Simplificación: en producción usar SHA-256
    return Buffer.from(raw).toString('base64');
  }
}
