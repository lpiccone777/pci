import { matchMenuOption } from './voice-menu.util';

describe('voice-menu.util', () => {
  const labels = ['Soporte técnico', 'Ventas', 'Hablar con una persona'];

  it('por número: cifras, palabras u ordinales', () => {
    expect(matchMenuOption('2', labels)).toBe(1);
    expect(matchMenuOption('la dos', labels)).toBe(1);
    expect(matchMenuOption('opción tres', labels)).toBe(2);
    expect(matchMenuOption('la primera', labels)).toBe(0);
  });

  it('un número fuera del menú o dos números distintos no eligen nada por número', () => {
    expect(matchMenuOption('la siete', labels)).toBeNull();
    expect(matchMenuOption('uno o dos', labels)).toBeNull();
  });

  it('por etiqueta, con tildes y una letra mal', () => {
    expect(matchMenuOption('quiero soporte tecnico', labels)).toBe(0);
    expect(matchMenuOption('bentas', labels)).toBe(1);
    expect(matchMenuOption('quiero hablar con una persona', labels)).toBe(2);
  });

  it('sin match, null', () => {
    expect(matchMenuOption('no sé', labels)).toBeNull();
    expect(matchMenuOption('', labels)).toBeNull();
  });
});
