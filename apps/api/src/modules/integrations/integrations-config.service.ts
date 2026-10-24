import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SecretsCipher } from '../../config/secrets.cipher';
import { BrokerService } from '../broker/broker.service';
import {
  IntegrationConsumer,
  SETTINGS_CATALOG,
  SettingDefinition,
  findSettingDefinition,
  isIntegrationConfigKey,
} from '../settings/settings.catalog';
import {
  VOICEBOT_SECTION_IDS,
  VOICE_LLM_CREDENTIALS,
  VOICE_LLM_SOURCE_KEYS,
  VoiceLlmProvider,
  VoicebotSettingGroup,
  deriveSttSink,
} from '../settings/voicebot-settings.catalog';

/** Sección de `config.changed` cuando cambia una credencial de la que sale el LLM de voz. */
const VOICE_LLM_SECTION_ID = VOICEBOT_SECTION_IDS['Mensajería: Voicebot (LLM de voz)'];

/** Versión mayor del contrato de integración voicebot ↔ pci ↔ stt. */
export const INTEGRATION_CONTRACT_VERSION = 1;

/** Contrato §3.3: exchange y routing key del evento de cambio de configuración. */
export const VOICEBOT_EVENTS_EXCHANGE = 'voicebot.events';
export const CONFIG_CHANGED_ROUTING_KEY = 'config.changed';

/** Id de los internos en `config.changed.sections` (no son un grupo del catálogo). */
export const EXTENSIONS_SECTION_ID = 'internos';

/** Única fila de `IntegrationConfigVersion` (la crea la migración). */
const VERSION_ID = 'voicebot';

const INTEGRATION_DEFS = SETTINGS_CATALOG.filter(isIntegrationConfigKey);

/**
 * Configuración que pci le sirve al voicebot y al stt (contrato de integración §3).
 *
 * pci es la fuente de verdad: los dos servicios la leen por HTTP con un token de servicio
 * (`IntegrationsController`) y se enteran de los cambios por `config.changed` en el exchange
 * `voicebot.events`. Los valores salen de la misma cascada que el resto de los settings
 * (BD → env → default del catálogo), pero con nombres del consumidor (`envNames`) y con los
 * secrets **en claro** — es la única excepción a "nunca devolver secrets" [DA2]. Nada de lo que
 * arma este servicio se loguea.
 */
@Injectable()
export class IntegrationsConfigService {
  private readonly logger = new Logger(IntegrationsConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly cipher: SecretsCipher,
    private readonly broker: BrokerService,
  ) {}

  /** Contrato §3.1, con los internos de §3.5 en `extensions`. */
  async voicebotConfig() {
    const [values, version, extensions] = await Promise.all([
      this.resolveValues(),
      this.currentVersion(),
      this.prisma.extension.findMany({
        orderBy: { number: 'asc' },
        include: { tenant: { select: { deletedAt: true } } },
      }),
    ]);
    const settings = this.mapFor('voicebot', values);
    Object.assign(settings, await this.deriveVoiceLlm(values));
    return {
      v: INTEGRATION_CONTRACT_VERSION,
      version: version.version,
      updatedAt: version.updatedAt.toISOString(),
      settings,
      // Una empresa dada de baja no atiende: sus internos viajan deshabilitados.
      extensions: extensions.map((e) => ({
        id: e.id,
        number: e.number,
        name: e.name,
        tenantId: e.tenantId,
        flowId: e.flowId,
        enabled: e.enabled && !e.tenant.deletedAt,
      })),
    };
  }

  /** Contrato §3.2. `STT_SINK` se deriva de `VOICEBOT_SOURCE` [C39]. */
  async sttConfig() {
    const [values, version] = await Promise.all([this.resolveValues(), this.currentVersion()]);
    const env = this.mapFor('stt', values);
    env.STT_SINK = deriveSttSink(
      values.get('VOICEBOT_SOURCE') ?? '',
      values.get('STT_SINK_CONSOLE') === 'true',
    );
    return { v: INTEGRATION_CONTRACT_VERSION, version: version.version, env };
  }

  /**
   * Lo llama `SettingsService` después de guardar o restaurar una clave. Si la clave es de la
   * integración, sube la versión y publica `config.changed` (contrato §3.3). Que falle la
   * publicación no deshace el cambio: los consumidores releen al (re)conectar y cada 5 minutos.
   */
  async onSettingChanged(def: SettingDefinition): Promise<void> {
    await this.notifyChanged([def]);
  }

  /**
   * Una sola versión y un solo `config.changed` para varias claves cambiadas juntas (la
   * importación de los `.env`): `sections` es la unión y `restart.stt` es verdadero si alguna lo
   * pide. Las claves ajenas a la integración se ignoran; si no queda ninguna, no hace nada.
   */
  async notifyChanged(defs: SettingDefinition[]): Promise<void> {
    // Las credenciales de pci de las que sale el LLM de voz [C53] también avisan al voicebot.
    const changed = defs.filter((d) => isIntegrationConfigKey(d) || VOICE_LLM_SOURCE_KEYS.has(d.key));
    if (changed.length === 0) return;

    const sections = [
      ...new Set(
        changed
          .map((d) =>
            isIntegrationConfigKey(d) ? VOICEBOT_SECTION_IDS[d.group as VoicebotSettingGroup] : VOICE_LLM_SECTION_ID,
          )
          .filter(Boolean),
      ),
    ];
    const what = changed.length === 1 ? changed[0].key : `${changed.length} claves`;
    await this.publishChange(sections, changed.some((d) => !!d.restartsStt), what);
  }

