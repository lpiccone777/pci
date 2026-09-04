/**
 * Catálogo de tipos de "fuente de verdad" (context source) y sus campos de
 * configuración.
 *
 * Mismo criterio que `settings.catalog.ts` para `Setting` y `permissions.catalog.ts`
 * para `RolePermission`: es la única fuente de verdad de qué tipos y campos son
 * válidos. `ContextSourcesService` rechaza cualquier `type` fuera de esta lista, y
 * dentro de `config` solo persiste las keys declaradas para ese tipo — el resto se
 * descarta en vez de guardarse como basura suelta.
 *
 * El frontend consume este catálogo vía `GET /context-sources/types` para dibujar
 * el formulario dinámico (dropdown de tipo + campos con su label/placeholder/select),
 * en vez de tener una copia hardcodeada como pasa hoy con `FLOW_CONTEXT_OPTIONS`.
 *
 * No instalamos MCPs, RAGs, n8n ni el consumidor del broker acá: `config` son los
 * parámetros de conexión a un servicio que ya corre en otro lado (URL + credenciales,
 * o el nombre de una cola para el tipo `broker`), nunca un proceso local.
 */

export type ContextSourceFieldType = 'string' | 'number' | 'select' | 'boolean';

export interface ContextSourceFieldOption {
  value: string;
  label: string;
}

export interface ContextSourceFieldDefinition {
  key: string;
  type: ContextSourceFieldType;
  label: string;
  required?: boolean;
  /** Ejemplo de completado, se muestra como placeholder del input. */
  placeholder?: string;
  /** Solo para type 'select'. */
  options?: ContextSourceFieldOption[];
  /** Solo para type 'select' | 'string' | 'number'. */
  defaultValue?: string;
  /**
   * Valor sensible (API key, token). Se guarda cifrado dentro de `config`
   * (AES-256-GCM, mismo mecanismo que `SecretsCipher` usa para `Setting`) y la API
   * nunca lo devuelve: el GET expone un enmascarado y el flag `isSet`, igual que
   * los settings marcados `secret: true`.
   */
  secret?: boolean;
  /** Texto de ayuda adicional para la UI. */
  helpText?: string;
}

export interface ContextSourceTypeDefinition {
  type: string;
  label: string;
  description: string;
  fields: ContextSourceFieldDefinition[];
}

