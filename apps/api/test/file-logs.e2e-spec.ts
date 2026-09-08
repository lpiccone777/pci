/**
 * 1.28 Registros en disco (BE-LOG-*)
 *
 * Vía: se ejercitan los caminos REALES que escriben cada archivo —el webhook de Gupshup, el
 * envío saliente de Gupshup y el rechazo de un número no registrado en `handleMessage`— y se
 * leen los archivos que quedaron en `logs/`. Los servicios de log no se mockean: se los deja
 * escribir de verdad y se verifica el contenido.
 *
 * Frontera mockeada: `fetch` (API de Gupshup) y `LlmService`.
 *
 * Ojo: los dos servicios escriben bajo `process.cwd()/logs`, que en la corrida de Jest es
 * `apps/api/logs` — el mismo directorio que usa el entorno de desarrollo. Los tests solo
 * AGREGAN líneas y nunca borran archivos ajenos; el único que se borra es el que crea el
 * propio test de retención, y lo borra el código de producción al hacer su limpieza.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { LlmService } from '../src/modules/llm/llm.service';
import { GupshupWhatsAppService } from '../src/modules/whatsapp/gupshup-whatsapp.service';
import {
  createTestApp,
  TestApp,
  http,
  createTenant,
  createRole,
  createUser,
  installFetchMock,
  setSetting,
  deleteSetting,
  uniqueEmail,
  uniquePhone,
  uniqueSlug,
  FakeLlmService,
} from './support';

const GUPSHUP_LOG_DIR = join(process.cwd(), 'logs', 'gupshup');
const UNKNOWN_LOG_DIR = join(process.cwd(), 'logs', 'unknown-senders');

/** Etiqueta semana-ISO del archivo vigente — misma aritmética que los dos servicios. */
function isoWeekLabel(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** Líneas JSON del archivo de la semana en curso (vacío si todavía no existe). */
function readLines(dir: string, prefix: string): any[] {
  const file = join(dir, `${prefix}-${isoWeekLabel()}.log`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('1.28 Registros en disco (BE-LOG-*)', () => {
  let t: TestApp;
  let llm: FakeLlmService;

  let tenantId: string;
  let roleId: string;

  beforeAll(async () => {
    llm = new FakeLlmService();
    t = await createTestApp({ customize: (b) => b.overrideProvider(LlmService).useValue(llm) });

    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('log') });
    tenantId = tenant.id;
    const role = await createRole(t.prisma, { tenantId, name: 'Soporte log' });
    roleId = role.id;
  });

  afterAll(async () => {
    await t.close();
  });

  afterEach(async () => {
    await deleteSetting(t.prisma, 'GUPSHUP_API_KEY');
    await deleteSetting(t.prisma, 'GUPSHUP_WHATSAPP_SOURCE');
    await deleteSetting(t.prisma, 'GUPSHUP_APP_NAME');
    jest.restoreAllMocks();
  });

  // --- BE-LOG-01: log de Gupshup ---

  it('BE-LOG-01: el webhook recibido deja una línea JSON en el archivo de la semana', async () => {
    const antes = readLines(GUPSHUP_LOG_DIR, 'gupshup').length;

    const res = await http(t)
      .post('/webhooks/gupshup')
      .send({ type: 'message', payload: { type: 'text', text: 'hola log', sender: { phone: '5491100000001' } } });

    expect(res.status).toBe(200);
    const lineas = readLines(GUPSHUP_LOG_DIR, 'gupshup');
    expect(lineas.length).toBeGreaterThan(antes);
    const recibido = lineas.find((l) => l.event === 'webhook.received' && l.raw?.payload?.text === 'hola log');
    expect(recibido).toBeDefined();
    expect(typeof recibido.ts).toBe('string');
  });

  it('BE-LOG-01: un evento de entrega fallida también queda registrado', async () => {
    await http(t)
      .post('/webhooks/gupshup')
      .send({
        type: 'message-event',
        payload: { type: 'failed', destination: '5491100000002', payload: { code: 131037, reason: 'display name sin aprobar' } },
      });

    const fallido = readLines(GUPSHUP_LOG_DIR, 'gupshup').find(
      (l) => l.event === 'delivery.failed' && l.destination === '5491100000002',
    );
    expect(fallido).toBeDefined();
    expect(fallido.code).toBe(131037);
    expect(fallido.reason).toContain('display name sin aprobar');
  });

  it('BE-LOG-01: el envío saliente queda registrado', async () => {
    await setSetting(t.prisma, 'GUPSHUP_API_KEY', 'clave-secreta-de-gupshup-log-01');
    await setSetting(t.prisma, 'GUPSHUP_WHATSAPP_SOURCE', '5491100000000');
    await setSetting(t.prisma, 'GUPSHUP_APP_NAME', 'PciBotTest');
    const fetchMock = installFetchMock(() => ({ status: 200, body: { status: 'submitted' } }));
    const gupshup = t.moduleRef.get(GupshupWhatsAppService);

    await gupshup.sendText('+5491100000003', 'respuesta del bot');

    fetchMock.restore();
    const aceptado = readLines(GUPSHUP_LOG_DIR, 'gupshup').find(
      (l) => l.event === 'send.accepted' && l.body === 'respuesta del bot',
    );
    expect(aceptado).toBeDefined();
  });

  it('BE-LOG-01: el archivo se nombra por semana ISO y los de más de 8 semanas se borran solos', async () => {
    mkdirSync(GUPSHUP_LOG_DIR, { recursive: true });
    const viejo = join(GUPSHUP_LOG_DIR, 'gupshup-2019-W01.log');
    writeFileSync(viejo, '{"event":"viejo"}\n', 'utf8');
    // Fecha de modificación de hace 10 semanas: pasa el corte de retención (8).
    const hace10Semanas = Date.now() / 1000 - 10 * 7 * 24 * 60 * 60;
    utimesSync(viejo, hace10Semanas, hace10Semanas);
    expect(existsSync(viejo)).toBe(true);

    await http(t)
      .post('/webhooks/gupshup')
      .send({ type: 'message', payload: { type: 'text', text: 'dispara limpieza', sender: { phone: '5491100000004' } } });

    expect(existsSync(viejo)).toBe(false);
    // El de la semana en curso, en cambio, sigue.
    expect(
      readdirSync(GUPSHUP_LOG_DIR).some((f) => f === `gupshup-${isoWeekLabel()}.log`),
    ).toBe(true);
  });

  it('BE-LOG-01: un fallo de disco no tira la request del webhook', async () => {
    // Fallo de escritura REAL, sin espiar `fs` (sus exports no son redefinibles en Node
    // moderno: `jest.spyOn` tira "Cannot redefine property"): se ocupa el nombre del archivo
    // de esta semana con un DIRECTORIO, así `appendFileSync` falla con EISDIR y se ejercita
    // el catch del logger de verdad.
    mkdirSync(GUPSHUP_LOG_DIR, { recursive: true });
    const archivoSemana = join(GUPSHUP_LOG_DIR, `gupshup-${isoWeekLabel()}.log`);
    // Se conserva lo que el archivo ya tenía (líneas de esta corrida y del entorno de
    // desarrollo) y se restaura al final: la trampa no puede costar registros reales.
    const contenidoPrevio = existsSync(archivoSemana) ? readFileSync(archivoSemana, 'utf8') : null;
    if (contenidoPrevio !== null) rmSync(archivoSemana, { force: true });
    mkdirSync(archivoSemana);
    try {
      const res = await http(t)
        .post('/webhooks/gupshup')
        .send({ type: 'message', payload: { type: 'text', text: 'con disco roto', sender: { phone: '5491100000005' } } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    } finally {
      // Se saca la trampa y se devuelve el archivo como estaba.
      rmSync(archivoSemana, { recursive: true, force: true });
      if (contenidoPrevio !== null) writeFileSync(archivoSemana, contenidoPrevio, 'utf8');
    }
  });

  // --- BE-LOG-02: log de remitentes desconocidos ---

  it('BE-LOG-02: un número no registrado queda en el log de desconocidos y no deja filas en la base', async () => {
    const desconocido = uniquePhone();
    const antes = readLines(UNKNOWN_LOG_DIR, 'unknown').length;
    const textoLargo = `necesito ayuda ${'x'.repeat(400)}`;

    const res = await http(t)
      .post('/conversations/simulate')
      .set('Authorization', `Bearer ${t.authToken}`)
      .send({ from: desconocido, body: textoLargo, tenantId });

    expect(res.status).toBe(201);

    const lineas = readLines(UNKNOWN_LOG_DIR, 'unknown');
    expect(lineas.length).toBeGreaterThan(antes);
    const registro = lineas.find((l) => l.from === desconocido);
    expect(registro).toBeDefined();
    expect(registro.channel).toBeDefined();
    // Solo los primeros 200 caracteres del mensaje.
    expect(registro.bodyPreview).toHaveLength(200);
    expect(registro.bodyPreview).toBe(textoLargo.slice(0, 200));
    // El tenantId viaja porque el rechazo ocurrió dentro de una empresa ya resuelta.
    expect(registro.tenantId).toBe(tenantId);

    // Y no quedó rastro en la base.
    const user = await t.prisma.user.findFirst({ where: { phone: desconocido } });
    expect(user).toBeNull();
    const conversaciones = await t.prisma.conversation.count({ where: { tenantId } });
    expect(conversaciones).toBe(0);
  });

  it('BE-LOG-02: un número registrado no aparece en el log de desconocidos', async () => {
    const conocido = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('log-conocido'),
      phone: conocido,
      memberships: [{ tenantId, roleId }],
    });
    llm.setReply('te ayudo con eso');

    await http(t)
      .post('/conversations/simulate')
      .set('Authorization', `Bearer ${t.authToken}`)
      .send({ from: conocido, body: 'hola, soy de la casa', tenantId });

    const registro = readLines(UNKNOWN_LOG_DIR, 'unknown').find((l) => l.from === conocido);
    expect(registro).toBeUndefined();
  });

  // --- BE-LOG-03: datos sensibles ---

  it('BE-LOG-03: ningún secreto configurado cae en los archivos de log', async () => {
    const apiKey = 'gupshup-secreto-que-no-debe-loguearse-log03';
    await setSetting(t.prisma, 'GUPSHUP_API_KEY', apiKey);
    await setSetting(t.prisma, 'GUPSHUP_WHATSAPP_SOURCE', '5491100000000');
    await setSetting(t.prisma, 'GUPSHUP_APP_NAME', 'PciBotTest');
    const fetchMock = installFetchMock(() => ({ status: 200, body: { status: 'submitted' } }));
    const gupshup = t.moduleRef.get(GupshupWhatsAppService);

    await gupshup.sendText('+5491100000006', 'mensaje saliente');
    await http(t)
      .post('/webhooks/gupshup')
      .send({ type: 'message', payload: { type: 'text', text: 'entrante', sender: { phone: '5491100000006' } } });
    fetchMock.restore();

    const gupshupFile = join(GUPSHUP_LOG_DIR, `gupshup-${isoWeekLabel()}.log`);
    const unknownFile = join(UNKNOWN_LOG_DIR, `unknown-${isoWeekLabel()}.log`);
    for (const file of [gupshupFile, unknownFile]) {
      if (!existsSync(file)) continue;
      const contenido = readFileSync(file, 'utf8');
      expect(contenido).not.toContain(apiKey);
    }
  });

  it('BE-LOG-03: el log de Gupshup sí guarda en claro el texto y el teléfono del usuario (dato a vigilar)', async () => {
    const telefono = '5491100000007';
    const textoSensible = 'mi dni es 30111222 y vivo en la calle falsa 123';

    await http(t)
      .post('/webhooks/gupshup')
      .send({ type: 'message', payload: { type: 'text', text: textoSensible, sender: { phone: telefono } } });

    // Comportamiento REAL, documentado por el caso: el payload crudo va al archivo sin cifrar y
    // queda ahí 8 semanas. El test lo fija para que un cambio de criterio (redacción, cifrado o
    // retención) se note en la batería en vez de pasar inadvertido.
    const contenido = readFileSync(join(GUPSHUP_LOG_DIR, `gupshup-${isoWeekLabel()}.log`), 'utf8');
    expect(contenido).toContain(textoSensible);
    expect(contenido).toContain(telefono);
  });
});
