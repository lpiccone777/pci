import {
  IntegrationConsumer,
  SETTINGS_CATALOG,
  SettingDefinition,
  validateSettingValue,
} from '../settings/settings.catalog';

/**
 * Importación de una sola vez de los `.env` del voicebot y del stt al catálogo de pci (contrato de
 * integración 1.0, repo voicebot `docs/integracion-pci/contrato.md` §3.2 y §3.4).
 *
 * Cada variable se traduce a su clave de pci con el mismo mapeo que usan los endpoints de
 * configuración (`envNames`): `RABBITMQ_URL` del voicebot → `VOICEBOT_RABBITMQ_URL`,
 * `LIVEKIT_URL` del voicebot y `STT_LIVEKIT_URL` del stt → `VOICEBOT_LIVEKIT_URL`, etc. Este
 * archivo solo arma el plan (puro, sin BD); lo aplica `applyEnvImport`. El reporte lleva NOMBRES de
 * clave y nunca valores: se imprime en la consola de quien lo corre.
 */

export type EnvImportStatus =
  /** Sin valor guardado en pci y distinto del efectivo: se escribe. */
  | 'alta'
  /** Ya tenía valor guardado en pci, distinto: se pisa. */
  | 'cambia'
  /** Igual al valor efectivo actual: no se escribe. */
  | 'sin-cambios'
  /** La misma clave llega de los dos `.env` con valores distintos: no se elige, no se escribe. */
  | 'conflicto'
  /** No pasa la validación del catálogo: no se escribe. */
  | 'invalida'
  /** Vacía en los `.env`: no se escribe (vacío en un `.env` es "sin definir"). */
  | 'vacia'
  /** Queda en el `.env`/entorno del host (contrato §3.2, §3.4): se ignora. */
  | 'host'
  /** pci la deriva de otra clave (`STT_SINK` de `VOICEBOT_SOURCE` [C39]): se ignora. */
  | 'derivada'
  /** No es del catálogo ni del host (incluye las que salen del contrato): se ignora. */
  | 'fuera-de-catalogo';

export interface EnvImportSource {
  consumer: IntegrationConsumer;
  vars: Record<string, string>;
}

export interface EnvImportEntry {
  /** Clave de pci si la variable es del catálogo; si no, el nombre en el `.env`. */
  key: string;
  status: EnvImportStatus;
  /** De dónde salió: `voicebot:LIVEKIT_URL`, `stt:STT_LIVEKIT_URL`. */
  from: string[];
}

export interface EnvImportPlan {
  entries: EnvImportEntry[];
  /** Lo que `--apply` escribe. Lleva valores: no se imprime. */
  writes: Array<{ def: SettingDefinition; value: string }>;
}

/** Lo que queda en el host y no en pci (contrato §3.2 [C37], §3.4; stt `docs/INTEGRATION.md` §8.1). */
const HOST_ONLY: Record<IntegrationConsumer, ReadonlySet<string>> = {
  voicebot: new Set(['PORT', 'FFMPEG_PATH', 'VOICEBOT_GREETING_DIR', 'CALL_AUDIO_PATH']),
  stt: new Set([
    'STT_DEVICE',
    'STT_COMPUTE_TYPE',
    'STT_CPU_THREADS',
    'OMP_NUM_THREADS',
    'STT_SOURCE',
    'STT_INPUT',
    'STT_INPUT_DEVICE',
    'STT_LOG_AUDIO_LEVEL',
    'STT_LIVEKIT_PARTICIPANT',
    'STT_LIVEKIT_SAMPLE_RATE',
    'STT_LIVEKIT_TOKEN',
    'STT_LIVEKIT_ROOM',
    'STT_VAD',
    'STT_EMIT_SPEECH_SIGNALS',
    'STT_SPEECH_ROUTING_KEY',
    'STT_ROUTING_KEY',
    'STT_PCI_LISTEN',
    // Solo dev: con pci el stt usa las `STT_LIVEKIT_*`.
    'LIVEKIT_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
  ]),
};

const DERIVED: Record<IntegrationConsumer, ReadonlySet<string>> = {
  voicebot: new Set(),
  stt: new Set(['STT_SINK']),
};

