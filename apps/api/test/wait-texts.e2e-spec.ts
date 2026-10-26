/**
 * Avisos durante esperas largas (C65) — claves, "Proponer variantes" y nombre para voz — BE-WAIT-*
 *
 * Contrato de integración (repo voicebot, `docs/integracion-pci/contrato.md`) §3.4 y §5.5:
 * - `VOICEBOT_WAIT_TEXTS*`: un texto por línea, hasta 10 de 200 caracteres; `{label}` solo en los
 *   de fuente. Viajan al voicebot tal cual (`settings`).
 * - pci expande `{label}` con el `voiceName` de cada fuente y suma los textos a `voiceLiterals`.
 * - Los textos los propone el LLM de pci y el admin los revisa: proponer no guarda nada.
 *
 * Vía: endpoints REST reales con supertest sobre la base efímera; el LLM de pci es falso.
 */
import {
  createTestApp,
  TestApp,
  FakeLlmService,
  tokenFor,
  withAuth,
  http,
  getSystemContext,
  deleteSetting,
} from './support';
import { LlmService } from '../src/modules/llm/llm.service';
import { cleanProposal } from '../src/modules/settings/wait-texts.service';

const VOICEBOT_TOKEN = 'e2e-voicebot-token-wait-0123456789';
const TOUCHED_KEYS = [
  'VOICEBOT_SERVICE_TOKEN',
  'VOICEBOT_WAIT_TEXTS',
  'VOICEBOT_WAIT_TEXTS_SOURCE',
  'VOICEBOT_WAIT_TEXTS_TICKET',
];

