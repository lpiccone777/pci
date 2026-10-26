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
  'Mensajería: Voicebot (pci no disponible)',
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
  'Mensajería: Voicebot (pci no disponible)': 'pci-no-disponible',
  'Mensajería: Voicebot (SIP entrante)': 'sip-entrante',
  'Mensajería: Voicebot (SIP saliente)': 'sip-saliente',
  'Mensajería: Voicebot (Llamadas salientes)': 'llamadas-salientes',
};

const ENABLED_BY = 'VOICEBOT_ENABLED';

/** Espera de la fuente de verdad cuando el voicebot no pide avisos de progreso [C65]. */
export const DELEGATE_CONTEXT_TIMEOUT_NO_PROGRESS_MS = 7000;

/** Avisos durante esperas largas [C65]: una lista de textos por motivo. */
export const WAIT_TEXTS_MAX_LINES = 10;
export const WAIT_TEXTS_MAX_LENGTH = 200;
export const WAIT_TEXTS_SOURCE_KEY = 'VOICEBOT_WAIT_TEXTS_SOURCE';
export const WAIT_TEXT_LISTS: ReadonlyArray<{
  key: string;
  /** Motivo del `progress` (contrato §5.3); `null` = los genéricos. */
  reason: 'source' | 'ticket' | 'identify' | 'webhook' | 'delay' | null;
  label: string;
  description: string;
  defaultValue: string;
}> = [
  {
    key: 'VOICEBOT_WAIT_TEXTS',
    reason: null,
    label: 'Avisos de espera genéricos',
    description:
      'Cuando pci no dijo por qué tarda, o mientras el LLM de voz arma la respuesta. Vacío = el texto de relleno.',
    defaultValue: ['Un momento…', 'Sigo acá, ya te respondo.', 'Dame un segundo.', 'Ya casi lo tengo.'].join('\n'),
  },
  {
    key: WAIT_TEXTS_SOURCE_KEY,
    reason: 'source',
    label: 'Avisos de espera: consulta a una fuente',
    description:
      'Mientras pci consulta la fuente de verdad. {label} es el nombre para voz de la fuente: los textos con ' +
      '{label} solo se usan si la fuente lo tiene cargado.',
    defaultValue: [
      'Estoy consultando {label}, un momento.',
      'Sigo buscando en {label}.',
      'Estoy buscando la información, ya te digo.',
      'Sigo acá, estoy buscando.',
    ].join('\n'),
  },
  {
    key: 'VOICEBOT_WAIT_TEXTS_TICKET',
    reason: 'ticket',
    label: 'Avisos de espera: tickets',
    description: 'Mientras pci crea o consulta un ticket en InvGate.',
    defaultValue: ['Estoy cargando el pedido, un momento.', 'Sigo acá, estoy revisando los tickets.', 'Ya casi está.'].join('\n'),
  },
  {
    key: 'VOICEBOT_WAIT_TEXTS_IDENTIFY',
    reason: 'identify',
    label: 'Avisos de espera: identificación',
    description: 'Mientras pci busca a la persona en InvGate por su documento o legajo.',
    defaultValue: ['Estoy buscando tus datos, un momento.', 'Sigo acá, estoy verificando.', 'Ya casi te encuentro.'].join('\n'),
  },
  {
    key: 'VOICEBOT_WAIT_TEXTS_WEBHOOK',
    reason: 'webhook',
    label: 'Avisos de espera: webhook',
    description: 'Mientras pci llama a un servicio externo desde un nodo webhook.',
    defaultValue: ['Un momento, estoy procesando.', 'Sigo acá, ya termino.'].join('\n'),
  },
  {
    key: 'VOICEBOT_WAIT_TEXTS_DELAY',
    reason: 'delay',
    label: 'Avisos de espera: pausa del flujo',
    description: 'Durante un nodo de espera del flujo.',
    defaultValue: ['Un momento, por favor.', 'Sigo acá.'].join('\n'),
  },
];

