/**
 * Claves de configuración del voicebot y del stt (contrato de integración §3.4, repo voicebot:
 * `docs/integracion-pci/contrato.md`). pci es la fuente de verdad: el voicebot y el stt las
 * leen de `GET /integrations/{voicebot,stt}/config` (ver `IntegrationsConfigService`).
 *
 * Reglas del contrato que se reflejan acá:
 * - **Nombres:** toda clave lleva prefijo `VOICEBOT_` o `STT_`. Si el nombre del consumidor no
 *   lo tiene, se le antepone `VOICEBOT_` (`RABBITMQ_URL` → `VOICEBOT_RABBITMQ_URL`). El nombre
 *   que ve cada consumidor va en `envNames`. Así no choca con claves propias de pci
 *   (`MINIMAX_API_KEY` del chat, `RABBITMQ_URL` del broker) ni hereda sus valores por la
 *   cascada BD→env.
 * - **Un solo valor por dato:** lo que el voicebot y el stt comparten (LiveKit, RabbitMQ, JWT
 *   del sink HTTP) es UNA clave con dos `envNames`, no dos claves que se puedan desincronizar.
 * - **Defaults** = los de hoy en el voicebot (`voicebot/apps/api/src/config/env.validation.ts`,
 *   `.env.example`) y en el stt (`stt/docs/INTEGRATION.md` §8.1).
 * - **`STT_SINK` no se edita** [C39]: se deriva de `VOICEBOT_SOURCE` (`amqp` → `rabbitmq`,
 *   `http` → `http`) más `console` opcional (`STT_SINK_CONSOLE`). Así no hay combinación
 *   incoherente que validar.
 * - El stt toma todo solo al arrancar: sus claves llevan `restartsStt`.
 *
 * Este archivo solo importa tipos de `settings.catalog.ts` (que a su vez importa estos valores):
 * no agregar imports de valores desde allá, o se arma un ciclo en la carga de módulos.
 */
import type { SettingDefinition } from './settings.catalog';

/** Sub-pestañas de *Configuración → Mensajería → Voicebot* (una por fila de la tabla §3.4). */
export const VOICEBOT_SETTING_GROUPS = [
  'Mensajería: Voicebot',
  'Mensajería: Voicebot (LiveKit)',
  'Mensajería: Voicebot (RabbitMQ)',
  'Mensajería: Voicebot (Entrada STT)',
  'Mensajería: Voicebot (STT)',
  'Mensajería: Voicebot (TTS)',
  'Mensajería: Voicebot (LLM de voz)',
  'Mensajería: Voicebot (Conversación)',
  'Mensajería: Voicebot (Capacidad)',
  'Mensajería: Voicebot (SIP entrante)',
  'Mensajería: Voicebot (SIP saliente)',
  'Mensajería: Voicebot (Llamadas salientes)',
] as const;
export type VoicebotSettingGroup = (typeof VOICEBOT_SETTING_GROUPS)[number];

/**
 * Id de cada grupo en `config.changed.sections` (contrato §3.3: solo informativos). Los
 * internos (H2) suman `extensions`.
 */
export const VOICEBOT_SECTION_IDS: Record<VoicebotSettingGroup, string> = {
  'Mensajería: Voicebot': 'general',
  'Mensajería: Voicebot (LiveKit)': 'livekit',
  'Mensajería: Voicebot (RabbitMQ)': 'rabbitmq',
  'Mensajería: Voicebot (Entrada STT)': 'entrada-stt',
  'Mensajería: Voicebot (STT)': 'stt',
  'Mensajería: Voicebot (TTS)': 'tts',
  'Mensajería: Voicebot (LLM de voz)': 'llm',
  'Mensajería: Voicebot (Conversación)': 'conversacion',
  'Mensajería: Voicebot (Capacidad)': 'capacidad',
  'Mensajería: Voicebot (SIP entrante)': 'sip-entrante',
  'Mensajería: Voicebot (SIP saliente)': 'sip-saliente',
  'Mensajería: Voicebot (Llamadas salientes)': 'llamadas-salientes',
};

const ENABLED_BY = 'VOICEBOT_ENABLED';

/** Toda clave del voicebot salvo el interruptor general y los tokens depende del interruptor. */
function gated(def: SettingDefinition): SettingDefinition {
  return { enabledBy: ENABLED_BY, ...def };
}

/** Clave que solo lee el voicebot, con el nombre `envName`. */
function voicebot(envName: string, def: Omit<SettingDefinition, 'envNames'>): SettingDefinition {
  return gated({ ...def, envNames: { voicebot: envName } });
}

