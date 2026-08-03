import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AppConfigService {
  constructor(
    private readonly nestConfig: NestConfigService,
    private readonly prisma: PrismaService,
  ) {}

  // Fallback: primero busca en BD (Setting), si no existe usa env var
  async get(key: string, defaultValue?: string): Promise<string | undefined> {
    const dbValue = await this.prisma.setting.findUnique({ where: { key } });
    if (dbValue) return dbValue.value;
    return this.nestConfig.get<string>(key) ?? defaultValue;
  }

  async getNumber(key: string, defaultValue: number): Promise<number> {
    const val = await this.get(key);
    if (val === undefined) return defaultValue;
    const parsed = Number(val);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  // Helpers para parámetros de seguridad
  async otpTtlSeconds(): Promise<number> {
    return this.getNumber('OTP_TTL_SECONDS', 300);
  }

  async deviceFingerprintTtlDays(): Promise<number> {
    return this.getNumber('DEVICE_FINGERPRINT_TTL_DAYS', 90);
  }
}