export const CONTEXT_SOURCE_TYPES: ContextSourceTypeDefinition[] = [
  {
    type: 'mcp',
    label: 'MCP (Model Context Protocol)',
    description:
      'Servidor MCP remoto ya desplegado. Se conecta por HTTP/SSE — no se instala ' +
      'ni se hostea ningún servidor acá.',
    fields: [
      {
        key: 'serverUrl',
        type: 'string',
        label: 'URL del servidor MCP',
        required: true,
        placeholder: 'https://mcp.miempresa.com/sse',
      },
      {
        key: 'transport',
        type: 'select',
        label: 'Transporte',
        defaultValue: 'sse',
        options: [
          { value: 'sse', label: 'SSE (Server-Sent Events)' },
          { value: 'http', label: 'Streamable HTTP' },
        ],
      },
      {
        key: 'authType',
        type: 'select',
        label: 'Autenticación',
        defaultValue: 'none',
        options: [
          { value: 'none', label: 'Sin autenticación' },
          { value: 'apiKey', label: 'API key (header)' },
          { value: 'bearer', label: 'Bearer token' },
        ],
      },
      {
        key: 'apiKey',
        type: 'string',
        label: 'API key / token',
        secret: true,
        placeholder: 'sk-xxxxxxxxxxxxxxxxxxxx',
        helpText: 'Solo hace falta si Autenticación no es "Sin autenticación".',
      },
    ],
  },
  {
    type: 'rag',
    label: 'RAG (búsqueda semántica)',
    description:
      'Servicio de RAG externo (base de conocimiento vectorial ya indexada) que ' +
      'expone un endpoint de consulta por HTTP.',
    fields: [
      {
        key: 'endpointUrl',
        type: 'string',
        label: 'URL de consulta',
        required: true,
        placeholder: 'https://rag.miempresa.com/api/query',
      },
      {
        key: 'apiKey',
        type: 'string',
        label: 'API key',
        secret: true,
        placeholder: 'rag_live_xxxxxxxxxxxx',
      },
      {
        key: 'topK',
        type: 'number',
        label: 'Resultados a devolver (top K)',
        defaultValue: '5',
        placeholder: '5',
      },
    ],
  },
  {
    type: 'n8n',
    label: 'n8n (proceso externo)',
    description:
      'Workflow de n8n ya publicado, disparado vía su webhook. Sirve para ' +
      'cualquier proceso externo que exponga un webhook HTTP equivalente.',
    fields: [
      {
        key: 'webhookUrl',
        type: 'string',
        label: 'URL del webhook',
        required: true,
        placeholder: 'https://n8n.miempresa.com/webhook/9f2a1c3d',
      },
      {
        key: 'httpMethod',
        type: 'select',
        label: 'Método HTTP',
        defaultValue: 'POST',
        options: [
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
        ],
      },
      {
        key: 'authHeaderName',
        type: 'string',
        label: 'Header de autenticación',
        placeholder: 'Authorization',
        helpText: 'Opcional. Nombre del header que se manda con el token de abajo.',
      },
      {
        key: 'authToken',
        type: 'string',
        label: 'Token',
        secret: true,
        placeholder: 'Bearer xxxxxxxxxxxxxxxx',
      },
    ],
  },
  {
    type: 'broker',
    label: 'Broker (cola RabbitMQ)',
    description:
      'Proceso externo que ya está suscripto a una cola de nuestro propio RabbitMQ. ' +
      'No hace falta URL ni credenciales HTTP: la autenticación es la conexión a ' +
      'RabbitMQ que ya usa el resto del sistema. Cómo recibimos la respuesta depende ' +
      'de "Modo de respuesta" — ver el campo de abajo.',
    fields: [
      {
        key: 'queueName',
        type: 'string',
        label: 'Cola RabbitMQ (consulta)',
        required: true,
        placeholder: 'context.mi-proceso.query',
        helpText: 'Cola donde este sistema publica la consulta. El proceso externo debe estar suscripto a ella.',
      },
      {
        key: 'pattern',
        type: 'string',
        label: 'Pattern del mensaje',
        placeholder: 'context-source.query',
        helpText: 'Opcional. Viaja en BrokerMessage.pattern — útil si el consumidor distingue varios tipos de mensaje en la misma cola.',
      },
      {
        key: 'responseMode',
        type: 'select',
        label: 'Modo de respuesta',
        defaultValue: 'rpc',
        options: [
          { value: 'rpc', label: 'RPC dinámico (replyTo + correlationId)' },
          { value: 'fixedQueue', label: 'Cola de respuesta fija' },
        ],
        helpText:
          'RPC dinámico: el proceso externo lee "replyTo" y "correlationId" del mensaje ' +
          'que recibe y responde ahí (cola generada por nosotros en cada consulta, no hay ' +
          'que configurarla). Cola de respuesta fija: el proceso externo ya publica sus ' +
          'resultados siempre en una cola propia y conocida de antemano — cargala abajo. No ' +
          'hace falta que el externo devuelva "correlationId": si no lo trae, se lo asigna al ' +
          'request más antiguo pendiente en esa cola (por orden de llegada); si dos consultas ' +
          'concurrentes usan la misma cola sin correlationId, las respuestas se pueden mezclar.',
      },
      {
        key: 'responseQueueName',
        type: 'string',
        label: 'Cola RabbitMQ (respuesta)',
        placeholder: 'context.mi-proceso.response',
        helpText:
          'Solo si "Modo de respuesta" es "Cola de respuesta fija". Cola donde este ' +
          'sistema escucha la respuesta del proceso externo, correlacionada por ' +
          '"correlationId". Con "RPC dinámico" no hace falta completar esto.',
      },
    ],
  },
];

const BY_TYPE = new Map(CONTEXT_SOURCE_TYPES.map((t) => [t.type, t]));

export const CONTEXT_SOURCE_TYPE_VALUES: string[] = CONTEXT_SOURCE_TYPES.map((t) => t.type);

export function getContextSourceType(type: string): ContextSourceTypeDefinition | undefined {
  return BY_TYPE.get(type);
}

export function isValidContextSourceType(type: string): boolean {
  return BY_TYPE.has(type);
}

/** Los `key` de campos `secret: true` para un tipo dado. */
export function getSecretFieldKeys(type: string): string[] {
  return (BY_TYPE.get(type)?.fields ?? []).filter((f) => f.secret).map((f) => f.key);
}
