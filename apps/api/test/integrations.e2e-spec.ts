/**
 * Integración voicebot/stt — configuración servida por pci — BE-INT-*
 *
 * Contrato de integración (repo voicebot, `docs/integracion-pci/contrato.md`) §2, §3.1–§3.4:
 * - `GET /integrations/voicebot/config` y `GET /integrations/stt/config`, con token de servicio
 *   (`ServiceTokenGuard`), fuera de la cadena JWT/tenant.
 * - Nombres del consumidor (`envNames`), no las claves de pci; secrets en claro solo acá [DA2].
 * - `version` atómica en BD, que sube con cada cambio de una clave de la integración, y evento
 *   `config.changed` en el exchange `voicebot.events`.
 *
 * Vía: endpoints REST reales con supertest sobre la base efímera. Los settings se cargan por
 * `PATCH /settings` (el camino real, que cifra los secrets). El evento se observa bindeando una
 * cola propia al exchange real, sobre el canal del `BrokerService` de la app (su vhost efímero).
 */
import type * as amqp from 'amqplib';
import {
  createTestApp,
  TestApp,
  tokenFor,
  withAuth,
  http,
  getSystemContext,
  deleteSetting,
} from './support';
import { BrokerService, BrokerMessage } from '../src/modules/broker/broker.service';
import { SETTINGS_CATALOG } from '../src/modules/settings/settings.catalog';

const VOICEBOT_TOKEN = 'e2e-voicebot-token-0123456789';
const STT_TOKEN = 'e2e-stt-token-0123456789';

/** Todo lo que este spec escribe en `Setting`: se borra al terminar. */
const TOUCHED_KEYS = [
  'VOICEBOT_SERVICE_TOKEN',
  'STT_SERVICE_TOKEN',
  'VOICEBOT_ENABLED',
  'VOICEBOT_LIVEKIT_URL',
  'VOICEBOT_LIVEKIT_API_SECRET',
  'VOICEBOT_MINIMAX_API_KEY',
  'MINIMAX_API_KEY',
  'VOICEBOT_SOURCE',
  'STT_SINK_CONSOLE',
  'STT_MODEL',
  'OTP_TTL_SECONDS',
];

