import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { settingLines } from './settings.catalog';
import {
  WAIT_TEXT_LISTS,
  WAIT_TEXTS_MAX_LENGTH,
  WAIT_TEXTS_SOURCE_KEY,
} from './voicebot-settings.catalog';

/** Cuántas variantes pide por vez: deja lugar para que el admin descarte algunas. */
const PROPOSE_COUNT = 6;

/**
 * "Proponer variantes" de los avisos de espera (contrato C65): el LLM de pci (vía `LlmService`)
 * propone textos para una lista y la UI los muestra editables. **No guarda nada**: quedan recién
 * cuando el admin los revisa y guarda la clave como cualquier otra.
 */
@Injectable()
export class WaitTextsService {
  private readonly logger = new Logger(WaitTextsService.name);

  constructor(private readonly llm: LlmService) {}

  async propose(key: string, current: string): Promise<{ lines: string[] }> {
    const list = WAIT_TEXT_LISTS.find((l) => l.key === key);
    if (!list) throw new BadRequestException(`${key} no es una lista de avisos de espera`);
    const withLabel = key === WAIT_TEXTS_SOURCE_KEY;
    const existing = settingLines(current);

    const instructions = [
      'Escribís avisos muy cortos que dice un asistente telefónico mientras espera algo, para que la persona',
      'sepa que sigue en línea. Español rioplatense, tono cordial y natural, de 3 a 12 palabras, sin emojis,',
      'sin comillas y sin prometer tiempos. Cada aviso tiene que sonar distinto de los demás.',
      `Situación: ${list.description}`,
      withLabel
        ? 'Usá el marcador {label} (tal cual, con llaves) en la mitad de los avisos: ahí va el nombre de lo que se ' +
          'consulta, por ejemplo "el servicio del clima". La otra mitad, sin {label}.'
        : 'No uses marcadores ni llaves.',
      existing.length ? `Ya están estos, no los repitas:\n${existing.join('\n')}` : '',
      `Devolvé exactamente ${PROPOSE_COUNT} avisos, uno por línea, sin numerar y sin nada más.`,
    ]
      .filter(Boolean)
      .join('\n');

    let raw: string;
    try {
      raw = await this.llm.chat([{ role: 'user', content: instructions }], { temperature: 0.9, maxTokens: 400 });
    } catch (err) {
      this.logger.warn(`No se pudieron proponer avisos para ${key}: ${err instanceof Error ? err.message : err}`);
      throw new BadGatewayException('El LLM no respondió. Probá de nuevo en un rato.');
    }

    const seen = new Set(existing.map((l) => l.toLowerCase()));
    const lines: string[] = [];
    for (const line of settingLines(raw)) {
      const text = cleanProposal(line);
      if (!text || text.length > WAIT_TEXTS_MAX_LENGTH) continue;
      if (!withLabel && text.includes('{label}')) continue;
      if (seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      lines.push(text);
    }
    if (!lines.length) throw new BadGatewayException('El LLM no devolvió avisos usables. Probá de nuevo.');
    // Pueden pasarse del tope sumadas a las que ya hay: el admin elige cuáles quedan, y el guardado
    // valida las `WAIT_TEXTS_MAX_LINES`.
    return { lines: lines.slice(0, PROPOSE_COUNT) };
  }
}

/** Saca numeración, viñetas y comillas que el LLM agrega aunque se le pida que no. */
export function cleanProposal(line: string): string {
  return line
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
    .replace(/^["“”«»']+|["“”«»']+$/g, '')
    .trim();
}
