import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsCipher } from './secrets.cipher';
import { defaultOtpEnabled, defaultSimulateEnabled } from '../modules/settings/settings.catalog';

@Injectable()
export class AppConfigService {
  constructor(
    private readonly nestConfig: NestConfigService,
    private readonly prisma: PrismaService,
    private readonly cipher: SecretsCipher,
  ) {}

  /**
   * Cascada BD → env var → default.
   *
   * Los valores guardados desde /settings pueden venir cifrados (API keys):
   * se descifran acá, de forma transparente para quien consume la config.
   */
  async get(key: string, defaultValue?: string): Promise<string | undefined> {
    const dbValue = await this.prisma.setting.findUnique({ where: { key } });
    if (dbValue) {
      return this.cipher.isEncrypted(dbValue.value)
        ? this.cipher.decrypt(dbValue.value)
        : dbValue.value;
    }
    return this.nestConfig.get<string>(key) ?? defaultValue;
  }

  async getNumber(key: string, defaultValue: number): Promise<number> {
    const val = await this.get(key);
    if (val === undefined) return defaultValue;
    const parsed = Number(val);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  async getBoolean(key: string, defaultValue: boolean): Promise<boolean> {
    const val = await this.get(key);
    if (val === undefined || val === '') return defaultValue;
    return val.toLowerCase() === 'true';
  }

  // Helpers para parámetros de seguridad
  async otpTtlSeconds(): Promise<number> {
    return this.getNumber('OTP_TTL_SECONDS', 300);
  }

  async otpCodeLength(): Promise<number> {
    const len = await this.getNumber('OTP_CODE_LENGTH', 6);
    // Clamp defensivo: el catálogo valida 4-8, pero una env var cruda no pasa por ahí.
    return Math.min(8, Math.max(4, Math.trunc(len)));
  }

  /**
   * Si nunca se fijó `OTP_ENABLED` (ni en BD ni en env), en desarrollo queda
   * desactivado — preserva el bypass que antes estaba hardcodeado con
   * `NODE_ENV === 'development'` en AuthService. Cualquier valor explícito manda.
   *
   * El default sale de `defaultOtpEnabled()`, el mismo helper que usa el catálogo
   * para mostrarlo en /settings: así lo que se ve en pantalla no puede divergir
   * del comportamiento real del login.
   */
  async otpEnabled(): Promise<boolean> {
    return this.getBoolean('OTP_ENABLED', defaultOtpEnabled() === 'true');
  }

  async deviceFingerprintTtlDays(): Promise<number> {
    return this.getNumber('DEVICE_FINGERPRINT_TTL_DAYS', 90);
  }

  /**
   * ¿`POST /conversations/simulate` está habilitado? Mismo mecanismo que `otpEnabled()`: el
   * default sale de `defaultSimulateEnabled()` (deshabilitado en `NODE_ENV=production`), pero
   * un valor explícito en BD o env manda. Es una herramienta de desarrollo/test — el endpoint
   * solo exige estar logueado (`JwtAuthGuard`), no que el caller tenga relación con el tenant o
   * teléfono que simula, así que en producción conviene poder cerrarlo del todo sin tocar código.
   */
  async simulateEnabled(): Promise<boolean> {
    return this.getBoolean('CONVERSATIONS_SIMULATE_ENABLED', defaultSimulateEnabled() === 'true');
  }
}
