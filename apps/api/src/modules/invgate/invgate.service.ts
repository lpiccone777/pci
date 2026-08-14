import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const API_PREFIX = '/api/v1';
const TIMEOUT_MS = 15_000;
const MAX_ERROR_LEN = 500;

export interface InvgateCatalogEntry {
  id: number;
  name: string;
  [key: string]: unknown;
}

export interface InvgateUser {
  id: number;
  username?: string;
  email?: string;
  [key: string]: unknown;
}

export interface InvgateIncident {
  id: number;
  title?: string;
  /** La API solo devuelve el id numérico del estado, no el nombre — ver `InvgateService.getStatusName`. */
  status_id?: number;
  [key: string]: unknown;
}

export interface CreateIncidentInput {
  customerId: number;
  creatorId: number;
  categoryId: number;
  priorityId: number;
  typeId: number;
  title: string;
  description?: string;
  sourceId?: number;
}

export interface UpdateIncidentInput {
  title?: string;
  description?: string;
  categoryId?: number;
  priorityId?: number;
  typeId?: number;
}

/**
 * Cliente de la API real de InvGate Service Desk (`{INVGATE_API_URL}/api/v1`), con el
 * usuario técnico dedicado (`INVGATE_API_USER`/`INVGATE_API_KEY`) — nunca con
 * credenciales del usuario final (AGENTS.md, "Invgate: crear/leer/actualizar tickets
 * va por un usuario técnico dedicado de API").
 *
 * Credenciales **solo por env var** (`ConfigService` de Nest, no `AppConfigService`):
 * a diferencia de WhatsApp/Twilio/LLM, la constraint de spec §5 las deja afuera de
 * `/settings` y de la BD por completo — así que este service nunca las cachea vía la
 * cascada BD→env que usa el resto de la config.
 *
 * Auth confirmada contra una instancia real (2026-08-13): `GET /api/v1/...` sin
 * credenciales responde 401 con `WWW-Authenticate: Basic realm="API", Digest
 * realm="API", domain="/api/v1"` — confirma el path y el esquema Basic. Endpoints y
 * payloads (form-encoded en los writes, no JSON) relevados contra el código fuente de
 * un cliente MCP open-source de esta misma API (`tracegazer/invgate-service-desk-mcp`),
 * no contra la documentación oficial — si InvGate cambia el contrato, esto puede
 * desactualizarse.
 */
@Injectable()
export class InvgateService {
  private readonly logger = new Logger(InvgateService.name);
  /** Id de InvGate del usuario técnico (`creator_id` de los tickets que crea el bot). Resuelto una vez, en memoria. */
  private creatorIdCache: number | null | undefined;

  constructor(private readonly config: ConfigService) {}

  /** Sin las tres credenciales no hay nada que hacer — mismo criterio que WhatsAppService/TwilioWhatsAppService. */
  isConfigured(): boolean {
    return Boolean(this.baseUrl() && this.apiUser() && this.apiKey());
  }

  private baseUrl(): string | undefined {
    return this.config.get<string>('INVGATE_API_URL')?.replace(/\/+$/, '');
  }

  private apiUser(): string | undefined {
    return this.config.get<string>('INVGATE_API_USER');
  }

  private apiKey(): string | undefined {
    return this.config.get<string>('INVGATE_API_KEY');
  }

  /**
   * IDs de catálogo (categoría/prioridad/tipo/fuente) que usa el bot para los tickets
   * que crea — InvGate no acepta un ticket sin esos tres primeros, y son específicos
   * de cada instancia (no hay un valor universal "soporte genérico"). Se resuelven una
   * vez con `listCategories()`/`listPriorities()`/etc. contra la instancia real y se
   * cargan acá — no hay mapeo dinámico de la prioridad local (`Ticket.priority`,
   * string libre) a un `priority_id` de InvGate todavía (ver deuda técnica).
   */
  private defaultCategoryId(): number | undefined {
    return this.parseId('INVGATE_DEFAULT_CATEGORY_ID');
  }

  private defaultPriorityId(): number | undefined {
    return this.parseId('INVGATE_DEFAULT_PRIORITY_ID');
  }

  private defaultTypeId(): number | undefined {
    return this.parseId('INVGATE_DEFAULT_TYPE_ID');
  }

  private defaultSourceId(): number | undefined {
    return this.parseId('INVGATE_DEFAULT_SOURCE_ID');
  }

