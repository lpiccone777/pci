/**
 * Catálogo de parámetros configurables desde el backoffice.
 *
 * Cada entrada declara tipo, valor por defecto y descripción. El catálogo es la
 * única fuente de verdad de qué claves son editables: `SettingsService` rechaza
 * cualquier key que no esté acá, para que nadie inyecte configuración arbitraria
 * en la tabla `Setting`.
 *
 * Los secrets marcados `secret: true` (API keys de LLM, WhatsApp/Twilio e InvGate) SÍ
 * pueden vivir acá — se guardan cifrados (`SecretsCipher`, AES-256-GCM) y son de solo
 * escritura, nunca en texto plano ni devueltos por la API. Decisión explícita del
 * usuario (LLM: 2026-08-03; InvGate: 2026-08-14, reemplaza la constraint original de
 * spec §5 de "solo env var" — administrar credenciales editando `.env` a mano era
 * engorroso). `.env` sigue funcionando como fallback de la cascada BD→env→default.
 */

export type SettingType = 'number' | 'string' | 'boolean' | 'enum';

/** Proveedores de LLM soportados por LlmProviderFactory. */
export const LLM_PROVIDERS = [
  'openai',
  'gemini',
  'claude',
  'openrouter',
  'opencodego',
  'minimax',
] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

/** Agrupación para la UI de /settings. */
export type SettingGroup =
  | 'Autenticación y 2FA'
  | 'Dispositivos'
  | 'LLM'
  | 'LLM: OpenAI'
  | 'LLM: Gemini'
  | 'LLM: Claude'
  | 'LLM: OpenRouter'
  | 'LLM: OpenCode Go'
  | 'LLM: MiniMax'
  | 'Mensajería: WhatsApp'
  | 'Mensajería: WhatsApp (Twilio)'
  | 'Mensajería: WhatsApp (Gupshup)'
  | 'Mensajería: SMS'
  | 'Mensajería: SMS (Twilio)'
  | 'Mensajería: SMS (Gupshup)'
  | 'Mensajería: Email'
  | 'Integración: InvGate'
  | 'Desarrollo y pruebas';

export interface SettingDefinition {
  key: string;
  type: SettingType;
  group: SettingGroup;
  /** Etiqueta legible para el backoffice. */
  label: string;
  /** Valor usado si no hay fila en `Setting` ni env var. */
  defaultValue: string;
  description: string;
  /** Solo para type 'enum'. */
  allowedValues?: string[];
  /** Solo para type 'number'. */
  min?: number;
  max?: number;
  /** Render como textarea en la UI. */
  multiline?: boolean;
  /**
   * Valor sensible (API key). Se guarda cifrado en BD y la API **nunca** lo devuelve:
   * el GET expone solo un enmascarado y el flag `isSet`. Es de solo escritura.
   */
  secret?: boolean;
  /** Si la clave pertenece a un proveedor de LLM, cuál. Sirve para resaltar el activo. */
  provider?: LlmProviderName;
  /** Texto de ayuda extra para la UI (ej. formato esperado de una URL). */
  placeholder?: string;
  /**
   * Default calculado en runtime, para claves cuyo valor por defecto depende del
   * entorno. Si está, le gana a `defaultValue` al resolver el valor efectivo.
   */
  resolveDefault?: () => string;
}

/**
 * Default de `OTP_ENABLED` cuando no hay valor en BD ni en env: desactivado en
 * desarrollo. Preserva el bypass que antes estaba hardcodeado en `AuthService`.
 *
 * Lo usan tanto `AppConfigService.otpEnabled()` (comportamiento real del login)
 * como el catálogo (lo que muestra la pantalla /settings), para que no puedan
 * divergir.
 */
export function defaultOtpEnabled(): string {
  return String(process.env.NODE_ENV !== 'development');
}

/**
 * Default de `CONVERSATIONS_SIMULATE_ENABLED` cuando no hay valor en BD ni en env: habilitado
 * fuera de `NODE_ENV=production` (dev y test — Jest fija `NODE_ENV=test` si no hay uno explícito,
 * así que los e2e siguen viendo el endpoint habilitado sin tocar nada). `/conversations/simulate`
 * es una herramienta de desarrollo (scripts, e2e): en producción, sin fijar nada a mano, queda
 * cerrado — mismo criterio (y mismo mecanismo) que `defaultOtpEnabled`.
 */