describe('Avisos durante esperas largas: claves y nombre para voz (BE-WAIT-*)', () => {
  let t: TestApp;
  const llm = new FakeLlmService();
  let adminToken: string;
  let systemTenantId: string;

  const asAdmin = (req: ReturnType<typeof http>) => withAuth(req, adminToken, systemTenantId);
  const patchSetting = (key: string, value: string) => asAdmin(http(t).patch(`/settings/${key}`)).send({ value });
  const voicebotConfig = async () =>
    (await http(t).get('/integrations/voicebot/config').set('Authorization', `Bearer ${VOICEBOT_TOKEN}`).expect(200)).body as {
      version: number;
      settings: Record<string, string>;
      voiceLiterals: string[];
    };

  beforeAll(async () => {
    t = await createTestApp({ customize: (b) => b.overrideProvider(LlmService).useValue(llm) });
    const { admin, tenant } = await getSystemContext(t.prisma);
    adminToken = tokenFor(t, admin);
    systemTenantId = tenant.id;
    await patchSetting('VOICEBOT_SERVICE_TOKEN', VOICEBOT_TOKEN).expect(200);
  });

  afterAll(async () => {
    for (const key of TOUCHED_KEYS) await deleteSetting(t.prisma, key);
    await t.close();
  });

  it('BE-WAIT-01: las listas validan cantidad, largo y {label} solo en los avisos de fuente', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `Aviso ${i + 1}`).join('\n');
    expect((await patchSetting('VOICEBOT_WAIT_TEXTS', eleven).expect(400)).body.message).toContain('hasta 10 textos');
    expect((await patchSetting('VOICEBOT_WAIT_TEXTS', 'x'.repeat(201)).expect(400)).body.message).toContain('200 caracteres');
    expect((await patchSetting('VOICEBOT_WAIT_TEXTS_TICKET', 'Consultando {label}').expect(400)).body.message).toContain('{label}');

    // Las líneas vacías y los espacios no cuentan: 10 textos con renglones en blanco pasan.
    const ten = Array.from({ length: 10 }, (_, i) => `  Aviso ${i + 1}  `).join('\n\n');
    await patchSetting('VOICEBOT_WAIT_TEXTS', ten).expect(200);
    await patchSetting('VOICEBOT_WAIT_TEXTS_SOURCE', 'Consultando {label}…').expect(200);
  });

  it('BE-WAIT-02: la config del voicebot trae las listas tal cual y los defaults nuevos', async () => {
    await patchSetting('VOICEBOT_WAIT_TEXTS', 'Un momento e2e.\nSigo acá e2e.').expect(200);
    const { settings } = await voicebotConfig();
    expect(settings.VOICEBOT_WAIT_TEXTS).toBe('Un momento e2e.\nSigo acá e2e.');
    expect(settings).toMatchObject({
      VOICEBOT_WAIT_INTERVAL_MS: '4500',
      VOICEBOT_WAIT_MAX: '3',
      VOICEBOT_TURN_TIMEOUT_MAX_MS: '20000',
    });
    expect(settings.VOICEBOT_WAIT_TEXTS_DELAY).toBeTruthy();
    // La espera de la fuente es de pci: no viaja en la config [C61].
    expect(settings.VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS).toBeUndefined();
    const delegate = (await asAdmin(http(t).get('/settings/VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS')).expect(200)).body;
    expect(delegate.defaultValue).toBe('12000');
  });

  it('BE-WAIT-03: {label} se expande con el nombre para voz de cada fuente en voiceLiterals; sin nombre no queda', async () => {
    await patchSetting('VOICEBOT_WAIT_TEXTS_SOURCE', 'Estoy consultando {label}, un momento.\nSigo buscando e2e.').expect(200);
    const before = await voicebotConfig();
    expect(before.voiceLiterals).toContain('Sigo buscando e2e.');
    expect(before.voiceLiterals).toContain('Un momento e2e.');
    expect(before.voiceLiterals.some((l) => l.includes('{label}'))).toBe(false);

    const created = await asAdmin(http(t).post('/context-sources'))
      .send({ name: `clima e2e ${Date.now()}`, type: 'broker', voiceName: '  el servicio del clima e2e  ', config: { queueName: 'context.e2e.query' } })
      .expect(201);
    expect(created.body.voiceName).toBe('el servicio del clima e2e');
    const afterCreate = await voicebotConfig();
    expect(afterCreate.version).toBe(before.version + 1); // guardar con nombre para voz avisa al voicebot
    expect(afterCreate.voiceLiterals).toContain('Estoy consultando el servicio del clima e2e, un momento.');

    // Cambiar otro campo no avisa; borrar el nombre sí, y el texto expandido desaparece.
    await asAdmin(http(t).patch(`/context-sources/${created.body.id}`)).send({ name: `clima e2e otro ${Date.now()}` }).expect(200);
    expect((await voicebotConfig()).version).toBe(afterCreate.version);
    const cleared = await asAdmin(http(t).patch(`/context-sources/${created.body.id}`)).send({ voiceName: '' }).expect(200);
    expect(cleared.body.voiceName).toBeNull();
    const afterClear = await voicebotConfig();
    expect(afterClear.version).toBe(afterCreate.version + 1);
    expect(afterClear.voiceLiterals).not.toContain('Estoy consultando el servicio del clima e2e, un momento.');

    await asAdmin(http(t).post('/context-sources'))
      .send({ name: `voz larga ${Date.now()}`, type: 'broker', voiceName: 'x'.repeat(61), config: { queueName: 'context.e2e.query' } })
      .expect(400);
    await t.prisma.contextSource.delete({ where: { id: created.body.id } });
  });

  it('BE-WAIT-04: "Proponer variantes" pide al LLM de pci, limpia la respuesta y no guarda nada', async () => {
    await patchSetting('VOICEBOT_WAIT_TEXTS_SOURCE', 'Sigo buscando e2e.').expect(200);
    llm.calls.length = 0;
    llm.setResponder(() =>
      [
        '1. Estoy consultando {label}, ya vuelvo.',
        '- "Sigo acá, buscando."',
        'Sigo buscando e2e.', // ya estaba: no se repite
        'y'.repeat(250), // demasiado largo
        '',
        'Dame un segundito más.',
      ].join('\n'),
    );
    const res = await asAdmin(http(t).post('/settings/VOICEBOT_WAIT_TEXTS_SOURCE/propose-variants'))
      .send({ current: 'Sigo buscando e2e.' })
      .expect(201);
    expect(res.body.lines).toEqual(['Estoy consultando {label}, ya vuelvo.', 'Sigo acá, buscando.', 'Dame un segundito más.']);
    expect(llm.calls).toHaveLength(1);
    const prompt = llm.calls[0].messages[0].content;
    expect(prompt).toContain('{label}');
    expect(prompt).toContain('Sigo buscando e2e.'); // le pasa los que ya hay para no repetirlos
    // No guardó: la clave sigue como estaba.
    expect((await asAdmin(http(t).get('/settings/VOICEBOT_WAIT_TEXTS_SOURCE')).expect(200)).body.value).toBe('Sigo buscando e2e.');

    // Fuera de la lista de fuente, una propuesta con {label} se descarta.
    llm.setResponder(() => 'Consultando {label}\nEstoy cargando el pedido.');
    const ticket = await asAdmin(http(t).post('/settings/VOICEBOT_WAIT_TEXTS_TICKET/propose-variants')).send({ current: '' }).expect(201);
    expect(ticket.body.lines).toEqual(['Estoy cargando el pedido.']);

    // Solo las listas de avisos; el LLM caído da 502 con un mensaje para el admin.
    await asAdmin(http(t).post('/settings/OTP_TTL_SECONDS/propose-variants')).send({ current: '' }).expect(400);
    llm.setFailure(new Error('proveedor caído'));
    try {
      await asAdmin(http(t).post('/settings/VOICEBOT_WAIT_TEXTS/propose-variants')).send({ current: '' }).expect(502);
    } finally {
      llm.reset();
    }
  });

  it('BE-WAIT-05: cleanProposal saca numeración, viñetas y comillas', () => {
    expect(cleanProposal('3) “Un momento.”')).toBe('Un momento.');
    expect(cleanProposal('• Sigo acá')).toBe('Sigo acá');
  });
});