  private parseId(key: string): number | undefined {
    const raw = this.config.get<string>(key);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  /** category/priority/type son obligatorios para crear un incidente; source es opcional. */
  hasCreateDefaults(): boolean {
    return (
      this.defaultCategoryId() !== undefined &&
      this.defaultPriorityId() !== undefined &&
      this.defaultTypeId() !== undefined
    );
  }

  // --- Catálogo (IDs válidos de esta instancia) -----------------------------------

  async listPriorities(): Promise<InvgateCatalogEntry[]> {
    return this.asList(await this.get('incident.attributes.priority'));
  }

  async listStatuses(): Promise<InvgateCatalogEntry[]> {
    return this.asList(await this.get('incident.attributes.status'));
  }

  private statusNameCache: Map<number, string> | null = null;

  /**
   * `GET incident` solo devuelve `status_id` (numérico) — para mostrarle al usuario un
   * estado legible ("Abierto", "Resuelto") hace falta resolverlo contra el catálogo.
   * Los estados casi no cambian, así que se cachea en memoria por proceso; `force`
   * fuerza un refresh si el id no aparece (por si se agregó un estado nuevo después
   * del arranque).
   */
  async getStatusName(statusId: number, force = false): Promise<string> {
    if (!this.statusNameCache || force) {
      const statuses = await this.listStatuses();
      this.statusNameCache = new Map(statuses.map((s) => [s.id, s.name]));
    }
    let name = this.statusNameCache.get(statusId);
    if (name === undefined && !force) {
      name = (await this.getStatusName(statusId, true)) || undefined;
    }
    return name ?? `#${statusId}`;
  }

  async listIncidentTypes(): Promise<InvgateCatalogEntry[]> {
    return this.asList(await this.get('incident.attributes.type'));
  }

  async listCategories(search?: string): Promise<InvgateCatalogEntry[]> {
    return this.asList(await this.get('incident.attributes.category', { search }));
  }

  async listSources(): Promise<InvgateCatalogEntry[]> {
    return this.asList(await this.get('incident.attributes.source'));
  }

  // --- Usuarios --------------------------------------------------------------------

  /** Busca la persona de InvGate por teléfono — así resolvemos `customer_id` para usuarios que solo tienen WhatsApp. */
  async findUserByPhone(phone: string): Promise<InvgateUser | null> {
    return this.findFirstUser({ phones: phone });
  }

  async findUserByUsername(username: string): Promise<InvgateUser | null> {
    return this.findFirstUser({ username, exact_match: true });
  }

  async findUserByEmail(email: string): Promise<InvgateUser | null> {
    return this.findFirstUser({ email, exact_match: true });
  }

  private async findFirstUser(params: Record<string, unknown>): Promise<InvgateUser | null> {
    const result = await this.get('users.by', params);
    const data = (result as { data?: Record<string, InvgateUser> } | undefined)?.data;
    if (!data) return null;
    const first = Object.values(data)[0];
    return first ?? null;
  }

  /**
   * Id de InvGate del usuario técnico (`INVGATE_API_USER`), para usarlo como
   * `creator_id` de los tickets que crea el bot. Se resuelve una sola vez por
   * proceso — `null` en caché significa "ya se intentó y no se encontró", para no
   * reintentar la búsqueda en cada ticket si el username no matchea a nadie.
   */
  async resolveCreatorId(): Promise<number | null> {
    if (this.creatorIdCache !== undefined) return this.creatorIdCache;
    const username = this.apiUser();
    if (!username) return (this.creatorIdCache = null);
    const user = await this.findUserByUsername(username).catch((err) => {
      this.logger.warn(`No se pudo resolver el usuario técnico de InvGate ('${username}'): ${err.message}`);
      return null;
    });
    this.creatorIdCache = user?.id ?? null;
    if (this.creatorIdCache === null) {
      this.logger.warn(
        `INVGATE_API_USER ('${username}') no matcheó ningún usuario en InvGate — no se pueden crear tickets sin creator_id.`,
      );
    }
    return this.creatorIdCache;
  }

  // --- Incidentes (tickets) ---------------------------------------------------------

  async createIncident(input: CreateIncidentInput): Promise<InvgateIncident> {
    return this.post('incident', {
      creator_id: input.creatorId,
      customer_id: input.customerId,
      category_id: input.categoryId,
      priority_id: input.priorityId,
      type_id: input.typeId,
      title: input.title,
      description: input.description,
      source_id: input.sourceId,
    }) as Promise<InvgateIncident>;
  }

  /**
   * Punto de entrada de alto nivel para el bot: resuelve `creator_id` (usuario técnico)
   * y los defaults de catálogo internamente, así el llamador solo pasa lo específico del
   * ticket. Devuelve `null` (en vez de tirar) si falta cualquier prerequisito de config
   * — mismo criterio que WhatsAppService/TwilioWhatsAppService ante config incompleta:
   * loguear y seguir, nunca romper la charla por un problema de configuración de InvGate.
   */
  async createTicketForChat(customerId: number, title: string, description?: string): Promise<InvgateIncident | null> {
    if (!this.hasCreateDefaults()) {
      this.logger.warn(
        'Faltan INVGATE_DEFAULT_CATEGORY_ID/PRIORITY_ID/TYPE_ID — no se puede crear el ticket en InvGate ' +
          '(correr scripts/invgate-check.mjs para ver los IDs válidos de esta instancia).',
      );
      return null;
    }
    const creatorId = await this.resolveCreatorId();
    if (!creatorId) return null; // ya logueado en resolveCreatorId()

    return this.createIncident({
      creatorId,
      customerId,
      categoryId: this.defaultCategoryId()!,
      priorityId: this.defaultPriorityId()!,
      typeId: this.defaultTypeId()!,
      sourceId: this.defaultSourceId(),
      title,
      description,
    });
  }

  async getIncident(id: number | string, opts: { includeComments?: boolean } = {}): Promise<InvgateIncident> {
    return this.get('incident', {
      id,
      date_format: 'iso8601',
      comments: opts.includeComments || undefined,
    }) as Promise<InvgateIncident>;
  }

  async updateIncident(id: number | string, input: UpdateIncidentInput): Promise<InvgateIncident> {
    return this.put('incident', {
      id,
      title: input.title,
      description: input.description,
      category_id: input.categoryId,
      priority_id: input.priorityId,
      type_id: input.typeId,
    }) as Promise<InvgateIncident>;
  }

  /** Agrega una respuesta del usuario como comentario del ticket — visible para el cliente por default. */
  async addComment(
    requestId: number | string,
    comment: string,
    authorId: number,
    opts: { customerVisible?: boolean } = {},
  ): Promise<unknown> {
    return this.post('incident.comment', {
      request_id: requestId,
      comment,
      author_id: authorId,
      customer_visible: opts.customerVisible ?? true,
    });
  }

  // --- HTTP client -------------------------------------------------------------------

  private authHeader(): string {
    const basic = Buffer.from(`${this.apiUser()}:${this.apiKey()}`).toString('base64');
    return `Basic ${basic}`;
  }

  private async get(endpoint: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl()}${API_PREFIX}/${endpoint}`);
    for (const [key, value] of Object.entries(this.clean(params))) {
      url.searchParams.set(key, String(value));
    }
    return this.send('GET', url);
  }

  private async post(endpoint: string, data: Record<string, unknown> = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl()}${API_PREFIX}/${endpoint}`);
    return this.send('POST', url, this.formBody(data));
  }

  private async put(endpoint: string, data: Record<string, unknown> = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl()}${API_PREFIX}/${endpoint}`);
    return this.send('PUT', url, this.formBody(data));
  }

  /** InvGate espera los writes form-encoded (`application/x-www-form-urlencoded`), no JSON. */
  private formBody(data: Record<string, unknown>): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(this.clean(data))) {
      if (Array.isArray(value)) {
        for (const v of value) params.append(`${key}[]`, String(v));
      } else {
        params.set(key, String(value));
      }
    }
    return params;
  }

  /** Descarta `undefined`/`null` — InvGate no distingue "no mandado" de "string vacío". */
  private clean(values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && value !== null) out[key] = value;
    }
    return out;
  }

  private async send(method: string, url: URL, body?: URLSearchParams): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader(),
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`No se pudo contactar la API de InvGate: ${(err as Error).message}`);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Auth fallida u otro error devuelve el HTML de login, no JSON — se trata como
      // texto plano en el mensaje de error, nunca se intenta parsear como incidente real.
      parsed = undefined;
    }

    if (!res.ok) {
      const body = parsed as { error?: string; info?: string } | undefined;
      const message = body?.error || body?.info || this.sanitize(text).slice(0, MAX_ERROR_LEN);
      throw new Error(`InvGate API error ${res.status}: ${message}`);
    }

    return parsed;
  }

  /** Nunca dejar que el token termine en un mensaje de error logueado. */
  private sanitize(text: string): string {
    const token = this.apiKey();
    return token ? text.split(token).join('***REDACTED***') : text;
  }

  private asList(value: unknown): InvgateCatalogEntry[] {
    if (Array.isArray(value)) return value as InvgateCatalogEntry[];
    if (value && typeof value === 'object') {
      const data = (value as { data?: unknown }).data;
      if (Array.isArray(data)) return data as InvgateCatalogEntry[];
      if (data && typeof data === 'object') return Object.values(data) as InvgateCatalogEntry[];
    }
    return [];
  }
}