export function defaultSimulateEnabled(): string {
  return String(process.env.NODE_ENV !== 'production');
}

export const SETTINGS_CATALOG: SettingDefinition[] = [
  // --- Autenticación y 2FA ---
  {
    key: 'OTP_ENABLED',
    type: 'boolean',
    group: 'Autenticación y 2FA',
    label: 'Exigir 2FA por OTP',
    defaultValue: 'true',
    resolveDefault: defaultOtpEnabled,
    description:
      'Si está desactivado, el login emite el JWT sin pedir código OTP. ' +
      'Mientras no se fije un valor explícito, en NODE_ENV=development queda desactivado.',
  },
  {
    key: 'OTP_TTL_SECONDS',
    type: 'number',
    group: 'Autenticación y 2FA',
    label: 'Validez del código OTP (segundos)',
    defaultValue: '300',
    description: 'Cuánto tiempo sigue siendo válido el código enviado por email.',
    min: 60,
    max: 3600,
  },
  {
    key: 'OTP_CODE_LENGTH',
    type: 'number',
    group: 'Autenticación y 2FA',
    label: 'Longitud del código OTP',
    defaultValue: '6',
    description: 'Cantidad de dígitos del código numérico generado.',
    min: 4,
    max: 8,
  },

  // --- Dispositivos ---
  {
    key: 'DEVICE_FINGERPRINT_TTL_DAYS',
    type: 'number',
    group: 'Dispositivos',
    label: 'Vigencia del fingerprint (días)',
    defaultValue: '90',
    description:
      'Días que un dispositivo queda reconocido antes de volver a pedir 2FA.',
    min: 1,
    max: 365,
  },

  // --- LLM ---
  {
    key: 'LLM_PROVIDER',
    type: 'enum',
    group: 'LLM',
    label: 'Proveedor activo',
    defaultValue: 'openai',
    description: 'Lo lee LlmProviderFactory en cada request, sin reiniciar el backend.',
    allowedValues: ['openai', 'gemini', 'claude', 'openrouter', 'opencodego', 'minimax'],
  },
  {
    key: 'LLM_TEMPERATURE',
    type: 'number',
    group: 'LLM',
    label: 'Temperature',
    defaultValue: '0.7',
    description: 'Temperature por defecto de las completions.',
    min: 0,
    max: 2,
  },
  {
    key: 'LLM_MAX_TOKENS',
    type: 'number',
    group: 'LLM',
    label: 'Máximo de tokens',
    defaultValue: '1024',
    description: 'Tope de tokens de respuesta por completion.',
    min: 1,
    max: 32000,
  },
  {
    key: 'LLM_SYSTEM_PROMPT',
    type: 'string',
    group: 'LLM',
    label: 'System prompt por defecto',
    defaultValue: '',
    description:
      'Prompt base para toda charla. Cada flujo puede sumarle un Skill (ver Fuentes de ' +
      'verdad → Skills) que se concatena a continuación, y el nodo `llm_query` puede a su vez ' +
      'reemplazarlo o agregarle su propio texto (ver systemPromptMode en el editor de flujos).',
    multiline: true,
  },

  // --- OpenAI ---
  {
    key: 'OPENAI_API_KEY',
    type: 'string',
    group: 'LLM: OpenAI',
    label: 'API key',
    defaultValue: '',
    secret: true,
    provider: 'openai',
    placeholder: 'sk-...',
    description: 'Se guarda cifrada. Una vez cargada no se puede volver a ver, solo reemplazar.',
  },
  {
    key: 'OPENAI_MODEL',
    type: 'string',
    group: 'LLM: OpenAI',
    label: 'Modelo',
    defaultValue: 'gpt-4o-mini',
    provider: 'openai',
    placeholder: 'gpt-4o-mini',
    description: 'Identificador del modelo de OpenAI.',
  },
  {
    key: 'OPENAI_BASE_URL',
    type: 'string',
    group: 'LLM: OpenAI',
    label: 'Base URL (opcional)',
    defaultValue: '',
    provider: 'openai',
    placeholder: 'https://api.openai.com/v1',
    description: 'Solo si usás un proxy o endpoint compatible. Vacío = API oficial.',
  },

  // --- Gemini ---
  {
    key: 'GEMINI_API_KEY',
    type: 'string',
    group: 'LLM: Gemini',
    label: 'API key',
    defaultValue: '',
    secret: true,
    provider: 'gemini',
    description: 'Se guarda cifrada. Una vez cargada no se puede volver a ver, solo reemplazar.',
  },
  {
    key: 'GEMINI_MODEL',
    type: 'string',
    group: 'LLM: Gemini',
    label: 'Modelo',
    defaultValue: 'gemini-1.5-flash',
    provider: 'gemini',
    placeholder: 'gemini-1.5-flash',
    description: 'Identificador del modelo de Google Gemini.',
  },

  // --- Claude ---
  {
    key: 'ANTHROPIC_API_KEY',
    type: 'string',
    group: 'LLM: Claude',
    label: 'API key',
    defaultValue: '',
    secret: true,
    provider: 'claude',
    placeholder: 'sk-ant-...',
    description: 'Se guarda cifrada. Una vez cargada no se puede volver a ver, solo reemplazar.',
  },
  {
    key: 'ANTHROPIC_MODEL',
    type: 'string',
    group: 'LLM: Claude',
    label: 'Modelo',
    defaultValue: 'claude-3-5-sonnet-20241022',
    provider: 'claude',
    description: 'Identificador del modelo de Anthropic.',
  },

  // --- OpenRouter ---
  {
    key: 'OPENROUTER_API_KEY',
    type: 'string',
    group: 'LLM: OpenRouter',
    label: 'API key',
    defaultValue: '',
    secret: true,
    provider: 'openrouter',
    placeholder: 'sk-or-...',
    description: 'Se guarda cifrada. Una vez cargada no se puede volver a ver, solo reemplazar.',
  },
  {
    key: 'OPENROUTER_MODEL',
    type: 'string',
    group: 'LLM: OpenRouter',
    label: 'Modelo',
    defaultValue: 'openai/gpt-4o-mini',
    provider: 'openrouter',
    placeholder: 'openai/gpt-4o-mini',
    description: 'Modelo en formato OpenRouter (proveedor/modelo).',
  },
  {
    key: 'OPENROUTER_BASE_URL',
    type: 'string',
    group: 'LLM: OpenRouter',
    label: 'Base URL',
    defaultValue: 'https://openrouter.ai/api/v1',
    provider: 'openrouter',
    description: 'Endpoint de OpenRouter. Rara vez hay que cambiarlo.',
  },

  // --- OpenCode Go ---
  {
    key: 'OPENCODEGO_API_URL',
    type: 'string',
    group: 'LLM: OpenCode Go',
    label: 'Host / Base URL',
    defaultValue: '',
    provider: 'opencodego',
    placeholder: 'http://192.168.0.50:8080/v1',
    description:
      'Host del servicio OpenCode Go, con esquema y puerto. Se le agrega /chat/completions.',
  },
  {
    key: 'OPENCODEGO_API_KEY',
    type: 'string',
    group: 'LLM: OpenCode Go',
    label: 'API key (opcional)',
    defaultValue: '',
    secret: true,
    provider: 'opencodego',
    description:
      'Solo si tu servidor de opencode exige autenticación. Un `opencode serve` local ' +
      'normalmente no la necesita. Se guarda cifrada.',
  },
  {
    key: 'OPENCODEGO_MODEL',
    type: 'string',
    group: 'LLM: OpenCode Go',
    label: 'Modelo',
    defaultValue: '',
    provider: 'opencodego',
    placeholder: 'opencode-go/kimi-k2.6',
    description:
      'Formato `providerID/modelID`: opencode direcciona los modelos por ese par. ' +
      'Usá el desplegable, que los lee del propio servidor.',
  },
  {
    key: 'OPENCODEGO_AGENT',
    type: 'string',
    group: 'LLM: OpenCode Go',
    label: 'Agent de opencode',
    defaultValue: 'plan',
    provider: 'opencodego',
    placeholder: 'plan',
    description:
      'Cada agent trae su propio prompt y su propio set de herramientas. El default de ' +
      'opencode es `build`, que EJECUTA herramientas sobre la máquina donde corre el ' +
      'servidor: peligroso para un bot que atiende usuarios finales. Por eso acá el ' +
      'default es `plan`, que no permite edición. Ver GET /agent en tu servidor.',
  },

  // --- MiniMax ---
  {
    key: 'MINIMAX_API_KEY',
    type: 'string',
    group: 'LLM: MiniMax',
    label: 'API key',
    defaultValue: '',
    secret: true,
    provider: 'minimax',
    description:
      'Se guarda cifrada. Misma key para el chat (OpenAI-compatible, /v1/chat/completions) y ' +
      'para T2A (texto a voz) cuando se implemente esa parte — MiniMax usa un único Bearer ' +
      'token para ambas APIs.',
  },
  {
    key: 'MINIMAX_MODEL',
    type: 'string',
    group: 'LLM: MiniMax',
    label: 'Modelo',
    defaultValue: 'MiniMax-M2.5',
    provider: 'minimax',
    placeholder: 'MiniMax-M2.5',
    description:
      'Identificador del modelo de chat de MiniMax (ej. MiniMax-M3, MiniMax-M2.5). No es el ' +
      'modelo de voz (T2A) — ese es un namespace de modelos distinto (speech-*).',
  },
  {
    key: 'MINIMAX_BASE_URL',
    type: 'string',
    group: 'LLM: MiniMax',
    label: 'Base URL (opcional)',
    defaultValue: '',
    provider: 'minimax',
    placeholder: 'https://api.minimax.io/v1',
    description: 'Vacío = endpoint global oficial. Cambiar solo para un proxy o la región de China.',
  },

  // --- Mensajería: WhatsApp ---
  {
    key: 'WHATSAPP_PROVIDER',
    type: 'enum',
    group: 'Mensajería: WhatsApp',
    label: 'Proveedor activo',
    defaultValue: 'meta',
    description:
      'Qué conector se suscribe a la cola de envío saliente: "meta" (Cloud API de Meta, ' +
      'grupo de abajo), "twilio" (grupo "Mensajería: WhatsApp (Twilio)") o "gupshup" (grupo ' +
      '"Mensajería: WhatsApp (Gupshup)"). Solo uno puede estar activo a la vez — se lee una ' +
      'sola vez al arrancar el backend, así que un cambio acá requiere reiniciarlo para tomar ' +
      'efecto (a diferencia de LLM_PROVIDER, que se relee en cada request).',
    allowedValues: ['meta', 'twilio', 'gupshup'],
  },
  {
    key: 'WHATSAPP_API_TOKEN',
    type: 'string',
    group: 'Mensajería: WhatsApp',
    label: 'Access Token',
    defaultValue: '',
    secret: true,
    placeholder: 'EAAO...',
    description:
      'Token de acceso de la API de WhatsApp Business (Meta for Developers > WhatsApp > ' +
      'API Setup). Se guarda cifrado.',
  },
  {
    key: 'WHATSAPP_PHONE_NUMBER_ID',
    type: 'string',
    group: 'Mensajería: WhatsApp',
    label: 'Phone Number ID',
    defaultValue: '',
    placeholder: '1162819126925337',
    description: 'ID numérico del número de WhatsApp Business emisor (no el número en sí).',
  },
  {
    key: 'WHATSAPP_API_VERSION',
    type: 'string',
    group: 'Mensajería: WhatsApp',
    label: 'Versión de la Graph API',
    defaultValue: 'v26.0',
    placeholder: 'v26.0',
    description:
      'Versión de la Graph API de Meta usada para el endpoint /messages. Actualizar cuando ' +
      'Meta deprecia versiones viejas.',
  },
  {
    key: 'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
    type: 'string',
    group: 'Mensajería: WhatsApp',
    label: 'Verify Token del webhook',
    defaultValue: '',
    secret: true,
    description:
      'Token propio (lo elegís vos, cualquier string) que Meta reenvía al verificar la ' +
      'suscripción del webhook (GET /webhooks/whatsapp). Tiene que coincidir con el que ' +
      'configures en Meta for Developers > WhatsApp > Configuration.',
  },
  {
    key: 'WHATSAPP_TENANT_ID',
    type: 'string',
    group: 'Mensajería: WhatsApp',
    label: 'Tenant de los teléfonos sin empresa',
    defaultValue: '',
    placeholder: 'cmxxxxxxxxxxxxxxxxxxxxxxxx',
    description:
      'A qué tenant se rutean los mensajes entrantes de un teléfono que NO pertenece a ' +
      'ninguna empresa (sin membresía). Los teléfonos registrados se rutean siempre por su ' +
      'membresía (ver InboundTenantRoutingService); esto solo decide qué bot atiende a un ' +
      'desconocido: el del tenant configurado acá (su flujo de inicio/default). Sin definir, ' +
      'cae al tenant de sistema. Limitación: los settings son globales, un solo número por tenant.',
  },
  // --- Mensajería: WhatsApp (Twilio) ---
  {
    key: 'TWILIO_ACCOUNT_SID',
    type: 'string',
    group: 'Mensajería: WhatsApp (Twilio)',
    label: 'Account SID',
    defaultValue: '',
    placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    description: 'SID de la cuenta de Twilio (Console > Account Info). No es secreto, pero es solo escritura por consistencia con el resto de las credenciales.',
  },
  {
    key: 'TWILIO_AUTH_TOKEN',
    type: 'string',
    group: 'Mensajería: WhatsApp (Twilio)',
    label: 'Auth Token',
    defaultValue: '',
    secret: true,
    placeholder: '32 caracteres',
    description: 'Auth Token de la cuenta de Twilio (Console > Account Info). Se guarda cifrado.',
  },
  {
    key: 'TWILIO_WHATSAPP_FROM',
    type: 'string',
    group: 'Mensajería: WhatsApp (Twilio)',
    label: 'Número emisor de WhatsApp',
    defaultValue: '',
    placeholder: '+14155238886',
    description:
      'Número habilitado para WhatsApp en Twilio, en formato E.164 con "+" (el sandbox de ' +
      'pruebas usa +14155238886). El prefijo "whatsapp:" que exige la API de Twilio se agrega ' +
      'automáticamente, no incluirlo acá.',
  },
  {
    key: 'TWILIO_TENANT_ID',
    type: 'string',
    group: 'Mensajería: WhatsApp (Twilio)',
    label: 'Tenant de los teléfonos sin empresa',
    defaultValue: '',
    placeholder: 'cmxxxxxxxxxxxxxxxxxxxxxxxx',
    description:
      'A qué tenant se rutean los mensajes entrantes de un teléfono sin ninguna empresa ' +
      '(sin membresía) cuando el proveedor activo es Twilio. Mismo criterio que ' +
      'WHATSAPP_TENANT_ID. Sin definir, cae al tenant de sistema.',
  },
  // --- Mensajería: WhatsApp (Gupshup) ---
  // API moderna de Gupshup (api.gupshup.io/wa/api/v1/msg), auth por header `apikey` — NO
  // confundir con la API legacy "Enterprise SMS" (grupo "Mensajería: SMS (Gupshup)", más
  // abajo), que es un producto y una cuenta totalmente distintos (userid/password propios).
  {
    key: 'GUPSHUP_API_KEY',
    type: 'string',
    group: 'Mensajería: WhatsApp (Gupshup)',
    label: 'API Key',
    defaultValue: '',
    secret: true,
    placeholder: '092707e8296649xxxx94c0fxxx818ad',
    description: 'API key de la app de WhatsApp en Gupshup (pestaña "Cuenta" del panel). Se guarda cifrada.',
  },
  {
    key: 'GUPSHUP_WHATSAPP_SOURCE',
    type: 'string',
    group: 'Mensajería: WhatsApp (Gupshup)',
    label: 'Número emisor (source)',
    defaultValue: '',
    placeholder: '15553788248',
    description:
      'Número de WhatsApp Business registrado en Gupshup ("ID del número de teléfono" en la ' +
      'pestaña "Cuenta"), sin "+" ni separadores.',
  },
  {
    key: 'GUPSHUP_APP_NAME',
    type: 'string',
    group: 'Mensajería: WhatsApp (Gupshup)',
    label: 'Nombre de la app (src.name)',
    defaultValue: '',
    placeholder: 'dasyBot',
    description: 'Nombre de la app registrada en Gupshup contra ese número (breadcrumb del panel, ej. "dasyBot").',
  },
  {
    key: 'GUPSHUP_WHATSAPP_TENANT_ID',
    type: 'string',
    group: 'Mensajería: WhatsApp (Gupshup)',
    label: 'Tenant de los teléfonos sin empresa',
    defaultValue: '',
    placeholder: 'cmxxxxxxxxxxxxxxxxxxxxxxxx',
    description:
      'A qué tenant se rutean los mensajes entrantes de un teléfono sin ninguna empresa ' +
      '(sin membresía) cuando el proveedor activo es Gupshup. Mismo criterio que ' +
      'WHATSAPP_TENANT_ID. Sin definir, cae al tenant de sistema.',
  },
  // --- Mensajería: SMS ---
  {
    key: 'SMS_PROVIDER',
    type: 'enum',
    group: 'Mensajería: SMS',
    label: 'Proveedor activo',
    defaultValue: 'twilio',
    description:
      'Qué conector se suscribe a la cola de envío saliente de SMS: "twilio" (grupo ' +
      '"Mensajería: SMS (Twilio)") o "gupshup" (grupo "Mensajería: SMS (Gupshup)" — API ' +
      'legacy "Enterprise SMS", cuenta separada de la de WhatsApp). Solo uno puede estar ' +
      'activo a la vez — se lee una sola vez al arrancar el backend, igual que WHATSAPP_PROVIDER.',
    allowedValues: ['twilio', 'gupshup'],
  },

  // --- Mensajería: SMS (Twilio) ---
  // Reusa TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN del grupo de WhatsApp (Twilio) — es la misma
  // cuenta de Twilio, solo cambia el número emisor. SMS no es un reemplazo de WhatsApp
  // (a diferencia de Twilio vs Meta): es un canal aparte, con sus propias conversaciones.
  {
    key: 'TWILIO_SMS_FROM',
    type: 'string',
    group: 'Mensajería: SMS (Twilio)',
    label: 'Número emisor de SMS',
    defaultValue: '',
    placeholder: '+15551234567',
    description:
      'Número de Twilio habilitado para SMS, en formato E.164 con "+". A diferencia del ' +
      'número de WhatsApp, va SIN el prefijo "whatsapp:" (Twilio lo distingue por el canal, ' +
      'no por el número) — tiene que ser un número propio comprado en Twilio, el sandbox de ' +
      'WhatsApp no sirve para esto.',
  },
  {
    key: 'TWILIO_SMS_TENANT_ID',
    type: 'string',
    group: 'Mensajería: SMS (Twilio)',
    label: 'Tenant de los teléfonos sin empresa',
    defaultValue: '',
    placeholder: 'cmxxxxxxxxxxxxxxxxxxxxxxxx',
    description:
      'A qué tenant se rutean los SMS entrantes de un teléfono sin ninguna empresa (sin ' +
      'membresía) cuando el proveedor activo de SMS es Twilio. Mismo criterio que ' +
      'WHATSAPP_TENANT_ID. Sin definir, cae al tenant de sistema.',
  },
  // --- Mensajería: SMS (Gupshup) ---
  // API LEGACY "Enterprise SMS" (enterprise.smsgupshup.com) — cuenta y producto totalmente
  // distintos de la API de WhatsApp de Gupshup (grupo de arriba): auth por userid/password
  // propios, no el API Key de WhatsApp. Bloqueado hasta tener esa cuenta — parametrizado para
  // cuando esté disponible, mismo criterio que TWILIO_SMS_FROM cuando faltaba el número.
  {
    key: 'GUPSHUP_SMS_USERID',
    type: 'string',
    group: 'Mensajería: SMS (Gupshup)',
    label: 'User ID (Enterprise SMS)',
    defaultValue: '',
    placeholder: '2000xxxxxx',
    description:
      'Usuario de la cuenta de Enterprise SMS de Gupshup (enterprise.smsgupshup.com) — NO es ' +
      'el mismo login que la app de WhatsApp de Gupshup.',
  },
  {
    key: 'GUPSHUP_SMS_PASSWORD',
    type: 'string',
    group: 'Mensajería: SMS (Gupshup)',
    label: 'Password (Enterprise SMS)',
    defaultValue: '',
    secret: true,
    placeholder: '••••••••',
    description: 'Contraseña de la cuenta de Enterprise SMS de Gupshup. Se guarda cifrada.',
  },
  {
    key: 'GUPSHUP_SMS_TENANT_ID',
    type: 'string',
    group: 'Mensajería: SMS (Gupshup)',
    label: 'Tenant de los teléfonos sin empresa',
    defaultValue: '',
    placeholder: 'cmxxxxxxxxxxxxxxxxxxxxxxxx',
    description:
      'A qué tenant se rutean los SMS entrantes de un teléfono sin ninguna empresa (sin ' +
      'membresía) cuando el proveedor activo de SMS es Gupshup. Mismo criterio que ' +
      'WHATSAPP_TENANT_ID. Sin definir, cae al tenant de sistema.',
  },
  // --- Mensajería: Email ---
  {
    key: 'EMAIL_SMTP_HOST',
    type: 'string',
    group: 'Mensajería: Email',
    label: 'Host SMTP',
    defaultValue: '',
    placeholder: 'smtp.sendgrid.net',
    description: 'Sin configurar, los emails (ej. códigos OTP) quedan solo logueados en consola.',
  },
  {
    key: 'EMAIL_SMTP_PORT',
    type: 'number',
    group: 'Mensajería: Email',
    label: 'Puerto SMTP',
    defaultValue: '587',
    min: 1,
    max: 65535,
    description: '587 (STARTTLS) o 465 (TLS implícito, requiere "Conexión segura" activada).',
  },
  {
    key: 'EMAIL_SMTP_SECURE',
    type: 'boolean',
    group: 'Mensajería: Email',
    label: 'Conexión segura (TLS implícito)',
    defaultValue: 'false',
    description: 'Activar solo si el puerto es 465. Con 587/STARTTLS dejar desactivado.',
  },
  {
    key: 'EMAIL_SMTP_USER',
    type: 'string',
    group: 'Mensajería: Email',
    label: 'Usuario SMTP',
    defaultValue: '',
    description: 'Suele ser el email de la cuenta o un API user (ej. "apikey" en SendGrid).',
  },
  {
    key: 'EMAIL_SMTP_PASS',
    type: 'string',
    group: 'Mensajería: Email',
    label: 'Contraseña / API key SMTP',
    defaultValue: '',
    secret: true,
    description: 'Se guarda cifrada.',
  },
  {
    key: 'EMAIL_FROM',
    type: 'string',
    group: 'Mensajería: Email',
    label: 'Remitente',
    defaultValue: '',
    placeholder: '"Plataforma Conversacional Inteligente Soporte" <soporte@tuempresa.com>',
    description: 'Se usa como remitente en los emails salientes (ej. el código OTP).',
  },

  // --- Integración: InvGate ---
  // Antes solo por env var (constraint original de spec §5) — movido a /settings a
  // pedido explícito del usuario (2026-08-14): editar `.env` a mano para administrar
  // el vínculo con InvGate era engorroso. Mismo patrón cifrado/solo-escritura que el
  // resto de las credenciales de proveedor.
  {
    key: 'INVGATE_API_URL',
    type: 'string',
    group: 'Integración: InvGate',
    label: 'URL base de la instancia',
    defaultValue: '',
    placeholder: 'https://tuempresa.sd.cloud.invgate.net',
    description: 'Sin el sufijo /api/v1 — se agrega solo. Es la URL de tu instancia de InvGate Service Desk.',
  },
  {
    key: 'INVGATE_API_USER',
    type: 'string',
    group: 'Integración: InvGate',
    label: 'Usuario técnico de API',
    defaultValue: '',
    placeholder: 'chatbot_test',
    description:
      'Usuario técnico dedicado para la API (AGENTS.md: nunca con credenciales del usuario final). ' +
      'No es secreto, pero es solo escritura por consistencia con el resto de las credenciales.',
  },
  {
    key: 'INVGATE_API_KEY',
    type: 'string',
    group: 'Integración: InvGate',
    label: 'Token de API',
    defaultValue: '',
    secret: true,
    placeholder: 'Token del usuario técnico, no su contraseña de portal',
    description:
      'Token de API del usuario técnico (Settings > Integraciones > API en InvGate, o pedírselo al ' +
      'admin). Ojo: no es la contraseña de login al portal, son cosas distintas — cargar la ' +
      'contraseña por error da 401. Se guarda cifrado.',
  },
  {
    key: 'INVGATE_DEFAULT_CATEGORY_ID',
    type: 'number',
    group: 'Integración: InvGate',
    label: 'Categoría por defecto',
    defaultValue: '',
    placeholder: '1653',
    description:
      'Id de categoría a usar cuando la charla no recolectó una (flowState.category, sin match, o ' +
      'sin setear) — obligatoria para InvGate, no hay un default universal. Correr ' +
      '`node scripts/invgate-check.mjs` para ver las categorías reales de esta instancia.',
  },
  {
    key: 'INVGATE_DEFAULT_PRIORITY_ID',
    type: 'number',
    group: 'Integración: InvGate',
    label: 'Prioridad por defecto',
    defaultValue: '',
    placeholder: '2',
    description: 'Id de prioridad por defecto (fallback de flowState.priority). Ej. 2 = Media, según el catálogo de esta instancia.',
  },
  {
    key: 'INVGATE_DEFAULT_TYPE_ID',
    type: 'number',
    group: 'Integración: InvGate',
    label: 'Tipo por defecto',
    defaultValue: '',
    placeholder: '1',
    description: 'Id de tipo de incidente por defecto (fallback de flowState.ticketType). Ej. 1 = Incidente, según el catálogo de esta instancia.',
  },
  {
    key: 'INVGATE_DEFAULT_SOURCE_ID',
    type: 'number',
    group: 'Integración: InvGate',
    label: 'Fuente por defecto (opcional)',
    defaultValue: '',
    placeholder: '8',
    description: 'Id de fuente del ticket — opcional, InvGate lo acepta sin definir. Ej. 8 = API.',
  },
  {
    key: 'INVGATE_CATEGORY_PARENT_ID',
    type: 'number',
    group: 'Integración: InvGate',
    label: 'Categoría padre para el selector de tickets',
    defaultValue: '',
    placeholder: '1601',
    description:
      'Id de la categoría cuyas SUBCATEGORÍAS aparecen como opciones al armar un ticket en el ' +
      'editor de flujos (nodo "Generar ticket"). Acota el selector a una rama puntual del árbol ' +
      'en vez de mostrar el catálogo entero de la organización (puede tener cientos de ' +
      'categorías que no aplican a tickets del chatbot). Ej.: 1601 = "Chatbot", bajo ' +
      '"DEPTO. SISTEMAS > Soporte".',
  },
  // --- Desarrollo y pruebas ---
  {
    key: 'CONVERSATIONS_SIMULATE_ENABLED',
    type: 'boolean',
    group: 'Desarrollo y pruebas',
    label: 'Habilitar POST /conversations/simulate',
    defaultValue: 'true',
    resolveDefault: defaultSimulateEnabled,
    description:
      'Endpoint de desarrollo para probar flujos sin un canal real (scripts, e2e) — exige login ' +
      '(JwtAuthGuard) pero cualquier usuario autenticado puede simular cualquier tenant/teléfono. ' +
      'Mientras no se fije un valor explícito, en NODE_ENV=production queda desactivado (404).',
  },
];