  /** Lo llama `ExtensionsService` después de crear, editar o borrar un interno (contrato §3.5). */
  async notifyExtensionsChanged(what: string): Promise<void> {
    await this.publishChange([EXTENSIONS_SECTION_ID], false, what);
  }

  private async publishChange(sections: string[], restartStt: boolean, what: string): Promise<void> {
    const { version } = await this.prisma.integrationConfigVersion.update({
      where: { id: VERSION_ID },
      data: { version: { increment: 1 } },
    });

    try {
      const sent = await this.broker.publishToExchange(VOICEBOT_EVENTS_EXCHANGE, CONFIG_CHANGED_ROUTING_KEY, {
        pattern: 'config.changed',
        data: {
          v: INTEGRATION_CONTRACT_VERSION,
          version,
          sections,
          restart: { stt: restartStt },
        },
        timestamp: new Date().toISOString(),
      });
      if (!sent) this.logger.warn(`config.changed v${version} (${what}) no se publicó: broker no disponible`);
    } catch (err) {
      this.logger.warn(
        `config.changed v${version} (${what}) no se publicó: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async currentVersion(): Promise<{ version: number; updatedAt: Date }> {
    const row = await this.prisma.integrationConfigVersion.findUnique({ where: { id: VERSION_ID } });
    return row ?? { version: 0, updatedAt: new Date(0) };
  }

  /**
   * Valor efectivo en claro de cada clave de la integración, por clave de pci. Lo usa también
   * la importación de los `.env` para saber qué cambia; nunca se loguea.
   */
  async resolveValues(): Promise<Map<string, string>> {
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: INTEGRATION_DEFS.map((d) => d.key) } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    const values = new Map<string, string>();
    for (const def of INTEGRATION_DEFS) {
      const envValue = this.config.get<string>(def.key);
      let raw = def.resolveDefault ? def.resolveDefault() : def.defaultValue;
      if (byKey.has(def.key)) raw = byKey.get(def.key)!;
      else if (envValue !== undefined && envValue !== '') raw = envValue;

      try {
        values.set(def.key, this.cipher.decrypt(raw));
      } catch {
        // Clave maestra rotada o ausente. Mejor fallar entero (el consumidor reintenta y conserva
        // lo que tenía) que servir un secret vacío como si fuera válido.
        this.logger.error(`No se pudo descifrar ${def.key} para la configuración de integración`);
        throw new InternalServerErrorException('No se pudo armar la configuración');
      }
    }
    return values;
  }

  /**
   * `VOICEBOT_LLM_API_KEY` (y la base URL si quedó vacía) del proveedor de voz elegido [C53]:
   * salen de las credenciales que pci ya tiene de ese proveedor, no se cargan aparte.
   */
  private async deriveVoiceLlm(values: Map<string, string>): Promise<Record<string, string>> {
    const provider = values.get('VOICEBOT_LLM_PROVIDER') as VoiceLlmProvider | undefined;
    const source = provider ? VOICE_LLM_CREDENTIALS[provider] : undefined;
    if (!source) return {};
    const [apiKey, baseUrl] = await Promise.all([
      this.resolveKey(source.apiKeyKey, values),
      source.baseUrlKey ? this.resolveKey(source.baseUrlKey, values) : Promise.resolve(''),
    ]);
    return {
      VOICEBOT_LLM_API_KEY: apiKey,
      VOICEBOT_LLM_BASE_URL: values.get('VOICEBOT_LLM_BASE_URL') || baseUrl,
    };
  }

  /** Valor efectivo en claro de una clave del catálogo (BD → env → default), aunque no sea de la integración. */
  private async resolveKey(key: string, known: Map<string, string>): Promise<string> {
    if (known.has(key)) return known.get(key)!;
    const def = findSettingDefinition(key);
    if (!def) return '';
    const row = await this.prisma.setting.findUnique({ where: { key } });
    const envValue = this.config.get<string>(key);
    const raw = row ? row.value : envValue !== undefined && envValue !== '' ? envValue : def.defaultValue;
    try {
      return this.cipher.decrypt(raw);
    } catch {
      this.logger.error(`No se pudo descifrar ${key} para la configuración de integración`);
      throw new InternalServerErrorException('No se pudo armar la configuración');
    }
  }

  private mapFor(consumer: IntegrationConsumer, values: Map<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const def of INTEGRATION_DEFS) {
      const envName = def.envNames?.[consumer];
      if (envName) out[envName] = values.get(def.key) ?? '';
    }
    return out;
  }
}
