import { VOICE_TEXTS, collectVoiceLiterals } from './voice-literals';

describe('voice-literals', () => {
  const flow = {
    nodes: [
      { id: 's', type: 'start', data: { text: 'Hola, soporte.' } },
      { id: 'g', type: 'message', data: { text: 'Contale que es la línea de soporte.', speechMode: 'guided' } },
      { id: 'v', type: 'message', data: { text: 'Hola {{userFirstName}}.' } },
      { id: 'm', type: 'menu', data: { text: 'Elegí:', options: [{ value: '1', label: 'Uno' }, { value: '2', label: 'Dos' }] } },
      { id: 'i', type: 'voice_identify', data: { idLabel: 'legajo' } },
      { id: 'e', type: 'end', data: { text: 'Hola, soporte.' } },
    ],
    edges: [{ source: 'm', target: 'e', sourceHandle: '1' }],
  };

  it('junta los literales fijos, sin guided, sin {{variables}} y sin repetidos', () => {
    const lits = collectVoiceLiterals([flow]);
    expect(lits.filter((l) => l === 'Hola, soporte.')).toHaveLength(1);
    expect(lits.join('|')).not.toContain('línea de soporte');
    expect(lits.join('|')).not.toContain('{{');
  });

  it('el menú con y sin "Volver", y el aviso solo para la opción sin salida', () => {
    const lits = collectVoiceLiterals([flow]);
    expect(lits).toContain('Elegí:\n1. Uno\n2. Dos');
    expect(lits).toContain('Elegí:\n1. Uno\n2. Dos\n3. Volver');
    expect(lits).toContain('La opción "Dos" no está disponible.\n\nElegí:\n1. Uno\n2. Dos');
    expect(lits.join('|')).not.toContain('La opción "Uno" no está disponible.');
  });

  it('identificar por voz: preguntas y reintentos de los dos modos', () => {
    const lits = collectVoiceLiterals([flow]);
    expect(lits).toContain('Para identificarte, decime tu número de legajo.');
    expect(lits).toContain(VOICE_TEXTS.identifyAskName);
    expect(lits).toContain(VOICE_TEXTS.identifyAskNameOnly);
    expect(lits).toContain(VOICE_TEXTS.identifyRetryNameOnly);
  });

  it('start sin texto dice el saludo por defecto; con noGreeting, nada', () => {
    expect(collectVoiceLiterals([{ nodes: [{ id: 's', type: 'start', data: {} }], edges: [] }])).toEqual([
      VOICE_TEXTS.unknownGreeting,
    ]);
    expect(collectVoiceLiterals([{ nodes: [{ id: 's', type: 'start', data: { noGreeting: true } }], edges: [] }])).toEqual([]);
  });
});
