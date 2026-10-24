/**
 * Integración voicebot/stt — importación de una sola vez de los `.env` — BE-INT-19..22
 *
 * `src/scripts/import-integration-env.ts` puebla la configuración de pci con los `.env` actuales
 * del voicebot y del stt: mapea cada variable a su clave del catálogo (`envNames`), guarda por
 * `SettingsService` (valida y cifra), sube la versión UNA vez y publica UN `config.changed`.
 * Dry-run por default; el reporte lleva nombres, nunca valores.
 *
 * Vía: `runEnvImport` con los servicios reales de la app sobre la base efímera, y el CLI real
 * (ts-node) en dry-run como proceso aparte, con el mismo `DATABASE_URL` efímero. Los `.env` son
 * inventados y se escriben en un directorio temporal.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as amqp from 'amqplib';
import { createTestApp, TestApp, deleteSetting } from './support';
import { BrokerService, BrokerMessage } from '../src/modules/broker/broker.service';
import { SettingsService } from '../src/modules/settings/settings.service';
import { SecretsCipher } from '../src/config/secrets.cipher';
import { IntegrationsConfigService } from '../src/modules/integrations/integrations-config.service';
import { parseEnvFile, EnvImportSource } from '../src/modules/integrations/env-import';
import { runEnvImport } from '../src/modules/integrations/env-import.runner';

const SECRET = 'secreto-inventado-e2e-7f3a';

const VOICEBOT_ENV = [
  '# .env inventado del voicebot',
  'PORT=3002',
  'PCI_URL=http://localhost:3001',
  'PCI_SERVICE_TOKEN=token-inventado',
  `RABBITMQ_URL=amqp://u:${SECRET}@10.9.9.9:5672/`,
  'LIVEKIT_URL=ws://10.9.9.9:7880',
  `LIVEKIT_API_SECRET=${SECRET}`,
  'STT_EXCHANGE=stt.e2e',
  'VOICEBOT_TURN_TIMEOUT_MS=7000',
  'LIVEKIT_ROOM=sale-del-contrato',
].join('\n');

const STT_ENV = [
  'STT_DEVICE=cpu',
  'STT_MODEL=medium',
  'STT_BEAM_SIZE=3',
  'STT_LIVEKIT_URL=ws://10.9.9.9:7880',
  // Distinto del voicebot: conflicto, no se escribe.
  'STT_EXCHANGE=stt.otro',
  'STT_SINK=rabbitmq',
].join('\n');

const WRITTEN = [
  'VOICEBOT_RABBITMQ_URL',
  'VOICEBOT_LIVEKIT_URL',
  'VOICEBOT_LIVEKIT_API_SECRET',
  'VOICEBOT_TURN_TIMEOUT_MS',
  'STT_MODEL',
  'STT_BEAM_SIZE',
];
const TOUCHED_KEYS = [...WRITTEN, 'STT_EXCHANGE'];

describe('Integración voicebot/stt: importación de los .env (BE-INT-19..22)', () => {
  let t: TestApp;
  let dir: string;
  let run: (apply: boolean) => ReturnType<typeof runEnvImport>;
  let channel: amqp.Channel;
  const received: BrokerMessage[] = [];

  const sources = (): EnvImportSource[] => [
    { consumer: 'voicebot', vars: parseEnvFile(VOICEBOT_ENV) },
    { consumer: 'stt', vars: parseEnvFile(STT_ENV) },
  ];
  const version = async () =>
    (await t.prisma.integrationConfigVersion.findUniqueOrThrow({ where: { id: 'voicebot' } })).version;
  const settle = () => new Promise((r) => setTimeout(r, 500));

  beforeAll(async () => {
    t = await createTestApp();
    for (const key of TOUCHED_KEYS) await deleteSetting(t.prisma, key);

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pci-env-import-'));
    fs.writeFileSync(path.join(dir, 'voicebot.env'), VOICEBOT_ENV);
    fs.writeFileSync(path.join(dir, 'stt.env'), STT_ENV);

    const deps = {
      prisma: t.prisma,
      settings: t.moduleRef.get(SettingsService),
      integrations: t.moduleRef.get(IntegrationsConfigService),
    };
    run = (apply) => runEnvImport(deps, sources(), { apply });

    channel = (t.moduleRef.get(BrokerService) as unknown as { channel: amqp.Channel }).channel;
    await channel.assertExchange('voicebot.events', 'topic', { durable: true });
    const queue = `e2e.env-import.${Date.now()}`;
    await channel.assertQueue(queue, { exclusive: true, autoDelete: true });
    await channel.bindQueue(queue, 'voicebot.events', 'config.changed');
    await channel.consume(queue, (msg) => {
      if (!msg) return;
      received.push(JSON.parse(msg.content.toString()));
      channel.ack(msg);
    });
  });

  afterAll(async () => {
    for (const key of TOUCHED_KEYS) await deleteSetting(t.prisma, key);
    fs.rmSync(dir, { recursive: true, force: true });
    await t.close();
  });

  it('BE-INT-19: dry-run no escribe, no sube la versión ni publica', async () => {
    const before = await version();
    const result = await run(false);

    const status = Object.fromEntries(result.entries.map((e) => [e.key, e.status]));
    for (const key of WRITTEN) expect(status[key]).toBe('alta');
    expect(status.STT_EXCHANGE).toBe('conflicto');
    expect(status.PCI_SERVICE_TOKEN).toBe('host');
    expect(status.STT_DEVICE).toBe('host');
    expect(status.STT_SINK).toBe('derivada');
    expect(status.LIVEKIT_ROOM).toBe('fuera-de-catalogo');
    expect(result.written).toEqual([]);

    expect(await t.prisma.setting.count({ where: { key: { in: TOUCHED_KEYS } } })).toBe(0);
    await settle();
    expect(await version()).toBe(before);
    expect(received).toEqual([]);
  });

  it('BE-INT-20: --apply escribe por SettingsService, cifra los secrets, sube la versión una vez y publica un config.changed', async () => {
    const before = await version();
    const result = await run(true);

    expect(result.written.sort()).toEqual([...WRITTEN].sort());
    expect(result.failed).toEqual([]);
    // El conflicto no se escribe.
    expect(await t.prisma.setting.findUnique({ where: { key: 'STT_EXCHANGE' } })).toBeNull();

    // Secret cifrado en la BD, como desde la UI.
    const row = await t.prisma.setting.findUniqueOrThrow({ where: { key: 'VOICEBOT_LIVEKIT_API_SECRET' } });
    expect(row.value).not.toContain(SECRET);
    expect(t.moduleRef.get(SecretsCipher).decrypt(row.value)).toBe(SECRET);
    const url = await t.prisma.setting.findUniqueOrThrow({ where: { key: 'VOICEBOT_RABBITMQ_URL' } });
    expect(url.value).not.toContain(SECRET);

    expect(await version()).toBe(before + 1);
    await settle();
    expect(received).toHaveLength(1);
    const data = received[0].data as { v: number; version: number; sections: string[]; restart: { stt: boolean } };
    expect(data.v).toBe(1);
    expect(data.version).toBe(before + 1);
    expect([...data.sections].sort()).toEqual(['conversacion', 'livekit', 'rabbitmq', 'stt']);
    expect(data.restart.stt).toBe(true);
  });

  it('BE-INT-21: correrlo otra vez no cambia nada: todo "sin-cambios", sin versión ni evento', async () => {
    const before = await version();
    const result = await run(true);

    const status = Object.fromEntries(result.entries.map((e) => [e.key, e.status]));
    for (const key of WRITTEN) expect(status[key]).toBe('sin-cambios');
    expect(result.written).toEqual([]);
    await settle();
    expect(await version()).toBe(before);
    expect(received).toHaveLength(1);
  });

  it('BE-INT-22: el CLI en dry-run imprime solo nombres de clave, nunca valores, y no escribe', async () => {
    for (const key of TOUCHED_KEYS) await deleteSetting(t.prisma, key);
    const before = await version();

    const cli = spawnSync(
      process.execPath,
      [
        require.resolve('ts-node/dist/bin.js'),
        'src/scripts/import-integration-env.ts',
        '--voicebot',
        path.join(dir, 'voicebot.env'),
        '--stt',
        path.join(dir, 'stt.env'),
      ],
      { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 120_000 },
    );

    expect(cli.status).toBe(0);
    const out = `${cli.stdout}\n${cli.stderr}`;
    expect(out).toContain('Dry-run');
    expect(out).toContain('VOICEBOT_LIVEKIT_API_SECRET');
    expect(out).toContain('conflicto (1):');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('10.9.9.9');
    expect(out).not.toContain('token-inventado');

    expect(await t.prisma.setting.count({ where: { key: { in: TOUCHED_KEYS } } })).toBe(0);
    expect(await version()).toBe(before);
  }, 150_000);
});
