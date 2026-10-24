import { nameTokens, similarity } from './voice-identify.util';

/**
 * Elección de una opción de menú dicha por teléfono, sin LLM (plan H4b): por voz no se llama a
 * `interpretMenuChoice`. Acepta el número ("2", "la dos", "opción tres", "la segunda") o la
 * etiqueta, con tolerancia a errores del STT. Devuelve el índice (0-based) o `null`.
 */

const NUMBER_WORDS: Record<string, number> = {
  uno: 1, una: 1, primera: 1, primero: 1,
  dos: 2, segunda: 2, segundo: 2,
  tres: 3, tercera: 3, tercero: 3,
  cuatro: 4, cuarta: 4, cuarto: 4,
  cinco: 5, quinta: 5, quinto: 5,
  seis: 6, sexta: 6, sexto: 6,
  siete: 7, septima: 7, septimo: 7,
  ocho: 8, octava: 8, octavo: 8,
  nueve: 9, novena: 9, noveno: 9,
  diez: 10, decima: 10, decimo: 10,
};

/** Umbral de similitud para la etiqueta dicha contra la de la opción. */
export const MENU_LABEL_THRESHOLD = 0.8;

export function matchMenuOption(spoken: string, labels: string[]): number | null {
  const said = nameTokens(spoken);
  if (!said.length && !/\d/.test(spoken)) return null;

  // 1) Por etiqueta, antes que por número ("hablar con una persona" no es la opción 1): todas
  // las palabras de la etiqueta aparecen (aproximadas) en lo dicho. Si matchea más de una, gana
  // la que tiene más palabras (la más específica); empate = no se sabe.
  const scored = labels
    .map((label, i) => ({ i, tokens: nameTokens(label) }))
    .filter(({ tokens }) => tokens.length && tokens.every((t) => said.some((s) => similarity(t, s) >= MENU_LABEL_THRESHOLD)))
    .sort((a, b) => b.tokens.length - a.tokens.length);
  if (scored.length && !(scored.length > 1 && scored[0].tokens.length === scored[1].tokens.length)) {
    return scored[0].i;
  }
  // 2) Por número: un solo número dicho (en cifras o en palabras) que exista en el menú.
  const numbers = new Set<number>();
  for (const m of spoken.match(/\d+/g) ?? []) numbers.add(Number(m));
  for (const t of said) if (NUMBER_WORDS[t]) numbers.add(NUMBER_WORDS[t]);
  if (numbers.size === 1) {
    const n = [...numbers][0];
    if (n >= 1 && n <= labels.length) return n - 1;
  }

  return null;
}
