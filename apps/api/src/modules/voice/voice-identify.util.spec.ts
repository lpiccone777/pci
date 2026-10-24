import { nameMatches, normalizeDocument, similarity } from './voice-identify.util';

describe('voice-identify.util', () => {
  it('normaliza un DNI dictado con puntos o espacios a solo dígitos', () => {
    expect(normalizeDocument('Mi documento es 32.456.789')).toBe('32456789');
    expect(normalizeDocument('32 456 789')).toBe('32456789');
  });

  it('un legajo con letras queda alfanumérico en mayúsculas; sin nada usable, null', () => {
    expect(normalizeDocument('ab-12')).toBe('AB12');
    expect(normalizeDocument('no sé')).toBe('NOSE');
    expect(normalizeDocument('¿?')).toBeNull();
  });

  it('similarity: idénticas 1, una letra de diferencia en 6 ≈ 0,83', () => {
    expect(similarity('perez', 'perez')).toBe(1);
    expect(similarity('gomezz', 'gomesz')).toBeCloseTo(5 / 6);
  });

  it('nombre y apellido aproximados: tolera tildes, mayúsculas y una letra mal', () => {
    expect(nameMatches('Ana María Pérez', 'Ana María', 'Pérez')).toBe(true);
    expect(nameMatches('ana peres', 'Ana María', 'Pérez')).toBe(true);
    expect(nameMatches('soy Ana Gonsalez', 'Ana', 'González')).toBe(true);
  });

  it('el apellido es obligatorio; del nombre alcanza con uno', () => {
    expect(nameMatches('Ana', 'Ana', 'Pérez')).toBe(false);
    expect(nameMatches('María Pérez', 'Ana María', 'Pérez')).toBe(true);
    expect(nameMatches('Juan Pérez', 'Ana María', 'Pérez')).toBe(false);
    expect(nameMatches('Ana Rodríguez', 'Ana', 'Pérez')).toBe(false);
  });

  it('sin texto o sin datos para comparar, no coincide', () => {
    expect(nameMatches('', 'Ana', 'Pérez')).toBe(false);
    expect(nameMatches('Ana Pérez', null, null)).toBe(false);
  });
});
