import { formatEnvImportReport, parseEnvFile, planEnvImport } from './env-import';

/** Importación de los `.env` del voicebot/stt: parser y plan (sin BD). Valores inventados. */
describe('env-import', () => {
  describe('parseEnvFile', () => {
    it('lee CLAVE=valor, export, comillas y comentarios', () => {
      const vars = parseEnvFile(
        [
          '﻿# comentario',
          '',
          'A=1',
          'export B = dos ',
          'C="con # numeral"',
          "D='simples'",
          'E=valor # comentario al final',
          'F=',
          'G="linea\\nnueva"',
          'no es una asignación',
        ].join('\r\n'),
      );
      expect(vars).toEqual({
        A: '1',
        B: 'dos',
        C: 'con # numeral',
        D: 'simples',
        E: 'valor',
        F: '',
        G: 'linea\nnueva',
      });
    });
  });

  describe('planEnvImport', () => {
    const none = new Map<string, string>();
    const plan = (
      voicebot: Record<string, string>,
      stt: Record<string, string>,
      current = none,
      stored = new Set<string>(),
    ) =>
      planEnvImport(
        [
          { consumer: 'voicebot', vars: voicebot },
          { consumer: 'stt', vars: stt },
        ],
        current,
        stored,
      );
    const statusOf = (p: ReturnType<typeof plan>, key: string) => p.entries.find((e) => e.key === key)?.status;

    it('mapea cada envName a su clave de pci, con el mismo mapeo que los endpoints', () => {
      const p = plan(
        { RABBITMQ_URL: 'amqp://u:p@h1:5672/', LIVEKIT_URL: 'ws://h1:7880', MINIMAX_API_KEY: 'k-voz' },
        { STT_MODEL: 'small', STT_LIVEKIT_URL: 'ws://h1:7880' },
      );
      const writes = Object.fromEntries(p.writes.map((w) => [w.def.key, w.value]));
      expect(writes).toEqual({
        VOICEBOT_RABBITMQ_URL: 'amqp://u:p@h1:5672/',
        VOICEBOT_LIVEKIT_URL: 'ws://h1:7880',
        // DA13: la key de voz es independiente de la del chat.
        VOICEBOT_MINIMAX_API_KEY: 'k-voz',
        STT_MODEL: 'small',
      });
      expect(p.entries.find((e) => e.key === 'VOICEBOT_LIVEKIT_URL')?.from).toEqual([
        'voicebot:LIVEKIT_URL',
        'stt:STT_LIVEKIT_URL',
      ]);
    });

    it('un mismo valor con distinto valor en los dos .env es conflicto y no se escribe', () => {
      const p = plan({ RABBITMQ_URL: 'amqp://a/' }, { STT_RABBITMQ_URL: 'amqp://b/' });
      expect(statusOf(p, 'VOICEBOT_RABBITMQ_URL')).toBe('conflicto');
      expect(p.writes).toEqual([]);
    });

    it('vacío en un lado no choca: manda el otro; vacío en los dos es "vacia"', () => {
      const p = plan({ STT_EXCHANGE: '' , LIVEKIT_API_KEY: '' }, { STT_EXCHANGE: 'stt.x', STT_LIVEKIT_API_KEY: '' });
      expect(statusOf(p, 'STT_EXCHANGE')).toBe('alta');
      expect(statusOf(p, 'VOICEBOT_LIVEKIT_API_KEY')).toBe('vacia');
    });

    it('igual al valor efectivo actual es "sin-cambios"; con valor guardado distinto es "cambia"', () => {
      const current = new Map([
        ['STT_MODEL', 'small'],
        ['STT_LANGUAGE', 'es'],
      ]);
      const p = plan({}, { STT_MODEL: 'SMALL', STT_LANGUAGE: 'en' }, current, new Set(['STT_LANGUAGE']));
      // enum: se normaliza a minúsculas como al guardar.
      expect(statusOf(p, 'STT_MODEL')).toBe('sin-cambios');
      expect(statusOf(p, 'STT_LANGUAGE')).toBe('cambia');
      expect(p.writes.map((w) => w.def.key)).toEqual(['STT_LANGUAGE']);
    });

    it('lo que no valida contra el catálogo es "invalida"', () => {
      const p = plan({ VOICEBOT_SOURCE: 'kafka' }, { STT_BEAM_SIZE: '9' });
      expect(statusOf(p, 'VOICEBOT_SOURCE')).toBe('invalida');
      expect(statusOf(p, 'STT_BEAM_SIZE')).toBe('invalida');
      expect(p.writes).toEqual([]);
    });

    it('ignora las del host, la derivada y las ajenas al catálogo', () => {
      const p = plan(
        { PCI_URL: 'http://x', PORT: '3002', FFMPEG_PATH: 'f', LIVEKIT_ROOM: 'r', DATABASE_URL: 'd' },
        { PCI_SERVICE_TOKEN: 't', STT_DEVICE: 'cpu', OMP_NUM_THREADS: '4', LIVEKIT_URL: 'ws://dev', STT_SINK: 'http' },
      );
      expect(statusOf(p, 'PCI_URL')).toBe('host');
      expect(statusOf(p, 'PORT')).toBe('host');
      expect(statusOf(p, 'FFMPEG_PATH')).toBe('host');
      expect(statusOf(p, 'PCI_SERVICE_TOKEN')).toBe('host');
      expect(statusOf(p, 'STT_DEVICE')).toBe('host');
      expect(statusOf(p, 'OMP_NUM_THREADS')).toBe('host');
      // En el stt, `LIVEKIT_*` es solo dev: con pci usa `STT_LIVEKIT_*`.
      expect(statusOf(p, 'LIVEKIT_URL')).toBe('host');
      expect(statusOf(p, 'STT_SINK')).toBe('derivada');
      expect(statusOf(p, 'LIVEKIT_ROOM')).toBe('fuera-de-catalogo');
      expect(statusOf(p, 'DATABASE_URL')).toBe('fuera-de-catalogo');
      expect(p.writes).toEqual([]);
    });

    it('los nombres de pci (prefijo VOICEBOT_) no se aceptan como variable del .env', () => {
      // El .env del voicebot trae `RABBITMQ_URL`, no `VOICEBOT_RABBITMQ_URL`; ni los tokens de servicio.
      const p = plan({ VOICEBOT_RABBITMQ_URL: 'amqp://x/', VOICEBOT_SERVICE_TOKEN: 't' }, {});
      expect(statusOf(p, 'VOICEBOT_RABBITMQ_URL')).toBe('fuera-de-catalogo');
      expect(statusOf(p, 'VOICEBOT_SERVICE_TOKEN')).toBe('fuera-de-catalogo');
      expect(p.writes).toEqual([]);
    });

    it('el reporte lleva nombres y nunca valores', () => {
      const secret = 'valor-secreto-inventado-123';
      const p = plan(
        { RABBITMQ_URL: `amqp://u:${secret}@h/`, LIVEKIT_API_SECRET: secret, PCI_SERVICE_TOKEN: secret },
        { STT_RABBITMQ_URL: `amqp://otro:${secret}@h/`, STT_HOTWORDS: secret },
      );
      const report = formatEnvImportReport(p.entries);
      expect(report).toContain('conflicto (1):');
      expect(report).toContain('VOICEBOT_LIVEKIT_API_SECRET');
      expect(report).not.toContain(secret);
    });
  });
});