/**
 * Proveedores del LLM de voz [DA10, C53]: los de pci con streaming. `opencodego` no entra:
 * trabaja por sesiones, sin streaming.
 */
export const VOICE_LLM_PROVIDERS = ['openai', 'gemini', 'claude', 'openrouter', 'minimax'] as const;
export type VoiceLlmProvider = (typeof VOICE_LLM_PROVIDERS)[number];

/**
 * De dónde salen la key y la base URL del LLM de voz según el proveedor [C53]: las que pci ya
 * tiene de ese proveedor (un solo valor por dato, como `STT_SINK` [C39]). Minimax usa las de voz
 * (`VOICEBOT_MINIMAX_*`, DA13), no las del chat. Sin `baseUrlKey` = la API oficial.
 */
export const VOICE_LLM_CREDENTIALS: Record<VoiceLlmProvider, { apiKeyKey: string; baseUrlKey?: string }> = {
  openai: { apiKeyKey: 'OPENAI_API_KEY', baseUrlKey: 'OPENAI_BASE_URL' },
  gemini: { apiKeyKey: 'GEMINI_API_KEY' },
  claude: { apiKeyKey: 'ANTHROPIC_API_KEY' },
  openrouter: { apiKeyKey: 'OPENROUTER_API_KEY', baseUrlKey: 'OPENROUTER_BASE_URL' },
  minimax: { apiKeyKey: 'VOICEBOT_MINIMAX_API_KEY', baseUrlKey: 'VOICEBOT_MINIMAX_BASE_URL' },
};

/** Textos de pci que el voicebot pre-sintetiza (`voiceLiterals`, C60/C64): cambiarlos avisa como un flujo de voz. */
export const VOICE_LITERAL_SOURCE_KEYS = new Set(['VOICEBOT_END_FALLBACK_TEXT', 'VOICEBOT_END_FALLBACK_GOODBYE_TEXT']);

/** Claves de pci de las que se deriva la config del LLM de voz: cambiarlas avisa al voicebot. */
export const VOICE_LLM_SOURCE_KEYS = new Set(
  Object.values(VOICE_LLM_CREDENTIALS).flatMap((c) => [c.apiKeyKey, ...(c.baseUrlKey ? [c.baseUrlKey] : [])]),
);

/**
 * Prompt de voz por defecto del voicebot: lo usa cuando `VOICEBOT_SYSTEM_PROMPT` está vacío.
 * Copia LITERAL de `DEFAULT_SYSTEM_PROMPT` en el repo voicebot
 * (`apps/api/src/voicebot/minimax-llm.service.ts`), solo para mostrarlo en la UI: si cambia allá,
 * hay que copiarlo de nuevo. No es el default de la clave (vacío sigue significando "el del voicebot").
 */
export const VOICEBOT_DEFAULT_VOICE_PROMPT =
  'Sos un asistente de voz que atiende una llamada telefónica. Respondé siempre en español ' +
  'rioplatense, en una o dos oraciones cortas y naturales, de no más de 35 palabras en total. ' +
  'Si la respuesta tiene varios pasos, decí solo el primero y preguntá si quiere seguir. Hacé ' +
  'como mucho una pregunta por respuesta. No uses markdown, listas, emojis, símbolos ni palabras ' +
  'en otros idiomas: tu respuesta se va a leer en voz alta. Si no entendiste lo que te dijeron, ' +
  'pedí que lo repitan. No tenés acceso a internet ni a información en tiempo real: si te piden ' +
  'datos que cambian, como resultados, fechas de partidos, quién ocupa un cargo, precios o ' +
  'noticias, decí que no tenés esa información actualizada en vez de inventarla. No ofrezcas ' +
  'buscar, consultar ni hacer cosas que no podés hacer. Hablá solo en castellano rioplatense: ' +
  'nunca uses palabras en inglés ni en otro idioma, ni siquiera sueltas; si no te sale una palabra ' +
  'en castellano, decilo de otra forma.';

