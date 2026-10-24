import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SecretsCipher } from '../../config/secrets.cipher';
import { BrokerService } from '../broker/broker.service';
import {
  IntegrationConsumer,
  SETTINGS_CATALOG,
  SettingDefinition,
  isIntegrationConfigKey,
} from '../settings/settings.catalog';
import {
  VOICEBOT_SECTION_IDS,
  VoicebotSettingGroup,
  deriveSttSink,
} from '../settings/voicebot-settings.catalog';

/** Versión mayor del contrato de integración voicebot ↔ pci ↔ stt. */
export const INTEGRATION_CONTRACT_VERSION = 1;

/** Contrato §3.3: exchange y routing key del evento de cambio de configuración. */
export const VOICEBOT_EVENTS_EXCHANGE = 'voicebot.events';
export const CONFIG_CHANGED_ROUTING_KEY = 'config.changed';

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

  /** Contrato §3.1. Los internos (`extensions`) llegan en H2. */
  async voicebotConfig() {
    const [values, version] = await Promise.all([this.resolveValues(), this.currentVersion()]);
    return {
      v: INTEGRATION_CONTRACT_VERSION,
      version: version.version,
      updatedAt: version.updatedAt.toISOString(),
      settings: this.mapFor('voicebot', values),
      extensions: [] as unknown[],
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
    const changed = defs.filter(isIntegrationConfigKey);
    if (changed.length === 0) return;

    const { version } = await this.prisma.integrationConfigVersion.update({
      where: { id: VERSION_ID },
      data: { version: { increment: 1 } },
    });

    const sections = [
      ...new Set(changed.map((d) => VOICEBOT_SECTION_IDS[d.group as VoicebotSettingGroup]).filter(Boolean)),
    ];
    const what = changed.length === 1 ? changed[0].key : `${changed.length} claves`;
    try {
      const sent = await this.broker.publishToExchange(VOICEBOT_EVENTS_EXCHANGE, CONFIG_CHANGED_ROUTING_KEY, {
        pattern: 'config.changed',
        data: {
          v: INTEGRATION_CONTRACT_VERSION,
          version,
          sections,
          restart: { stt: changed.some((d) => !!d.restartsStt) },
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

  private mapFor(consumer: IntegrationConsumer, values: Map<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const def of INTEGRATION_DEFS) {
      const envName = def.envNames?.[consumer];
      if (envName) out[envName] = values.get(def.key) ?? '';
    }
    return out;
  }
}