describe('Integración voicebot/stt: configuración servida por pci (BE-INT-*)', () => {
  let t: TestApp;
  let adminToken: string;
  let systemTenantId: string;

  const patchSetting = (key: string, value: string) =>
    withAuth(http(t).patch(`/settings/${key}`), adminToken, systemTenantId).send({ value });
  const voicebotConfig = (token?: string) => {
    const req = http(t).get('/integrations/voicebot/config');
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const sttConfig = (token?: string) => {
    const req = http(t).get('/integrations/stt/config');
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  beforeAll(async () => {
    t = await createTestApp();
    const { admin, tenant } = await getSystemContext(t.prisma);
    adminToken = tokenFor(t, admin);
    systemTenantId = tenant.id;
  });

  afterAll(async () => {
    for (const key of TOUCHED_KEYS) await deleteSetting(t.prisma, key);
    await t.close();
  });

  describe('ServiceTokenGuard', () => {
    beforeAll(async () => {
      await patchSetting('VOICEBOT_SERVICE_TOKEN', VOICEBOT_TOKEN).expect(200);
      await patchSetting('STT_SERVICE_TOKEN', STT_TOKEN).expect(200);
    });

    it('BE-INT-01: sin Authorization → 401, con Cache-Control: no-store y sin datos', async () => {
      const res = await voicebotConfig().expect(401);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.settings).toBeUndefined();
    });

    it('BE-INT-02: token inválido → 401', async () => {
      await voicebotConfig('otro-token').expect(401);
      await sttConfig('otro-token').expect(401);
    });

    it('BE-INT-03: los tokens no son intercambiables: el del voicebot no abre el del stt y viceversa', async () => {
      await sttConfig(VOICEBOT_TOKEN).expect(401);
      await voicebotConfig(STT_TOKEN).expect(401);
    });

    it('BE-INT-04: un JWT de backoffice válido no sirve: la ruta exige token de servicio', async () => {
      await voicebotConfig(adminToken).expect(401);
    });

    it('BE-INT-05: con el token sin configurar en pci, la ruta rechaza todo', async () => {
      await deleteSetting(t.prisma, 'STT_SERVICE_TOKEN');
      try {
        await sttConfig(STT_TOKEN).expect(401);
        // Ni siquiera un Bearer vacío "matchea" un token vacío.
        await http(t).get('/integrations/stt/config').set('Authorization', 'Bearer ').expect(401);
      } finally {
        await patchSetting('STT_SERVICE_TOKEN', STT_TOKEN).expect(200);
      }
    });

    it('BE-INT-06: token válido → 200 con Cache-Control: no-store', async () => {
      const res = await voicebotConfig(VOICEBOT_TOKEN).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      await sttConfig(STT_TOKEN).expect(200);
    });
  });

  describe('GET /integrations/voicebot/config (contrato §3.1)', () => {
    it('BE-INT-07: forma del contrato, con nombres del voicebot y no claves de pci', async () => {
      await patchSetting('VOICEBOT_LIVEKIT_URL', 'ws://10.0.0.1:7880').expect(200);
      const res = await voicebotConfig(VOICEBOT_TOKEN).expect(200);

      expect(res.body.v).toBe(1);
      expect(typeof res.body.version).toBe('number');
      expect(new Date(res.body.updatedAt).toString()).not.toBe('Invalid Date');
      expect(res.body.extensions).toEqual([]);

      const settings = res.body.settings as Record<string, string>;
      expect(settings.LIVEKIT_URL).toBe('ws://10.0.0.1:7880');
      expect(settings.VOICEBOT_LIVEKIT_URL).toBeUndefined();
      // Todo valor es string (mapa plano NOMBRE → string).
      for (const value of Object.values(settings)) expect(typeof value).toBe('string');
      // Defaults del voicebot cuando no hay nada guardado.
      expect(settings.VOICEBOT_QUEUE).toBe('voicebot.turns');
      expect(settings.MINIMAX_LLM_API).toBe('anthropic');
      // Lo que es solo del stt no va, ni los tokens de servicio.
      expect(settings.STT_MODEL).toBeUndefined();
      expect(settings.STT_LIVEKIT_URL).toBeUndefined();
      expect(settings.VOICEBOT_SERVICE_TOKEN).toBeUndefined();
      // La tolerancia del JWT es solo del voicebot [C38].
      expect(settings.STT_HTTP_JWT_LEEWAY_S).toBe('10');
    });

    it('BE-INT-08: los secrets viajan en claro acá (y solo acá: /settings sigue enmascarando)', async () => {
      await patchSetting('VOICEBOT_LIVEKIT_API_SECRET', 'livekit-secret-e2e-abcdef').expect(200);
      const res = await voicebotConfig(VOICEBOT_TOKEN).expect(200);
      expect(res.body.settings.LIVEKIT_API_SECRET).toBe('livekit-secret-e2e-abcdef');

      const masked = await withAuth(
        http(t).get('/settings/VOICEBOT_LIVEKIT_API_SECRET'),
        adminToken,
        systemTenantId,
      ).expect(200);
      expect(masked.body.value).not.toContain('livekit-secret-e2e-abcdef');
      expect(masked.body.isSet).toBe(true);
    });

    it('BE-INT-09: la key de MiniMax del voicebot es independiente de la del chat de pci [DA13]', async () => {
      await patchSetting('MINIMAX_API_KEY', 'chat-key-e2e-111111').expect(200);
      await patchSetting('VOICEBOT_MINIMAX_API_KEY', 'voice-key-e2e-222222').expect(200);
      const res = await voicebotConfig(VOICEBOT_TOKEN).expect(200);
      expect(res.body.settings.MINIMAX_API_KEY).toBe('voice-key-e2e-222222');
    });
  });

  describe('GET /integrations/stt/config (contrato §3.2)', () => {
    it('BE-INT-10: nombres del stt; un mismo valor compartido sale con el nombre de cada consumidor', async () => {
      await patchSetting('VOICEBOT_LIVEKIT_URL', 'ws://10.0.0.2:7880').expect(200);
      await patchSetting('STT_MODEL', 'medium').expect(200);
      const res = await sttConfig(STT_TOKEN).expect(200);

      expect(res.body.v).toBe(1);
      expect(typeof res.body.version).toBe('number');
      const env = res.body.env as Record<string, string>;
      expect(env.STT_LIVEKIT_URL).toBe('ws://10.0.0.2:7880');
      expect(env.LIVEKIT_URL).toBeUndefined();
      expect(env.STT_MODEL).toBe('medium');
      expect(env.STT_EXCHANGE).toBe('stt.transcripts');
      expect(env.STT_RABBITMQ_URL).toBeDefined();
      // Fuera del endpoint del stt: lo que firma pero no valida [C38], lo que lee OpenMP antes de
      // pedir la config [C10] y lo que es solo del voicebot.
      expect(env.STT_HTTP_JWT_LEEWAY_S).toBeUndefined();
      expect(env.OMP_NUM_THREADS).toBeUndefined();
      expect(env.VOICEBOT_QUEUE).toBeUndefined();
      expect(env.STT_SINK_CONSOLE).toBeUndefined();
    });

    it('BE-INT-11: STT_SINK se deriva de VOICEBOT_SOURCE (+ console opcional) [C39]', async () => {
      await patchSetting('VOICEBOT_SOURCE', 'amqp').expect(200);
      await patchSetting('STT_SINK_CONSOLE', 'false').expect(200);
      expect((await sttConfig(STT_TOKEN).expect(200)).body.env.STT_SINK).toBe('rabbitmq');

      await patchSetting('VOICEBOT_SOURCE', 'http').expect(200);
      expect((await sttConfig(STT_TOKEN).expect(200)).body.env.STT_SINK).toBe('http');

      await patchSetting('STT_SINK_CONSOLE', 'true').expect(200);
      expect((await sttConfig(STT_TOKEN).expect(200)).body.env.STT_SINK).toBe('http,console');
    });
  });

  describe('Catálogo', () => {
    it('BE-INT-12: toda clave del voicebot/stt lleva prefijo VOICEBOT_/STT_ y no pisa claves propias de pci', () => {
      const voicebotDefs = SETTINGS_CATALOG.filter((d) => d.group.startsWith('Mensajería: Voicebot'));
      expect(voicebotDefs.length).toBeGreaterThan(0);
      for (const def of voicebotDefs) expect(def.key).toMatch(/^(VOICEBOT_|STT_)/);
      // Las claves de pci que chocaban siguen siendo de pci, sin envNames.
      for (const key of ['MINIMAX_API_KEY', 'MINIMAX_BASE_URL']) {
        expect(SETTINGS_CATALOG.find((d) => d.key === key)?.envNames).toBeUndefined();
      }
      expect(SETTINGS_CATALOG.find((d) => d.key === 'RABBITMQ_URL')).toBeUndefined();
    });

    it('BE-INT-13: /settings expone enabledBy: todo depende de VOICEBOT_ENABLED salvo el interruptor y los tokens', async () => {
      const res = await withAuth(http(t).get('/settings'), adminToken, systemTenantId).expect(200);
      const voicebot = (res.body as Array<{ key: string; group: string; enabledBy?: string }>).filter((s) =>
        s.group.startsWith('Mensajería: Voicebot'),
      );
      // La UI arma la habilitación condicional con `enabledBy`: todo depende del interruptor
      // salvo el interruptor mismo y los tokens.
      const ungated = voicebot.filter((s) => !s.enabledBy).map((s) => s.key).sort();
      expect(ungated).toEqual(['STT_SERVICE_TOKEN', 'VOICEBOT_ENABLED', 'VOICEBOT_SERVICE_TOKEN']);
    });
  });

  describe('Versión y config.changed (contrato §3.1, §3.3)', () => {
    let channel: amqp.Channel;
    let queue: string;
    const received: BrokerMessage[] = [];

    beforeAll(async () => {
      // Canal del BrokerService de la app (su vhost efímero). Cola propia, exclusiva y con nombre:
      // como haría un consumidor real.
      channel = (t.moduleRef.get(BrokerService) as unknown as { channel: amqp.Channel }).channel;
      await channel.assertExchange('voicebot.events', 'topic', { durable: true });
      queue = `e2e.config.${Date.now()}`;
      await channel.assertQueue(queue, { exclusive: true, autoDelete: true });
      await channel.bindQueue(queue, 'voicebot.events', 'config.changed');
      await channel.consume(queue, (msg) => {
        if (!msg) return;
        received.push(JSON.parse(msg.content.toString()));
        channel.ack(msg);
      });
    });

    const version = async () => (await voicebotConfig(VOICEBOT_TOKEN).expect(200)).body.version as number;
    const waitForEvent = async (minVersion: number) => {
      for (let i = 0; i < 50; i++) {
        const found = received.find((m) => (m.data as { version: number }).version >= minVersion);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no llegó config.changed con version >= ${minVersion}`);
    };

    it('BE-INT-14: guardar una clave del voicebot sube la versión y publica config.changed', async () => {
      const before = await version();
      await patchSetting('VOICEBOT_ENABLED', 'true').expect(200);
      const after = await version();
      expect(after).toBe(before + 1);

      const event = await waitForEvent(after);
      expect(event.pattern).toBe('config.changed');
      expect(event.data).toEqual({ v: 1, version: after, sections: ['general'], restart: { stt: false } });
      // Los dos endpoints comparten la versión.
      expect((await sttConfig(STT_TOKEN).expect(200)).body.version).toBe(after);
    });

    it('BE-INT-15: una clave que el stt toma al arrancar avisa restart.stt', async () => {
      await patchSetting('STT_MODEL', 'small').expect(200);
      const event = await waitForEvent(await version());
      expect(event.data).toMatchObject({ sections: ['stt'], restart: { stt: true } });
    });

    it('BE-INT-16: restaurar (DELETE) también sube la versión', async () => {
      const before = await version();
      await withAuth(http(t).delete('/settings/STT_MODEL'), adminToken, systemTenantId).expect(200);
      expect(await version()).toBe(before + 1);
    });

    it('BE-INT-17: una clave ajena a la integración no sube la versión ni publica', async () => {
      const before = await version();
      const eventsBefore = received.length;
      await patchSetting('OTP_TTL_SECONDS', '301').expect(200);
      expect(await version()).toBe(before);
      await new Promise((r) => setTimeout(r, 300));
      expect(received.length).toBe(eventsBefore);
    });

    it('BE-INT-18: los tokens de servicio no son configuración servida: no suben la versión', async () => {
      const before = await version();
      await patchSetting('STT_SERVICE_TOKEN', STT_TOKEN).expect(200);
      expect(await version()).toBe(before);
    });
  });
});