/**
 * Prompt base de pci para la charla por voz [C50]: el `systemPrompt` de cada `say delegate`
 * (charla libre sin flujo y `llm_query` de los flujos de voz) parte de acá en vez de
 * `LLM_SYSTEM_PROMPT`, que es del chat (menú, "cerrar la conversación"). `{{empresa}}` = nombre
 * del tenant del interno. Lo exporta para el motor (`ConversationsService`) como fallback.
 */
export const VOICEBOT_FREE_CHAT_PROMPT_DEFAULT = [
  'Estás atendiendo por teléfono a una persona que llamó a {{empresa}}. Por ahora esta línea es solo ' +
    'para conversar: podés escuchar, orientar y responder dudas generales con lo que sabés.',
  'No podés registrar reclamos, crear ni consultar tickets, transferir la llamada ni hacer ningún ' +
    'trámite o gestión. Nunca digas que registraste, hiciste o vas a hacer algo de eso. Si la persona ' +
    'lo pide, decile con claridad que por ahora ese trámite no se puede hacer por teléfono.',
  'No hay menú ni opciones para elegir, y no ofrezcas "cerrar la conversación" ni "volver al menú": ' +
    'la llamada termina cuando la persona corta.',
  'Si no sabés algo, decilo. No inventes datos, números de ticket ni plazos.',
].join('\n');

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
      'JWT), con varias llamadas a la vez. Define también por dónde publica el stt (STT_SINK), así que ' +
      'cambiarlo reinicia el stt.',
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
  // C56: temperaturas de decodificación de faster-whisper, en orden: si la primera no da un
  // resultado confiable, reintenta con la siguiente.
  stt({
    key: 'STT_TEMPERATURES',
    type: 'string',
    label: 'Temperaturas',
    defaultValue: '0,0.2,0.4,0.6,0.8,1.0',
    placeholder: '0,0.4',
    pattern: {
      regex: /^\s*(0(\.\d+)?|1(\.0+)?)(\s*,\s*(0(\.\d+)?|1(\.0+)?))*\s*$/,
      message: 'tiene que ser una lista de números entre 0 y 1 separados por coma (ej. 0,0.4)',
    },
    description:
      'Lista separada por coma, en orden: la primera es la de siempre y las siguientes son reintentos cuando ' +
      'la transcripción no sale confiable. Menos valores = menos reintentos (más rápido).',
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
    placeholder: 'http://<voicebot>:3002/stt/transcripts',
    description:
      'Solo con entrada http: adónde el stt le hace POST al voicebot. Es la base: el stt agrega ' +
      '?room=<llamada> en cada una, así una sola URL sirve para varias llamadas a la vez (§4).',
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

  // --- LLM de voz --- [DA10, C53]: proveedor y modelo propios, credenciales del proveedor.
  // `VOICEBOT_LLM_API_KEY` no es una clave: la arma `IntegrationsConfigService` al servir la config.
  voicebot('VOICEBOT_LLM_PROVIDER', {
    key: 'VOICEBOT_LLM_PROVIDER',
    type: 'enum',
    group: 'Mensajería: Voicebot (LLM de voz)',
    label: 'Proveedor del LLM de voz',
    defaultValue: 'minimax',
    allowedValues: [...VOICE_LLM_PROVIDERS],
    description:
      'Aparte del chat. La key es la que pci ya tiene de ese proveedor (pestaña LLM); para minimax, la ' +
      'de voz (Voicebot → TTS). OpenCode Go no está: no tiene streaming.',
  }),
  voicebot('VOICEBOT_LLM_MODEL', {
    key: 'VOICEBOT_LLM_MODEL',
    type: 'string',
    group: 'Mensajería: Voicebot (LLM de voz)',
    label: 'Modelo del LLM de voz',
    defaultValue: 'MiniMax-M3',
    description: 'Del proveedor elegido arriba. No es el del chat.',
  }),
  voicebot('VOICEBOT_LLM_BASE_URL', {
    key: 'VOICEBOT_LLM_BASE_URL',
    type: 'string',
    group: 'Mensajería: Voicebot (LLM de voz)',
    label: 'Base URL del LLM de voz',
    defaultValue: '',
    description:
      'Vacío = la que pci ya tiene para ese proveedor (minimax: la de Voicebot → TTS), o la API oficial.',
  }),
  voicebot('VOICEBOT_LLM_API', {
    key: 'VOICEBOT_LLM_API',
    type: 'enum',
    group: 'Mensajería: Voicebot (LLM de voz)',
    label: 'Interfaz (solo minimax)',
    defaultValue: 'anthropic',
    allowedValues: ['anthropic', 'openai'],
    description: 'Con MiniMax-M3, la interfaz anthropic no razona y responde rápido; por openai sí razona (2-4 s).',
  }),
  voicebot('VOICEBOT_LLM_MAX_TOKENS', {
    key: 'VOICEBOT_LLM_MAX_TOKENS',
    type: 'number',
    group: 'Mensajería: Voicebot (LLM de voz)',
    label: 'Máximo de tokens del LLM de voz',
    defaultValue: '150',
    min: 16,
    max: 4000,
    integer: true,
    description: 'Tope de seguridad: el largo lo marca el prompt. Con un modelo que razona, subirlo.',
  }),
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
    fallbackText: VOICEBOT_DEFAULT_VOICE_PROMPT,
    description:
      'Cómo hablar (corto, sin formato). Un valor propio REEMPLAZA el prompt por defecto completo, no se ' +
      'le suma. Vacío = el prompt por defecto del voicebot (se muestra abajo). El prompt de pci (de qué ' +
      'hablar) se le suma en los turnos delegados.',
  }),

  // Tope del `context` de cada `delegate` [C54]: lo aplica pci al armarlo, no viaja al voicebot.
  gated({
    key: 'VOICEBOT_DELEGATE_CONTEXT_MAX_CHARS',
    type: 'number',
    group: 'Mensajería: Voicebot (LLM de voz)',
    label: 'Tope del contexto de la charla (caracteres)',
    defaultValue: '16000',
    min: 0,
    max: 32000,
    integer: true,
    description:
      'Cuánto de la fuente de verdad del flujo se le pasa al LLM de voz en la charla libre. Medido con ' +
      'MiniMax-M3: hasta 32.000 suma ~0,1 s. Lo que sobra se recorta (y se loguea).',
  }),
  gated({
    key: 'VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS',
    type: 'number',
    group: 'Mensajería: Voicebot (LLM de voz)',
    label: 'Espera de la fuente de verdad (ms)',
    defaultValue: '12000',
    min: 100,
    max: 18000,
    integer: true,
    description:
      'Si la fuente no responde en este tiempo, la charla sigue sin contexto: el turno no espera más. Con una ' +
      'fuente MCP incluye las vueltas del LLM eligiendo tools (p. ej. geocoding y después el pronóstico). ' +
      'Mientras tanto el bot va diciendo avisos de espera (C65). Con un voicebot que no pide avisos se ' +
      `limita a ${DELEGATE_CONTEXT_TIMEOUT_NO_PROGRESS_MS} ms, por debajo de su timeout de respuesta. Tiene que ` +
      'quedar por debajo del tope del timeout de respuesta con avisos.',
  }),

  // Sin `envNames`: no es config del voicebot, viaja dentro de cada `say delegate` [C50].
  gated({
    key: 'VOICEBOT_FREE_CHAT_PROMPT',
    type: 'string',
    group: 'Mensajería: Voicebot (LLM de voz)',
    label: 'Prompt de pci para la charla por voz',
    defaultValue: VOICEBOT_FREE_CHAT_PROMPT_DEFAULT,
    multiline: true,
    fallbackText: VOICEBOT_FREE_CHAT_PROMPT_DEFAULT,
    description:
      'De qué hablar por teléfono: reemplaza al prompt del chat (LLM_SYSTEM_PROMPT) en la charla libre ' +
      'y en los llm_query de los flujos de voz; el Skill y el prompt del nodo se suman. {{empresa}} = ' +
      'la empresa del interno. Un valor propio REEMPLAZA este texto completo, no se le suma. Vacío = ' +
      'el texto por defecto (se muestra abajo). El chat no cambia.',
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
      ['VOICEBOT_MAX_RESUMES', 'Máximo de retomas por respuesta', '5', 0, 10, ''],
      ['VOICEBOT_SPEECH_HOLD_MAX_MS', 'Tope de "el usuario está hablando" (ms)', '15000', 1000, 120000,
        'Por si se pierde el speech_ended.'],
      ['VOICEBOT_HISTORY_TURNS', 'Turnos de historial', '10', 0, 100,
        'Turnos (pregunta + respuesta) que se le pasan al LLM de voz.'],
      ['VOICEBOT_ECHO_GUARD_MS', 'Guarda de eco (ms)', '1500', 0, 10000,
        'Solo si escucha y habla en el mismo room: tras hablar se ignoran transcripciones este tiempo.'],
      ['VOICEBOT_VOICE_IDLE_MS', 'Permanencia en el room sin hablar (ms)', '600000', 0, 3600000,
        'El bot queda conectado al room de habla entre respuestas (ahorra ~0,4 s por respuesta).'],
      ['VOICEBOT_TURN_TIMEOUT_MS', 'Timeout de respuesta de pci (ms)', '8000', 500, 60000,
        'Si pci no responde un turno en este tiempo, el voicebot dice el texto de fallback.'],
      ['VOICEBOT_FILLER_AFTER_MS', 'Relleno a los (ms)', '1500', 0, 60000,
        'Si pci tarda más que esto en responder un turno, el bot dice el relleno. 0 = sin relleno.'],
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
  // Flujo de voz sin paso siguiente [C64]. Sin `envNames`: pci los manda dentro de la respuesta del
  // turno. Los dos textos van en `voiceLiterals` (C60): cambiarlos avisa como un flujo de voz.
  gated({
    key: 'VOICEBOT_END_FALLBACK_TEXT',
    type: 'string',
    group: 'Mensajería: Voicebot (Conversación)',
    label: 'Frase cuando el flujo se queda sin paso siguiente',
    defaultValue: '¿Algo más en lo que te pueda ayudar?',
    description:
      'La dice pci si un flujo de voz termina sin nodo Fin. Si la persona no contesta, se despide y ' +
      'corta; si dice algo, vuelve al último menú (o al flujo, sin el saludo).',
  }),
  gated({
    key: 'VOICEBOT_END_FALLBACK_GOODBYE_TEXT',
    type: 'string',
    group: 'Mensajería: Voicebot (Conversación)',
    label: 'Despedida después de esa frase',
    defaultValue: 'Gracias por comunicarte. ¡Hasta luego!',
    description: 'Con silencio o con un "no", "nada", "gracias" o "chau" después de la frase de arriba. Después corta.',
  }),
  gated({
    key: 'VOICEBOT_END_FALLBACK_NO_INPUT_MS',
    type: 'number',
    group: 'Mensajería: Voicebot (Conversación)',
    label: 'Espera de respuesta a esa frase (ms)',
    defaultValue: '8000',
    min: 3000,
    max: 30000,
    integer: true,
    description: 'Silencio desde que termina la frase hasta despedirse y cortar.',
  }),
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
    defaultValue: 'Perdón, no te entendí bien. ¿Me lo repetís?',
    description: 'Lo dice el voicebot (literal) si pci no responde a tiempo o responde con error.',
  }),
  // C58: lo dice el voicebot cuando el ruido no deja seguir la charla (en caliente).
  voicebot('VOICEBOT_NOISE_TEXT', {
    key: 'VOICEBOT_NOISE_TEXT',
    type: 'string',
    group: 'Mensajería: Voicebot (Conversación)',
    label: 'Texto de mucho ruido',
    defaultValue:
      'Hay mucho ruido en la línea y así no puedo seguir la conversación. ¿Podés ir a un lugar más silencioso?',
    description: 'Lo dice el voicebot (literal) cuando el ruido de la línea no le deja seguir la conversación.',
  }),
  // Tope del timeout estirado por los `progress` de pci [C65].
  voicebot('VOICEBOT_TURN_TIMEOUT_MAX_MS', {
    key: 'VOICEBOT_TURN_TIMEOUT_MAX_MS',
    type: 'number',
    group: 'Mensajería: Voicebot (Conversación)',
    label: 'Tope del timeout de respuesta con avisos de pci (ms)',
    defaultValue: '20000',
    min: 1000,
    max: 60000,
    integer: true,
    description:
      'Cuando pci avisa que está en un paso lento (fuente, InvGate, webhook, espera), el voicebot estira su ' +
      'timeout hasta lo que dura ese paso, pero nunca más allá de esto, contado desde que mandó el turno.',
  }),
  voicebot('VOICEBOT_FILLER_TEXT', {
    key: 'VOICEBOT_FILLER_TEXT',
    type: 'string',
    group: 'Mensajería: Voicebot (Conversación)',
    label: 'Texto de relleno',
    defaultValue: 'Un momento…',
    description: 'Vacío vuelve al texto por defecto. Para no decir relleno, poné 0 en "Relleno a los (ms)".',
  }),

  // --- Avisos durante esperas largas [C65] --- (en caliente; pregrabados por voiceLiterals)
  voicebot('VOICEBOT_WAIT_INTERVAL_MS', {
    key: 'VOICEBOT_WAIT_INTERVAL_MS',
    type: 'number',
    group: 'Mensajería: Voicebot (Conversación)',
    label: 'Avisos de espera: cada (ms)',
    defaultValue: '4500',
    min: 1000,
    max: 60000,
    integer: true,
    description:
      'El primero sale a "Relleno a los (ms)"; los siguientes, cada este tiempo desde que terminó de sonar el anterior.',
  }),
  voicebot('VOICEBOT_WAIT_MAX', {
    key: 'VOICEBOT_WAIT_MAX',
    type: 'number',
    group: 'Mensajería: Voicebot (Conversación)',
    label: 'Avisos de espera: máximo por turno',
    defaultValue: '3',
    min: 0,
    max: 10,
    integer: true,
    description: 'Cuántos avisos puede decir el bot mientras espera una misma respuesta.',
  }),
  ...WAIT_TEXT_LISTS.map(({ key, label, description, defaultValue }) =>
    voicebot(key, {
      key,
      type: 'string',
      group: 'Mensajería: Voicebot (Conversación)',
      label,
      defaultValue,
      multiline: true,
      lines: { max: WAIT_TEXTS_MAX_LINES, maxLength: WAIT_TEXTS_MAX_LENGTH, label: key === WAIT_TEXTS_SOURCE_KEY },
      description:
        `${description} Uno por línea, hasta ${WAIT_TEXTS_MAX_LINES} de ${WAIT_TEXTS_MAX_LENGTH} caracteres. Se ` +
        'eligen al azar sin repetir uno en la llamada mientras queden otros. "Proponer variantes" le pide al LLM ' +
        'textos nuevos: revisalos antes de guardar.',
    }),
  ),

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

  // --- pci no disponible [C47, DA11] --- (caliente)
  voicebot('VOICEBOT_PCI_DOWN_TEXT', {
    key: 'VOICEBOT_PCI_DOWN_TEXT',
    type: 'string',
    group: 'Mensajería: Voicebot (pci no disponible)',
    label: 'Mensaje de pci no disponible',
    defaultValue: 'En este momento no podemos atenderte. Por favor, volvé a llamar en unos minutos.',
    description:
      'Lo dice el voicebot (literal) y corta: al entrar la llamada si pci no responde el primer turno, ' +
      'o a mitad de llamada tras las fallas seguidas de abajo. No hay charla de respaldo.',
  }),
  voicebot('VOICEBOT_MAX_TURN_FAILURES', {
    key: 'VOICEBOT_MAX_TURN_FAILURES',
    type: 'number',
    group: 'Mensajería: Voicebot (pci no disponible)',
    label: 'Fallas seguidas antes de cortar',
    defaultValue: '2',
    min: 1,
    integer: true,
    description:
      'Turnos seguidos sin respuesta de pci (o con error) a mitad de llamada. Cada uno dice el texto de ' +
      'fallback; al llegar a este número dice el mensaje de arriba y corta. Un turno bueno vuelve a 0.',
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
  // Primer audio [C62]: espera a que la llamada esté atendida de verdad (`sip.callStatus=active`)
  // más el margen; `SIP_INBOUND_GREET_DELAY_MS` es solo el tope por si `active` nunca llega.
  voicebot('VOICEBOT_ANSWER_MARGIN_MS', {
    key: 'VOICEBOT_ANSWER_MARGIN_MS',
    type: 'number',
    group: 'Mensajería: Voicebot (SIP entrante)',
    label: 'Margen después de atender (ms)',
    defaultValue: '500',
    min: 0,
    max: 10000,
    integer: true,
    description:
      'Cuánto espera el bot, desde que la llamada pasa a atendida, antes del primer audio. Así el ' +
      'principio del saludo no se pierde mientras el teléfono termina de conectar.',
  }),
  voicebot('SIP_INBOUND_GREET_DELAY_MS', {
    key: 'VOICEBOT_SIP_INBOUND_GREET_DELAY_MS',
    type: 'number',
    group: 'Mensajería: Voicebot (SIP entrante)',
    label: 'Tope antes del primer audio (ms)',
    defaultValue: '8000',
    min: 0,
    max: 10000,
    description:
      'Máximo, en ms, desde que entra la llamada hasta el primer audio del bot, por si nunca llega la ' +
      'señal de atendida. Normalmente el audio sale antes: al atender, más el margen de arriba.',
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
  // Sin `envNames` [C63]: son de pci, para las salientes que dispara pci (pantalla y API).
  gated({
    key: 'VOICEBOT_OUTBOUND_ALLOWED_PREFIXES',
    type: 'string',
    group: 'Mensajería: Voicebot (Llamadas salientes)',
    label: 'Números permitidos (salientes de pci)',
    defaultValue: '',
    pattern: {
      regex: /^\s*(\+?[0-9*#]+\s*(,\s*\+?[0-9*#]+\s*)*)?$/,
      message: 'Prefijos separados por coma, solo dígitos (con + inicial opcional), * y #.',
    },
    description:
      'Prefijos a los que pci puede llamar, separados por coma (p. ej. 201,202,+54911). Un número se ' +
      'acepta si empieza con alguno. Vacío = no se puede llamar a ningún número.',
  }),
  gated({
    key: 'VOICEBOT_OUTBOUND_RETRY_DELAY_MS',
    type: 'number',
    group: 'Mensajería: Voicebot (Llamadas salientes)',
    label: 'Espera entre intentos (ms, salientes de pci)',
    defaultValue: '60000',
    min: 5000,
    max: 3600000,
    integer: true,
    description:
      'Cuánto espera pci entre un intento no atendido y el siguiente número de la lista. Con el ' +
      'voicebot ocupado (busy) también espera esto, sin contar la vuelta.',
  }),
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
