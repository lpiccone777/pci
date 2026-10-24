/**
 * Normalización y comparación del nodo *Identificar por voz* (`voice_identify`, contrato C52).
 * Todo determinístico, sin LLM: el texto viene del STT, que se equivoca en letras y escribe los
 * números a veces con puntos o espacios ("32.456.789", "32 456 789").
 */

/** Umbral de similitud por palabra (1 = idénticas). 0,75 tolera ~1 letra mal cada 4. */
export const NAME_TOKEN_THRESHOLD = 0.75;

/**
 * Documento o legajo dicho por la persona, listo para buscar. Si hay al menos 6 dígitos se toman
 * solo los dígitos (un DNI dictado con puntos o espacios); si no, el alfanumérico en mayúsculas
 * (un legajo con letras). `null` si no queda nada usable.
 */
export function normalizeDocument(spoken: string): string | null {
  const digits = spoken.replace(/\D/g, '');
  if (digits.length >= 6) return digits;
  const alnum = spoken
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^0-9a-z]/gi, '')
    .toUpperCase();
  return alnum.length >= 2 ? alnum : null;
}

/** Palabras en minúscula, sin tildes ni signos. */
export function nameTokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-zñ\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Similitud por distancia de Levenshtein, normalizada al largo mayor. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / max;
}

const bestMatch = (token: string, spoken: string[]) => Math.max(0, ...spoken.map((s) => similarity(token, s)));

/**
 * ¿Lo que dijo la persona coincide, aproximadamente, con nombre y apellido? Cada palabra del
 * apellido tiene que aparecer (con el umbral), y del nombre alcanza con una: mucha gente dice solo
 * uno de sus nombres.
 */
export function nameMatches(spoken: string, firstName: string | null | undefined, lastName: string | null | undefined): boolean {
  const said = nameTokens(spoken);
  const last = nameTokens(lastName ?? '');
  const first = nameTokens(firstName ?? '');
  if (!said.length || (!last.length && !first.length)) return false;
  const lastOk = last.every((t) => bestMatch(t, said) >= NAME_TOKEN_THRESHOLD);
  const firstOk = !first.length || first.some((t) => bestMatch(t, said) >= NAME_TOKEN_THRESHOLD);
  return lastOk && firstOk;
}
