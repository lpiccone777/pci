/**
 * Catálogo de parámetros configurables desde el backoffice.
 *
 * Cada entrada declara tipo, valor por defecto y descripción. El catálogo es la
 * única fuente de verdad de qué claves son editables: `SettingsService` rechaza
 * cualquier key que no esté acá, para que nadie inyecte configuración arbitraria
 * en la tabla `Setting`.
 *
 * Los secrets (API keys de LLM e Invgate) NO van acá: van por env vars / vault,
 * nunca por BD ni por endpoint (constraint de spec §5).
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
  | 'Mensajería: Email';

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
      'System prompt base. Los nodos de flujo pueden sobrescribirlo por nodo.',
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
    label: 'Tenant que recibe los mensajes',
    defaultValue: '',
    placeholder: 'cmxxxxxxxxxxxxxxxxxxxxxxxx',
    description:
      'A qué tenant se asignan los mensajes entrantes por este número de WhatsApp. ' +
      'Limitación temporal: como los settings todavía son globales (no por tenant), un ' +
      'solo número de WhatsApp sirve a un solo tenant. Sin definir, usa el tenant más ' +
      'antiguo del sistema.',
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
  'Mensajería: Email',
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