/** Orden del reporte: primero lo que se escribe, después lo que hay que mirar. */
const STATUS_ORDER: EnvImportStatus[] = [
  'alta',
  'cambia',
  'conflicto',
  'invalida',
  'sin-cambios',
  'vacia',
  'derivada',
  'host',
  'fuera-de-catalogo',
];

/**
 * Parser mínimo de `.env`: `CLAVE=valor`, `export CLAVE=valor`, comentarios con `#`, valores entre
 * comillas simples o dobles (en las dobles, `\n` es salto de línea). Sin interpolación.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rest] = m;
    let value: string;
    const quote = rest[0];
    if ((quote === '"' || quote === "'") && rest.indexOf(quote, 1) > 0) {
      value = rest.slice(1, rest.indexOf(quote, 1));
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Arma el plan. `current` es el valor efectivo en claro de cada clave de pci (BD → env →
 * default) y `stored` las claves que ya tienen valor guardado en la BD.
 */
export function planEnvImport(
  sources: EnvImportSource[],
  current: ReadonlyMap<string, string>,
  stored: ReadonlySet<string>,
  catalog: SettingDefinition[] = SETTINGS_CATALOG,
): EnvImportPlan {
  // envName de cada consumidor → clave del catálogo (el mismo mapeo de los endpoints).
  const byEnvName: Record<IntegrationConsumer, Map<string, SettingDefinition>> = {
    voicebot: new Map(),
    stt: new Map(),
  };
  for (const def of catalog) {
    for (const [consumer, envName] of Object.entries(def.envNames ?? {})) {
      if (envName) byEnvName[consumer as IntegrationConsumer].set(envName, def);
    }
  }

  const entries: EnvImportEntry[] = [];
  const candidates = new Map<string, { def: SettingDefinition; values: string[]; from: string[] }>();

  for (const { consumer, vars } of sources) {
    for (const [name, value] of Object.entries(vars)) {
      const from = `${consumer}:${name}`;
      const def = byEnvName[consumer].get(name);
      if (def) {
        const c = candidates.get(def.key) ?? { def, values: [], from: [] };
        c.values.push(value);
        c.from.push(from);
        candidates.set(def.key, c);
      } else if (name.startsWith('PCI_') || HOST_ONLY[consumer].has(name)) {
        entries.push({ key: name, status: 'host', from: [from] });
      } else if (DERIVED[consumer].has(name)) {
        entries.push({ key: name, status: 'derivada', from: [from] });
      } else {
        entries.push({ key: name, status: 'fuera-de-catalogo', from: [from] });
      }
    }
  }

  const writes: EnvImportPlan['writes'] = [];
  for (const { def, values, from } of candidates.values()) {
    const normalize = (v: string) => (def.type === 'enum' ? v.toLowerCase() : v);
    // Vacío en un `.env` es "sin definir": si un lado lo trae vacío, manda el otro.
    const distinct = [...new Set(values.filter((v) => v !== '').map(normalize))];

    let status: EnvImportStatus;
    if (distinct.length === 0) status = 'vacia';
    else if (distinct.length > 1) status = 'conflicto';
    else if (validateSettingValue(def, distinct[0])) status = 'invalida';
    else if (current.get(def.key) === distinct[0]) status = 'sin-cambios';
    else status = stored.has(def.key) ? 'cambia' : 'alta';

    entries.push({ key: def.key, status, from });
    if (status === 'alta' || status === 'cambia') writes.push({ def, value: distinct[0] });
  }

  entries.sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.key.localeCompare(b.key),
  );
  return { entries, writes };
}

/** Reporte para la consola: solo nombres de clave y de variable, nunca valores. */
export function formatEnvImportReport(entries: EnvImportEntry[]): string {
  const lines: string[] = [];
  for (const status of STATUS_ORDER) {
    const group = entries.filter((e) => e.status === status);
    if (group.length === 0) continue;
    lines.push(`${status} (${group.length}):`);
    for (const e of group) lines.push(`  ${e.key}  ← ${e.from.join(', ')}`);
  }
  return lines.join('\n');
}
