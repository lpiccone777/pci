import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SecretsCipher } from '../../config/secrets.cipher';
import {
  SETTINGS_CATALOG,
  SettingDefinition,
  findSettingDefinition,
  validateSettingValue,
} from './settings.catalog';

export interface ResolvedSetting {
  key: string;
  type: SettingDefinition['type'];
  group: SettingDefinition['group'];
  label: string;
  description: string;
  defaultValue: string;
  allowedValues?: string[];
  min?: number;
  max?: number;
  multiline?: boolean;
  secret?: boolean;
  provider?: string;
  placeholder?: string;
  /**
   * Valor efectivo. En claves `secret` esto es un enmascarado (`sk-•••••abcd`),
   * nunca el valor real: los secrets son de solo escritura.
   */
  value: string;
  /** Solo para secrets: si hay un valor cargado (en BD o env). */
  isSet?: boolean;
  /** De dónde salió el valor efectivo. */
  source: 'db' | 'env' | 'default';
  updatedAt: Date | null;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly cipher: SecretsCipher,
  ) {}

  async findAll(): Promise<ResolvedSetting[]> {
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: SETTINGS_CATALOG.map((d) => d.key) } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));

    return SETTINGS_CATALOG.map((def) => this.resolve(def, byKey.get(def.key)));
  }

  async findOne(key: string): Promise<ResolvedSetting> {
    const def = this.requireDefinition(key);
    const row = await this.prisma.setting.findUnique({ where: { key: def.key } });
    return this.resolve(def, row);
  }

  async upsert(key: string, value: string): Promise<ResolvedSetting> {
    const def = this.requireDefinition(key);

    const error = validateSettingValue(def, value);
    if (error) throw new BadRequestException(error);

    let stored = def.type === 'enum' ? value.toLowerCase() : value;

    if (def.secret) {
      if (!value) {
        throw new BadRequestException(
          `${def.key} está vacío. Para borrar el valor usá DELETE /settings/${def.key}`,
        );
      }
      if (!this.cipher.isConfigured) {
        throw new BadRequestException(
          'No se puede guardar un secret sin SETTINGS_ENCRYPTION_KEY configurada en el backend. ' +
            'Generá una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
        );
      }
      stored = this.cipher.encrypt(value);
    }

    const row = await this.prisma.setting.upsert({
      where: { key: def.key },
      update: { value: stored },
      create: { key: def.key, value: stored },
    });

    // Nunca loguear el valor de un secret.
    this.logger.log(
      def.secret
        ? `Secret actualizado: ${def.key} (cifrado)`
        : `Setting actualizado: ${def.key} = ${this.truncate(stored)}`,
    );

    return this.resolve(def, row);
  }

  async remove(key: string): Promise<ResolvedSetting> {
    const def = this.requireDefinition(key);

    const existing = await this.prisma.setting.findUnique({ where: { key: def.key } });
    if (!existing) {
      throw new NotFoundException(`${def.key} no tiene valor en BD (usa env var o default)`);
    }

    await this.prisma.setting.delete({ where: { key: def.key } });
    this.logger.log(`Setting eliminado de BD: ${def.key} (vuelve a env/default)`);

    return this.resolve(def, null);
  }

  /**
   * Estado de configuración de cada proveedor de LLM, para que el backoffice pueda
   * avisar "elegiste opencodego pero le falta el host" antes de que falle un mensaje real.
   */
  async providerStatus() {
    const all = await this.findAll();
    const active = all.find((s) => s.key === 'LLM_PROVIDER')?.value ?? 'openai';

    const required: Record<string, string[]> = {
      openai: ['OPENAI_API_KEY'],
      gemini: ['GEMINI_API_KEY'],
      claude: ['ANTHROPIC_API_KEY'],
      openrouter: ['OPENROUTER_API_KEY'],
      // opencode corre como servidor propio, normalmente local y sin auth:
      // lo indispensable es el host.
      opencodego: ['OPENCODEGO_API_URL'],
      minimax: ['MINIMAX_API_KEY'],
    };

    const byKey = new Map(all.map((s) => [s.key, s]));

    const providers = Object.entries(required).map(([name, keys]) => {
      const missing = keys.filter((k) => {
        const s = byKey.get(k);
        return !(s?.isSet ?? !!s?.value);
      });
      return { provider: name, active: name === active, ready: missing.length === 0, missing };
    });

    return {
      active,
      encryptionConfigured: this.cipher.isConfigured,
      providers,
    };
  }

  private requireDefinition(key: string): SettingDefinition {
    const def = findSettingDefinition(key);
    if (!def) {
      throw new BadRequestException(
        `'${key}' no es una clave configurable. Claves válidas: ${SETTINGS_CATALOG.map((d) => d.key).join(', ')}`,
      );
    }
    return def;
  }

  private resolve(
    def: SettingDefinition,
    row: { value: string; updatedAt: Date } | null | undefined,
  ): ResolvedSetting {
    const envValue = this.config.get<string>(def.key);

    let raw = def.resolveDefault ? def.resolveDefault() : def.defaultValue;
    let source: ResolvedSetting['source'] = 'default';

    if (row) {
      raw = row.value;
      source = 'db';
    } else if (envValue !== undefined && envValue !== '') {
      raw = envValue;
      source = 'env';
    }

    const base = {
      key: def.key,
      type: def.type,
      group: def.group,
      label: def.label,
      description: def.description,
      defaultValue: def.defaultValue,
      allowedValues: def.allowedValues,
      min: def.min,
      max: def.max,
      multiline: def.multiline,
      secret: def.secret,
      provider: def.provider,
      placeholder: def.placeholder,
      source,
      updatedAt: row?.updatedAt ?? null,
    };

    if (!def.secret) {
      return { ...base, value: raw };
    }

    // Secrets: el valor real nunca sale del backend.
    let plain = '';
    if (raw) {
      try {
        plain = this.cipher.decrypt(raw);
      } catch {
        // Clave maestra ausente o rotada: reportamos que hay algo cargado
        // pero ilegible, en vez de tirar toda la pantalla abajo.
        return {
          ...base,
          value: '(no se pudo descifrar)',
          isSet: true,
          source,
        };
      }
    }

    return {
      ...base,
      value: this.cipher.mask(plain),
      isSet: !!plain,
    };
  }

  private truncate(value: string): string {
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
}