/** Orden en que se muestran los grupos en la UI. */
export const SETTINGS_GROUP_ORDER: SettingGroup[] = [
  'Autenticación y 2FA',
  'Dispositivos',
  'LLM',
  'LLM: OpenAI',
  'LLM: Gemini',
  'LLM: Claude',
  'LLM: OpenRouter',
  'LLM: OpenCode Go',
  'LLM: MiniMax',
  'Mensajería: WhatsApp',
  'Mensajería: WhatsApp (Twilio)',
  'Mensajería: WhatsApp (Gupshup)',
  'Mensajería: SMS',
  'Mensajería: SMS (Twilio)',
  'Mensajería: SMS (Gupshup)',
  'Mensajería: Email',
  'Integración: InvGate',
  'Desarrollo y pruebas',
];

const BY_KEY = new Map(SETTINGS_CATALOG.map((d) => [d.key, d]));

export function findSettingDefinition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

/**
 * Valida un valor contra su definición.
 * Devuelve null si es válido, o el mensaje de error si no lo es.
 */
export function validateSettingValue(
  def: SettingDefinition,
  value: string,
): string | null {
  switch (def.type) {
    case 'number': {
      const parsed = Number(value);
      if (value.trim() === '' || Number.isNaN(parsed)) {
        return `${def.key} debe ser numérico`;
      }
      if (def.min !== undefined && parsed < def.min) {
        return `${def.key} debe ser >= ${def.min}`;
      }
      if (def.max !== undefined && parsed > def.max) {
        return `${def.key} debe ser <= ${def.max}`;
      }
      return null;
    }
    case 'boolean': {
      return ['true', 'false'].includes(value.toLowerCase())
        ? null
        : `${def.key} debe ser 'true' o 'false'`;
    }
    case 'enum': {
      return def.allowedValues?.includes(value.toLowerCase())
        ? null
        : `${def.key} debe ser uno de: ${def.allowedValues?.join(', ')}`;
    }
    case 'string':
    default:
      return null;
  }
}
