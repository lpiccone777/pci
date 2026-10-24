import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { SettingDefinition } from '../settings/settings.catalog';
import { IntegrationsConfigService } from './integrations-config.service';
import { EnvImportEntry, EnvImportSource, planEnvImport } from './env-import';

export interface EnvImportResult {
  entries: EnvImportEntry[];
  /** Claves que se escribieron (solo con `apply`). */
  written: string[];
  /** Claves que fallaron al escribir (solo el nombre: el error podría citar el valor). */
  failed: string[];
}

/**
 * Corre la importación de los `.env` (ver `env-import.ts`). Sin `apply` no escribe nada. Con
 * `apply` guarda cada clave por `SettingsService.upsert` —el mismo camino que la UI: valida contra
 * el catálogo y cifra los secrets— sin avisar clave por clave, y al final sube la versión una sola
 * vez y publica un solo `config.changed`.
 */
export async function runEnvImport(
  deps: { prisma: PrismaService; settings: SettingsService; integrations: IntegrationsConfigService },
  sources: EnvImportSource[],
  opts: { apply: boolean },
): Promise<EnvImportResult> {
  const [current, rows] = await Promise.all([
    deps.integrations.resolveValues(),
    deps.prisma.setting.findMany({ select: { key: true } }),
  ]);
  const plan = planEnvImport(sources, current, new Set(rows.map((r) => r.key)));

  const written: string[] = [];
  const failed: string[] = [];
  if (opts.apply) {
    const writtenDefs: SettingDefinition[] = [];
    for (const { def, value } of plan.writes) {
      try {
        await deps.settings.upsert(def.key, value, { notify: false });
        written.push(def.key);
        writtenDefs.push(def);
      } catch {
        failed.push(def.key);
      }
    }
    await deps.integrations.notifyChanged(writtenDefs);
  }
  return { entries: plan.entries, written, failed };
}