/** Clave que solo lee el stt, con su mismo nombre. Toda clave del stt se toma al arrancar. */
function stt(def: Omit<SettingDefinition, 'envNames' | 'group'>): SettingDefinition {
  return gated({
    ...def,
    group: 'Mensajería: Voicebot (STT)',
    envNames: { stt: def.key },
    restartsStt: true,
  });
}

export const VOICEBOT_SETTINGS: SettingDefinition[] = [
  // --- General ---
  {
    key: 'VOICEBOT_ENABLED',
    type: 'boolean',
    group: 'Mensajería: Voicebot',
    label: 'Habilitar el voicebot',
    defaultValue: 'false',
    envNames: { voicebot: 'VOICEBOT_ENABLED' },
    reconnects: true,
    description:
      'Apagado, el voicebot no atiende llamadas ni consume colas, pero sigue vivo y escuchando ' +
      'cambios de configuración. Habilita el resto de las sub-pestañas del voicebot.',
  },
  {
    key: 'VOICEBOT_SERVICE_TOKEN',
    type: 'string',
    group: 'Mensajería: Voicebot',
    label: 'Token de servicio del voicebot',
    defaultValue: '',
    secret: true,
    description:
      'Con este token el voicebot lee su configuración de pci (Authorization: Bearer). En el ' +
      'voicebot va como PCI_SERVICE_TOKEN en su .env. Sin valor, el endpoint rechaza todo.',
  },
  {
    key: 'STT_SERVICE_TOKEN',
    type: 'string',
    group: 'Mensajería: Voicebot',
    label: 'Token de servicio del stt',
    defaultValue: '',
    secret: true,
    description:
      'Igual que el del voicebot, pero para el stt (PCI_SERVICE_TOKEN en el .env del stt). Son ' +
      'tokens separados para poder revocar uno sin el otro.',
  },

  // --- LiveKit --- (compartido: el stt lo recibe como STT_LIVEKIT_*)
  gated({
    key: 'VOICEBOT_LIVEKIT_URL',
    type: 'string',
    group: 'Mensajería: Voicebot (LiveKit)',
    label: 'URL de LiveKit',
    defaultValue: '',
    placeholder: 'ws://<host>:7880',
    envNames: { voicebot: 'LIVEKIT_URL', stt: 'STT_LIVEKIT_URL' },
    reconnects: true,
    restartsStt: true,
    description: 'Servidor LiveKit de las llamadas. La usan el voicebot y el stt.',
  }),
  gated({
    key: 'VOICEBOT_LIVEKIT_API_KEY',
    type: 'string',
    group: 'Mensajería: Voicebot (LiveKit)',
    label: 'API key de LiveKit',
    defaultValue: '',
    envNames: { voicebot: 'LIVEKIT_API_KEY', stt: 'STT_LIVEKIT_API_KEY' },
    reconnects: true,
    restartsStt: true,
    description: 'Identificador de la API key de LiveKit (el secreto va aparte).',
  }),
  gated({
    key: 'VOICEBOT_LIVEKIT_API_SECRET',
    type: 'string',
    group: 'Mensajería: Voicebot (LiveKit)',
    label: 'API secret de LiveKit',
    defaultValue: '',
    secret: true,
    envNames: { voicebot: 'LIVEKIT_API_SECRET', stt: 'STT_LIVEKIT_API_SECRET' },
    reconnects: true,
    restartsStt: true,
    description: 'Se guarda cifrado.',
  }),

  // --- RabbitMQ --- (el que une stt → voicebot; no es el broker de pci)
  gated({
    key: 'VOICEBOT_RABBITMQ_URL',
    type: 'string',
    group: 'Mensajería: Voicebot (RabbitMQ)',
    label: 'URL del broker de transcripciones',
    defaultValue: 'amqp://guest:guest@localhost:5672/',
    secret: true,
    envNames: { voicebot: 'RABBITMQ_URL', stt: 'STT_RABBITMQ_URL' },
    reconnects: true,
    restartsStt: true,
    description:
      'Broker por donde el stt le publica las transcripciones al voicebot. Lleva credenciales: ' +
      'se guarda cifrado. No es el broker de pci (ese sale del .env de pci).',
  }),
  gated({
    key: 'STT_EXCHANGE',
    type: 'string',
    group: 'Mensajería: Voicebot (RabbitMQ)',
    label: 'Exchange de transcripciones',
    defaultValue: 'stt.transcripts',
    envNames: { voicebot: 'STT_EXCHANGE', stt: 'STT_EXCHANGE' },
    reconnects: true,
    restartsStt: true,
    description: 'Exchange topic donde el stt publica y del que el voicebot consume.',
  }),
  voicebot('VOICEBOT_QUEUE', {
    key: 'VOICEBOT_QUEUE',
    type: 'string',
    group: 'Mensajería: Voicebot (RabbitMQ)',
    label: 'Cola del voicebot',
    defaultValue: 'voicebot.turns',
    reconnects: true,
    description: 'Cola propia del voicebot, bindeada al exchange de transcripciones.',
  }),
  voicebot('VOICEBOT_ROUTING_KEY', {
    key: 'VOICEBOT_ROUTING_KEY',
    type: 'string',
    group: 'Mensajería: Voicebot (RabbitMQ)',
    label: 'Patrón de binding',
    defaultValue: 'transcript.#',
    reconnects: true,
    description: 'Routing key con la que la cola del voicebot se bindea al exchange.',
  }),
  voicebot('VOICEBOT_QUEUE_TTL_MS', {
    key: 'VOICEBOT_QUEUE_TTL_MS',
    type: 'number',
    group: 'Mensajería: Voicebot (RabbitMQ)',
    label: 'TTL de la cola (ms)',
    defaultValue: '30000',
    min: 1000,
    max: 600000,
    reconnects: true,
    description:
      'Una frase que esperó más que esto en la cola ya no sirve y se descarta. Al cambiarlo, el ' +
      'voicebot borra y recrea su cola (si no, RabbitMQ responde PRECONDITION_FAILED).',
  }),
  voicebot('VOICEBOT_PREFETCH', {
    key: 'VOICEBOT_PREFETCH',
    type: 'number',
    group: 'Mensajería: Voicebot (RabbitMQ)',
    label: 'Prefetch',
    defaultValue: '50',
    min: 1,
    max: 1000,
    reconnects: true,
    description: 'Mensajes sin confirmar que el voicebot acepta a la vez.',
  }),

  // --- Entrada STT ---
  gated({
    key: 'VOICEBOT_SOURCE',
    type: 'enum',
    group: 'Mensajería: Voicebot (Entrada STT)',
    label: 'Entrada de transcripciones',
    defaultValue: 'amqp',
    allowedValues: ['amqp', 'http'],
    envNames: { voicebot: 'VOICEBOT_SOURCE' },
    reconnects: true,
    // Define el STT_SINK del stt (ver `deriveSttSink`).
    restartsStt: true,
    description:
      'amqp: el stt publica en RabbitMQ. http: el stt le hace POST al voicebot (exige el secreto ' +
      'JWT). Define también por dónde publica el stt (STT_SINK), así que cambiarlo reinicia el stt.',
  }),
  gated({
    key: 'STT_HTTP_JWT_SECRET',
    type: 'string',
    group: 'Mensajería: Voicebot (Entrada STT)',
    label: 'Secreto JWT del POST del stt',
    defaultValue: '',
    secret: true,
    envNames: { voicebot: 'STT_HTTP_JWT_SECRET', stt: 'STT_HTTP_JWT_SECRET' },
    restartsStt: true,
    description: 'HS256 compartido: el stt firma, el voicebot valida. Solo con entrada http.',
  }),
  gated({
    key: 'STT_HTTP_JWT_ISSUER',
    type: 'string',
    group: 'Mensajería: Voicebot (Entrada STT)',
    label: 'Issuer del JWT',
    defaultValue: 'stt-service',
    envNames: { voicebot: 'STT_HTTP_JWT_ISSUER', stt: 'STT_HTTP_JWT_ISSUER' },
    restartsStt: true,
    description: 'Mismo valor en los dos lados.',
  }),
  gated({
    key: 'STT_HTTP_JWT_AUDIENCE',
    type: 'string',
    group: 'Mensajería: Voicebot (Entrada STT)',
    label: 'Audience del JWT (opcional)',
    defaultValue: '',
    envNames: { voicebot: 'STT_HTTP_JWT_AUDIENCE', stt: 'STT_HTTP_JWT_AUDIENCE' },
    restartsStt: true,
    description: 'Vacío = sin audience. Si tiene valor, el voicebot exige el mismo.',
  }),
  // Solo el voicebot: el stt firma, no valida [C38].
  voicebot('STT_HTTP_JWT_LEEWAY_S', {
    key: 'STT_HTTP_JWT_LEEWAY_S',
    type: 'number',
    group: 'Mensajería: Voicebot (Entrada STT)',
    label: 'Tolerancia de reloj del JWT (s)',
    defaultValue: '10',
    min: 0,
    max: 300,
    description: 'Margen que acepta el voicebot al validar el vencimiento del JWT.',
  }),

  // --- STT --- (todas solo al arrancar el stt)
  stt({
    key: 'STT_MODEL',
    type: 'enum',
    label: 'Modelo de Whisper',
    defaultValue: 'small',
    allowedValues: ['tiny', 'base', 'small', 'medium', 'large-v3'],
    description: 'Más grande = más preciso y más lento.',
  }),
  stt({
    key: 'STT_LANGUAGE',
    type: 'string',
    label: 'Idioma',
    defaultValue: 'es',
    placeholder: 'es',
    description: 'Código ISO (es, en, …). La auto-detección no está soportada hoy.',
  }),
  stt({
    key: 'STT_BEAM_SIZE',
    type: 'number',
    label: 'Beam size',
    defaultValue: '5',
    min: 1,
    max: 5,
    description: '1 = menor latencia, 5 = más preciso.',
  }),
  stt({
    key: 'STT_HOTWORDS',
    type: 'string',
    label: 'Hotwords',
    defaultValue: '',
    description: 'Palabras que el modelo debe preferir, separadas por coma.',
  }),
  stt({
    key: 'STT_MAX_NO_SPEECH_PROB',
    type: 'number',
    label: 'Probabilidad máxima de "no hay voz"',
    defaultValue: '0.6',
    min: 0,
    max: 1,
    description: 'Menor = más estricto para descartar segmentos sin voz.',
  }),
  stt({
    key: 'STT_MIN_AVG_LOGPROB',
    type: 'number',
    label: 'Log-probabilidad promedio mínima',
    defaultValue: '-0.9',
    min: -5,
    max: 0,
    description: 'Típico entre -1.5 y -0.3. Más cerca de 0 = más estricto.',
  }),
  stt({
    key: 'STT_MIN_RMS',
    type: 'number',
    label: 'Energía mínima (RMS)',
    defaultValue: '0.004',
    min: 0,
    max: 1,
    description: '0 desactiva el filtro. Típico entre 0.002 y 0.02.',
  }),
  stt({
    key: 'STT_DROP_HALLUCINATIONS',
    type: 'boolean',
    label: 'Descartar alucinaciones',
    defaultValue: 'true',
    description: 'Descarta las frases típicas que Whisper inventa sobre silencio.',
  }),
  stt({
    key: 'STT_VAD_FILTER',
    type: 'boolean',
    label: 'Filtro VAD de faster-whisper',
    defaultValue: 'true',
    description: 'Silero interno de faster-whisper.',
  }),
  stt({
    key: 'STT_VAD_AGGRESSIVENESS',
    type: 'number',
    label: 'Agresividad del VAD',
    defaultValue: '2',
    min: 0,
    max: 3,
    description: '0 a 3 (webrtcvad).',
  }),
  stt({
    key: 'STT_VAD_SILENCE_MS',
    type: 'number',
    label: 'Silencio de fin de frase (ms)',
    defaultValue: '300',
    min: 0,
    max: 5000,
    description: 'Típico entre 200 y 1000.',
  }),
  stt({
    key: 'STT_SPEECH_CONFIRM_MS',
    type: 'number',
    label: 'Confirmación de voz (ms)',
    defaultValue: '300',
    min: 0,
    max: 3000,
    description: 'Voz continua antes de emitir speech_started. Múltiplo de 30 (frame del VAD).',
  }),
  // No viaja con su nombre: suma `console` al STT_SINK derivado (ver `deriveSttSink`).
  gated({
    key: 'STT_SINK_CONSOLE',
    type: 'boolean',
    group: 'Mensajería: Voicebot (STT)',
    label: 'Sumar salida por consola (diagnóstico)',
    defaultValue: 'false',
    restartsStt: true,
    description:
      'El destino de las transcripciones (STT_SINK) sale de la entrada del voicebot: amqp → ' +
      'rabbitmq, http → http. Esto le suma console para diagnóstico.',
  }),
  stt({
    key: 'STT_HTTP_URL',
    type: 'string',
    label: 'URL del POST del stt',
    defaultValue: '',
    placeholder: 'http://<voicebot>:3001/stt/transcripts',
    description: 'Solo con entrada http: adónde el stt le hace POST al voicebot.',
  }),
  stt({
    key: 'STT_HTTP_TIMEOUT',
    type: 'number',
    label: 'Timeout del POST (s)',
    defaultValue: '5',
    min: 0.1,
    max: 60,
    description: 'Solo con entrada http.',
  }),
  stt({
    key: 'STT_ENGINE',
    type: 'enum',
    label: 'Motor',
    defaultValue: 'whisper',
    allowedValues: ['whisper', 'minimax'],
    description: 'minimax es en la nube y solo para benchmark.',
  }),
  stt({
    key: 'STT_MINIMAX_API_KEY',
    type: 'string',
    label: 'API key de MiniMax (STT)',
    defaultValue: '',
    secret: true,
    description: 'Solo con el motor minimax. Se guarda cifrada.',
  }),
  stt({
    key: 'STT_MINIMAX_URL',
    type: 'string',
    label: 'URL de MiniMax (STT)',
    defaultValue: 'https://api.minimax.io/v1/speech_to_text',
    description: 'Solo con el motor minimax.',
  }),

  // --- TTS --- (key y URL compartidas con el LLM de voz; independientes del chat [DA13])
  voicebot('MINIMAX_BASE_URL', {
    key: 'VOICEBOT_MINIMAX_BASE_URL',
    type: 'string',
    group: 'Mensajería: Voicebot (TTS)',
    label: 'Base URL de MiniMax',
    defaultValue: 'https://api.minimax.io/v1',
    description: 'La usan el TTS y el LLM de voz. Es independiente de la del chat de pci.',
  }),
  voicebot('MINIMAX_API_KEY', {
    key: 'VOICEBOT_MINIMAX_API_KEY',
    type: 'string',
    group: 'Mensajería: Voicebot (TTS)',
    label: 'API key de MiniMax',
    defaultValue: '',
    secret: true,
    description:
      'La usan el TTS y el LLM de voz. Independiente de la key del chat de pci (puede tener el ' +
      'mismo valor). Se guarda cifrada.',
  }),
  voicebot('MINIMAX_TTS_MODEL', {
    key: 'VOICEBOT_MINIMAX_TTS_MODEL',
    type: 'string',
    group: 'Mensajería: Voicebot (TTS)',
    label: 'Modelo de TTS',
    defaultValue: 'speech-2.8-turbo',
    description: 'Modelo de texto a voz (speech-*).',
  }),
  voicebot('MINIMAX_TTS_VOICE_ID', {
    key: 'VOICEBOT_MINIMAX_TTS_VOICE_ID',
    type: 'string',
    group: 'Mensajería: Voicebot (TTS)',
    label: 'Voz',
    defaultValue: '',
    description: 'Id de la voz. Obligatoria con el voicebot habilitado.',
  }),
  voicebot('MINIMAX_TTS_SPEED', {
    key: 'VOICEBOT_MINIMAX_TTS_SPEED',
    type: 'number',
    group: 'Mensajería: Voicebot (TTS)',
    label: 'Velocidad',
    defaultValue: '1',
    min: 0.5,
    max: 2,
    description: '1 = normal.',
  }),
  voicebot('MINIMAX_TTS_LANGUAGE', {
    key: 'VOICEBOT_MINIMAX_TTS_LANGUAGE',
    type: 'string',
    group: 'Mensajería: Voicebot (TTS)',
    label: 'Refuerzo de idioma',
    defaultValue: '',
    placeholder: 'Spanish',
    description: 'language_boost de MiniMax. Vacío = sin refuerzo.',
  }),
  voicebot('CALL_AUDIO_SAMPLE_RATE', {
    key: 'VOICEBOT_CALL_AUDIO_SAMPLE_RATE',
    type: 'number',
    group: 'Mensajería: Voicebot (TTS)',
    label: 'Tasa de muestreo del audio (Hz)',
    defaultValue: '16000',
    min: 8000,
    max: 48000,
    description:
      'Tasa del PCM del TTS. Al cambiarla, la voz del bot sale y vuelve a entrar al room, con un ' +
      'corte breve del audio.',
  }),

  // --- LLM de voz ---
  voicebot('MINIMAX_LLM_API', {
    key: 'VOICEBOT_MINIMAX_LLM_API',
    type: 'enum',
    group: 'Mensajería: Voicebot (LLM de voz)',
    label: 'Interfaz del LLM',
    defaultValue: 'anthropic',
    allowedValues: ['anthropic', 'openai'],
    description:
      'Con MiniMax-M3, la interfaz anthropic no razona y responde rápido; por openai sí razona (2-4 s).',
  }),
  voicebot('MINIMAX_LLM_MODEL', {
    key: 'VOICEBOT_MINIMAX_LLM_MODEL',
    type: 'string',
    group: 'Mensajería: Voicebot (LLM de voz)',
    label: 'Modelo',
    defaultValue: 'MiniMax-M3',
    description: 'Modelo del LLM de voz (streaming). No es el del chat de pci.',
  }),
  voicebot('MINIMAX_LLM_MAX_TOKENS', {
    key: 'VOICEBOT_MINIMAX_LLM_MAX_TOKENS',
    type: 'number',
    group: 'Mensajería: Voicebot (LLM de voz)',
    label: 'Máximo de tokens',
    defaultValue: '150',
    min: 16,
    max: 4000,
    description: 'Tope de seguridad: el largo lo marca el prompt. Con un modelo que razona, subirlo.',
  }),
  voicebot('VOICEBOT_SYSTEM_PROMPT', {
    key: 'VOICEBOT_SYSTEM_PROMPT',
    type: 'string',
    group: 'Mensajería: Voicebot (LLM de voz)',
    label: 'Prompt de voz',
    defaultValue: '',
    multiline: true,
    description:
      'Cómo hablar (corto, sin formato). Vacío = el prompt por defecto del voicebot. El prompt de ' +
      'pci (de qué hablar) se le suma en los turnos delegados.',
  }),

  // --- Conversación ---
  ...(
    [
      ['VOICEBOT_TURN_DEBOUNCE_MS', 'Espera antes de responder (ms)', '0', 0, 10000,
        'Silencio a esperar para juntar una frase que el stt cortó en una pausa. 0 = responder enseguida.'],
      ['VOICEBOT_BARGE_IN_MIN_WORDS', 'Palabras mínimas para interrumpir', '2', 1, 20,
        'Con 2, un "ajá" o un "sí" no interrumpen al bot.'],
      ['VOICEBOT_BARGE_IN_SPEECH_MS', 'Margen propio de interrupción (ms)', '0', 0, 5000,
        'Mayor a 0 agrega un margen sobre speech_started antes de callar al bot.'],
      ['VOICEBOT_TRANSCRIPT_WAIT_MS', 'Espera de la transcripción (ms)', '3000', 0, 30000,
        'Tras speech_ended, cuánto espera la transcripción antes de retomar.'],
      ['VOICEBOT_RESUME_REWIND_MS', 'Retroceso al retomar (ms)', '1000', 0, 10000,
        'Al retomar una respuesta cortada por ruido, cuánto retrocede.'],
      ['VOICEBOT_MAX_RESUMES', 'Máximo de retomas por respuesta', '2', 0, 10, ''],
      ['VOICEBOT_SPEECH_HOLD_MAX_MS', 'Tope de "el usuario está hablando" (ms)', '15000', 1000, 120000,
        'Por si se pierde el speech_ended.'],
      ['VOICEBOT_HISTORY_TURNS', 'Turnos de historial', '10', 0, 100,
        'Turnos (pregunta + respuesta) que se le pasan al LLM de voz.'],
      ['VOICEBOT_ECHO_GUARD_MS', 'Guarda de eco (ms)', '1500', 0, 10000,
        'Solo si escucha y habla en el mismo room: tras hablar se ignoran transcripciones este tiempo.'],
      ['VOICEBOT_VOICE_IDLE_MS', 'Permanencia en el room sin hablar (ms)', '600000', 0, 3600000,
        'El bot queda conectado al room de habla entre respuestas (ahorra ~0,4 s por respuesta).'],
      ['VOICEBOT_TURN_TIMEOUT_MS', 'Timeout de respuesta de pci (ms)', '5000', 500, 60000,
        'Si pci no responde un turno en este tiempo, el voicebot dice el texto de fallback.'],
      ['VOICEBOT_FILLER_AFTER_MS', 'Relleno a los (ms)', '1500', 0, 60000,
        'Si para entonces no hay nada para decir, el voicebot dice el texto de relleno (una vez por turno).'],
    ] as const
  ).map(([key, label, defaultValue, min, max, description]) =>
    voicebot(key, {
      key,
      type: 'number',
      group: 'Mensajería: Voicebot (Conversación)',
      label,
      defaultValue,
      min,
      max,
      description,
    }),
  ),
  voicebot('VOICEBOT_BARGE_IN', {
    key: 'VOICEBOT_BARGE_IN',
    type: 'boolean',
    group: 'Mensajería: Voicebot (Conversación)',
    label: 'Permitir interrumpir al bot',
    defaultValue: 'true',
    description: 'Si el usuario habla mientras el bot piensa o habla, se corta y responde a lo nuevo.',
  }),
  voicebot('VOICEBOT_FALLBACK_TEXT', {
    key: 'VOICEBOT_FALLBACK_TEXT',
    type: 'string',
    group: 'Mensajería: Voicebot (Conversación)',
    label: 'Texto de fallback',
    defaultValue: 'Perdón, se me complicó. ¿Me lo repetís?',
    description: 'Lo dice el voicebot (literal) si pci no responde a tiempo o responde con error.',
  }),
  voicebot('VOICEBOT_FILLER_TEXT', {
    key: 'VOICEBOT_FILLER_TEXT',
    type: 'string',
    group: 'Mensajería: Voicebot (Conversación)',
    label: 'Texto de relleno',
    defaultValue: 'Un momento…',
    description: 'Vacío = sin relleno.',
  }),

  // --- Capacidad [C46] --- (caliente: aplica a las llamadas que entran después)
  voicebot('VOICEBOT_MAX_CALLS', {
    key: 'VOICEBOT_MAX_CALLS',
    type: 'number',
    group: 'Mensajería: Voicebot (Capacidad)',
    label: 'Llamadas simultáneas',
    defaultValue: '3',
    min: 1,
    integer: true,
    description:
      'Llamadas simultáneas. Tiene que ser ≤ la capacidad de los workers del stt ' +
      '(STT_WORKER_MAX_JOBS, hoy 3). La que supera el tope oye el mensaje de ocupado y se corta.',
  }),
  voicebot('VOICEBOT_BUSY_TEXT', {
    key: 'VOICEBOT_BUSY_TEXT',
    type: 'string',
    group: 'Mensajería: Voicebot (Capacidad)',
    label: 'Mensaje de ocupado',
    defaultValue: 'En este momento todas las líneas están ocupadas. Por favor, volvé a llamar en unos minutos.',
    description: 'Lo dice el voicebot (literal) a la llamada que supera el tope, antes de cortar.',
  }),

  // --- SIP entrante --- (caliente: re-provisiona trunk y rules sin cortar llamadas)
  voicebot('SIP_INBOUND_ENABLED', {
    key: 'VOICEBOT_SIP_INBOUND_ENABLED',
    type: 'boolean',
    group: 'Mensajería: Voicebot (SIP entrante)',
    label: 'Atender llamadas entrantes',
    defaultValue: 'false',
    description: 'Los números del trunk entrante salen de los internos.',
  }),
  voicebot('SIP_INBOUND_NAME', {
    key: 'VOICEBOT_SIP_INBOUND_NAME',
    type: 'string',
    group: 'Mensajería: Voicebot (SIP entrante)',
    label: 'Nombre del trunk entrante',
    defaultValue: 'voicebot-in',
    description: '',
  }),
  voicebot('SIP_INBOUND_ALLOWED_ADDRESSES', {
    key: 'VOICEBOT_SIP_INBOUND_ALLOWED_ADDRESSES',
    type: 'string',
    group: 'Mensajería: Voicebot (SIP entrante)',
    label: 'IPs de origen permitidas',
    defaultValue: '',
    placeholder: '10.0.0.5,10.0.1.0/24',
    description: 'IPs o CIDR separados por coma. Vacío = sin filtro por IP.',
  }),
  voicebot('SIP_INBOUND_USERNAME', {
    key: 'VOICEBOT_SIP_INBOUND_USERNAME',
    type: 'string',
    group: 'Mensajería: Voicebot (SIP entrante)',
    label: 'Usuario',
    defaultValue: '',
    description: 'Usuario que tiene que mandar el que llama. Vacío = sin autenticación.',
  }),
  voicebot('SIP_INBOUND_PASSWORD', {
    key: 'VOICEBOT_SIP_INBOUND_PASSWORD',
    type: 'string',
    group: 'Mensajería: Voicebot (SIP entrante)',
    label: 'Contraseña',
    defaultValue: '',
    secret: true,
    description: 'Se guarda cifrada.',
  }),
  voicebot('SIP_INBOUND_GREET_DELAY_MS', {
    key: 'VOICEBOT_SIP_INBOUND_GREET_DELAY_MS',
    type: 'number',
    group: 'Mensajería: Voicebot (SIP entrante)',
    label: 'Espera antes del saludo (ms)',
    defaultValue: '2000',
    min: 0,
    max: 10000,
    description: 'Para que no se pierda el principio mientras se arma el audio.',
  }),

  // --- SIP saliente --- (caliente: actualiza el trunk existente)
  voicebot('SIP_TRUNK_ADDRESS', {
    key: 'VOICEBOT_SIP_TRUNK_ADDRESS',
    type: 'string',
    group: 'Mensajería: Voicebot (SIP saliente)',
    label: 'Dirección del trunk',
    defaultValue: '',
    placeholder: 'sip.carrier.com:5060',
    description: 'Dato del carrier. Para probar, puede ser un softphone de la LAN.',
  }),
  voicebot('SIP_TRUNK_NUMBER', {
    key: 'VOICEBOT_SIP_TRUNK_NUMBER',
    type: 'string',
    group: 'Mensajería: Voicebot (SIP saliente)',
    label: 'Número (From)',
    defaultValue: '',
    description: 'Obligatorio para discar.',
  }),
  voicebot('SIP_TRUNK_USERNAME', {
    key: 'VOICEBOT_SIP_TRUNK_USERNAME',
    type: 'string',
    group: 'Mensajería: Voicebot (SIP saliente)',
    label: 'Usuario',
    defaultValue: '',
    description: '',
  }),
  voicebot('SIP_TRUNK_PASSWORD', {
    key: 'VOICEBOT_SIP_TRUNK_PASSWORD',
    type: 'string',
    group: 'Mensajería: Voicebot (SIP saliente)',
    label: 'Contraseña',
    defaultValue: '',
    secret: true,
    description: 'Se guarda cifrada.',
  }),
  voicebot('SIP_TRUNK_NAME', {
    key: 'VOICEBOT_SIP_TRUNK_NAME',
    type: 'string',
    group: 'Mensajería: Voicebot (SIP saliente)',
    label: 'Nombre del trunk saliente',
    defaultValue: 'voicebot-out',
    description: 'Cambiarlo borra el trunk viejo y crea uno nuevo.',
  }),
  voicebot('SIP_TRUNK_TRANSPORT', {
    key: 'VOICEBOT_SIP_TRUNK_TRANSPORT',
    type: 'enum',
    group: 'Mensajería: Voicebot (SIP saliente)',
    label: 'Transporte',
    defaultValue: 'auto',
    allowedValues: ['auto', 'udp', 'tcp', 'tls'],
    description: '',
  }),
  voicebot('SIP_RINGING_TIMEOUT', {
    key: 'VOICEBOT_SIP_RINGING_TIMEOUT',
    type: 'number',
    group: 'Mensajería: Voicebot (SIP saliente)',
    label: 'Tiempo de ring (s)',
    defaultValue: '30',
    min: 1,
    max: 300,
    description: '',
  }),

  // --- Llamadas salientes ---
  voicebot('CALL_AUDIO_URL', {
    key: 'VOICEBOT_CALL_AUDIO_URL',
    type: 'string',
    group: 'Mensajería: Voicebot (Llamadas salientes)',
    label: 'URL del audio',
    defaultValue: '',
    description: 'Audio por defecto de una saliente sin flujo (lo que entienda ffmpeg).',
  }),
  voicebot('CALL_CALLBACK_URL', {
    key: 'VOICEBOT_CALL_CALLBACK_URL',
    type: 'string',
    group: 'Mensajería: Voicebot (Llamadas salientes)',
    label: 'Webhook de resultado',
    defaultValue: '',
    description:
      'Solo para salientes que no dispara pci: las de pci informan el resultado por voice.events.',
  }),
  voicebot('CALL_MAX_ROUNDS', {
    key: 'VOICEBOT_CALL_MAX_ROUNDS',
    type: 'number',
    group: 'Mensajería: Voicebot (Llamadas salientes)',
    label: 'Vueltas a la lista de números',
    defaultValue: '3',
    min: 1,
    max: 20,
    description: '',
  }),
  voicebot('CALL_DIGITS', {
    key: 'VOICEBOT_CALL_DIGITS',
    type: 'string',
    group: 'Mensajería: Voicebot (Llamadas salientes)',
    label: 'Dígitos válidos',
    defaultValue: '1,2',
    description: 'Teclas DTMF aceptadas, separadas por coma.',
  }),
  voicebot('CALL_DIGIT_TIMEOUT_MS', {
    key: 'VOICEBOT_CALL_DIGIT_TIMEOUT_MS',
    type: 'number',
    group: 'Mensajería: Voicebot (Llamadas salientes)',
    label: 'Ventana para marcar (ms)',
    defaultValue: '30000',
    min: 1000,
    max: 300000,
    description: 'Desde que termina el audio. Si vence, el dígito viaja como null.',
  }),
];

/** `STT_SINK` del stt, derivado de la entrada del voicebot [C39]. */
export function deriveSttSink(voicebotSource: string, withConsole: boolean): string {
  const sink = voicebotSource === 'http' ? 'http' : 'rabbitmq';
  return withConsole ? `${sink},console` : sink;
}
