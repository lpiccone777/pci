import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';

const API_PREFIX = '/api/v1';
const TIMEOUT_MS = 15_000;
/** Adjuntar una imagen tarda más que un POST de JSON/form chico — mismo endpoint, timeout aparte. */
const UPLOAD_TIMEOUT_MS = 30_000;
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

/** Imagen ya descargada y guardada temporalmente (ver `TwilioMediaService`), lista para adjuntar. */
export interface IncidentAttachment {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface UpdateIncidentInput {
  title?: string;
  description?: string;
  categoryId?: number;
  priorityId?: number;
  typeId?: number;
}

/** Nombres (no IDs) recolectados durante la charla, a resolver contra el catálogo real. */
export interface TicketFieldNames {
  categoryName?: string;
  priorityName?: string;
  typeName?: string;
}

/**
 * Cliente de la API real de InvGate Service Desk (`{INVGATE_API_URL}/api/v1`), con el
 * usuario técnico dedicado (`INVGATE_API_USER`/`INVGATE_API_KEY`) — nunca con
 * credenciales del usuario final (AGENTS.md, "Invgate: crear/leer/actualizar tickets
 * va por un usuario técnico dedicado de API").
 *
 * Config vía `AppConfigService` (cascada BD → env → default), igual que WhatsApp/Twilio/
 * LLM — decisión explícita del usuario (2026-08-14) que reemplaza la anterior ("solo env
 * var"): administrar credenciales editando `.env` a mano era engorroso. `/settings >
 * Integración: InvGate` es ahora la forma normal de cargarlas; `.env` sigue funcionando
 * como fallback (útil para un bootstrap inicial sin tocar la BD).
 *
 * Auth confirmada contra una instancia real (2026-08-13/14): `GET /api/v1/...` sin
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
  private statusNameCache: Map<number, string> | null = null;
  private priorityCache: InvgateCatalogEntry[] | null = null;
  private typeCache: InvgateCatalogEntry[] | null = null;

  constructor(private readonly appConfig: AppConfigService) {}

  /** Sin las tres credenciales no hay nada que hacer — mismo criterio que WhatsAppService/TwilioWhatsAppService. */
  async isConfigured(): Promise<boolean> {
    const [url, user, key] = await Promise.all([this.baseUrl(), this.apiUser(), this.apiKey()]);
    return Boolean(url && user && key);
  }

  private async baseUrl(): Promise<string | undefined> {
    const raw = await this.appConfig.get('INVGATE_API_URL');
    return raw?.replace(/\/+$/, '');
  }

  private async apiUser(): Promise<string | undefined> {
    return this.appConfig.get('INVGATE_API_USER');
  }

  private async apiKey(): Promise<string | undefined> {
    return this.appConfig.get('INVGATE_API_KEY');
  }

  /**
   * IDs de catálogo por defecto (categoría/prioridad/tipo/fuente), usados cuando la
   * charla no recolectó un valor propio — ver `resolveCategoryId`/`resolvePriorityId`/
   * `resolveTypeId`, que intentan matchear por NOMBRE contra `flowState` antes de caer
   * acá. Son específicos de cada instancia (no hay un valor universal "soporte
   * genérico"): se resuelven con `listCategories()`/`listPriorities()`/etc. contra la
   * instancia real.
   */
  private async defaultCategoryId(): Promise<number | undefined> {
    return this.parseId('INVGATE_DEFAULT_CATEGORY_ID');
  }

  private async defaultPriorityId(): Promise<number | undefined> {
    return this.parseId('INVGATE_DEFAULT_PRIORITY_ID');
  }

  private async defaultTypeId(): Promise<number | undefined> {
    return this.parseId('INVGATE_DEFAULT_TYPE_ID');
  }

  private async defaultSourceId(): Promise<number | undefined> {
    return this.parseId('INVGATE_DEFAULT_SOURCE_ID');
  }

  private async parseId(key: string): Promise<number | undefined> {
    const raw = await this.appConfig.get(key);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  // --- Catálogo (IDs válidos de esta instancia) -----------------------------------

  async listPriorities(): Promise<InvgateCatalogEntry[]> {
    return this.asList(await this.get('incident.attributes.priority'));
  }

  async listStatuses(): Promise<InvgateCatalogEntry[]> {
    return this.asList(await this.get('incident.attributes.status'));
  }

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

  private categoryChildrenCache = new Map<number, InvgateCatalogEntry[]>();

  /**
   * Subcategorías directas de `parentId` — para acotar el selector de categoría del
   * editor de flujos a una rama puntual del árbol en vez de mostrar el catálogo entero
   * (pedido explícito del usuario 2026-08-14: la instancia real tiene ~700+ categorías
   * organizacionales, la enorme mayoría no aplica a tickets que crea el chatbot).
   *
   * La API no tiene un filtro `parent_id` en `incident.attributes.category` — solo
   * `search` (texto) e `id` (exacto) — así que hay que traer todo paginado y filtrar acá.
   * Se cachea por `parentId`: las categorías organizacionales cambian rara vez, no vale
   * la pena repaginar todo el catálogo en cada request del editor.
   */
  async listCategoriesByParent(parentId: number): Promise<InvgateCatalogEntry[]> {
    const cached = this.categoryChildrenCache.get(parentId);
    if (cached) return cached;

    const all = await this.listAllCategories();
    const children = all.filter((c) => Number(c.parent_category_id) === parentId);
    this.categoryChildrenCache.set(parentId, children);
    return children;
  }

  /** Lee `INVGATE_CATEGORY_PARENT_ID` y devuelve sus hijas — `[]` si no está configurado. */
  async listTicketCategories(): Promise<InvgateCatalogEntry[]> {
    const parentId = await this.parseId('INVGATE_CATEGORY_PARENT_ID');
    if (parentId === undefined) return [];
    return this.listCategoriesByParent(parentId);
  }

  /** Pagina `incident.attributes.category` hasta agotarla — sin filtro de búsqueda, trae todo. */
  private async listAllCategories(): Promise<InvgateCatalogEntry[]> {
    const pageSize = 200;
    const maxPages = 20; // tope de seguridad: 4000 categorías, muy por arriba de lo real
    const all: InvgateCatalogEntry[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = this.asList(await this.get('incident.attributes.category', { page, page_size: pageSize }));
      if (!batch.length) break;
      all.push(...batch);
      if (batch.length < pageSize) break;
    }
    return all;
  }

  // --- Resolución de campos del ticket por NOMBRE (dato recolectado en la charla) ---
  //
  // El flujo IVR no conoce (ni debería conocer) los IDs numéricos de InvGate — son de
  // esta instancia puntual, no algo que un diseñador de flujos deba memorizar. En vez
  // de eso, un nodo `input`/`menu` puede guardar en `flowState.category`,
  // `flowState.priority` o `flowState.ticketType` el NOMBRE tal cual aparece en InvGate
  // (ej. "Alta", "Incidente", "01 - ALGO NO ME FUNCIONA"), y acá se resuelve contra el
  // catálogo real en el momento de crear el ticket. Sin match (o sin que la charla haya
  // seteado nada), cae al default configurado — nunca rompe la creación del ticket por
  // esto solo.

  async resolveCategoryId(name?: string): Promise<number | undefined> {
    if (name) {
      // `search` es server-side: evita traer solo la primera página de un catálogo que
      // puede tener miles de categorías y no encontrar la que en realidad existe.
      const found = this.findByName(await this.listCategories(name), name);
      if (found !== undefined) return found;
      this.logger.warn(`Categoría de InvGate '${name}' (flowState.category) no matcheó ninguna real — uso el default.`);
    }
    return this.defaultCategoryId();
  }

  async resolvePriorityId(name?: string): Promise<number | undefined> {
    if (name) {
      if (!this.priorityCache) this.priorityCache = await this.listPriorities();
      const found = this.findByName(this.priorityCache, name);
      if (found !== undefined) return found;
      this.logger.warn(`Prioridad de InvGate '${name}' (flowState.priority) no matcheó ninguna real — uso el default.`);
    }
    return this.defaultPriorityId();
  }

  async resolveTypeId(name?: string): Promise<number | undefined> {
    if (name) {
      if (!this.typeCache) this.typeCache = await this.listIncidentTypes();
      const found = this.findByName(this.typeCache, name);
      if (found !== undefined) return found;
      this.logger.warn(`Tipo de InvGate '${name}' (flowState.ticketType) no matcheó ninguno real — uso el default.`);
    }
    return this.defaultTypeId();
  }

  /** Match exacto insensible a mayúsculas/acentos — no parcial, para no enrutar un ticket a la categoría equivocada. */
  private findByName(entries: InvgateCatalogEntry[], name: string): number | undefined {
    const normalized = this.normalizeName(name);
    return entries.find((e) => this.normalizeName(e.name) === normalized)?.id;
  }

  /** Saca diacríticos (acentos) tras normalizar a NFD, para que "Crítica"/"critica" matcheen igual. */
  private normalizeName(s: string): string {
    return s
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
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
    const username = await this.apiUser();
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

  /**
   * A diferencia de `GET incident` (que devuelve el incidente completo con `id`),
   * `POST incident` responde `{status, info, request_id}` — SIN `id` (confirmado
   * contra la instancia real 2026-08-20). Sin este mapeo, `incident.id` queda
   * `undefined` y el ticket local se guarda con `invgateId: "undefined"` (string),
   * silenciosamente "sincronizado" con nada.
   *
   * Adjuntos: confirmado contra la instancia real (2026-08-20) que `incident` (igual
   * que `incident.comment`) solo acepta archivos si el POST entero va como
   * `multipart/form-data` con cada archivo en un campo `attachments[]` — mandado
   * como el resto de los writes (`application/x-www-form-urlencoded`, campo
   * `attachments` con un id/JSON) el archivo se descarta en silencio (devuelve 200
   * OK igual, pero `attached_files`/`attachments` queda vacío). Sin adjuntos, sigue
   * yendo form-urlencoded como siempre — no hay motivo para cambiarlo si no hace falta.
   */
  async createIncident(input: CreateIncidentInput, attachments: IncidentAttachment[] = []): Promise<InvgateIncident> {
    const fields = {
      creator_id: input.creatorId,
      customer_id: input.customerId,
      category_id: input.categoryId,
      priority_id: input.priorityId,
      type_id: input.typeId,
      title: input.title,
      description: input.description,
      source_id: input.sourceId,
    };
    const raw = (
      attachments.length ? await this.postMultipart('incident', fields, attachments) : await this.post('incident', fields)
    ) as { id?: number; request_id?: number; [key: string]: unknown };

    const id = raw.id ?? raw.request_id;
    if (id === undefined) {
      throw new Error(`InvGate no devolvió un id de incidente creado: ${JSON.stringify(raw)}`);
    }
    return { ...raw, id } as InvgateIncident;
  }

  /**
   * Punto de entrada de alto nivel para el bot: resuelve `creator_id` (usuario técnico)
   * y category/priority/type — por nombre si la charla los recolectó (`fields`), si no
   * por el default configurado — internamente, así el llamador solo pasa lo específico
   * del ticket. Devuelve `null` (en vez de tirar) si falta cualquier prerequisito —
   * mismo criterio que WhatsAppService/TwilioWhatsAppService ante config incompleta:
   * loguear y seguir, nunca romper la charla por un problema de configuración de InvGate.
   */
  async createTicketForChat(
    customerId: number,
    title: string,
    description?: string,
    fields: TicketFieldNames = {},
    attachments: IncidentAttachment[] = [],
  ): Promise<InvgateIncident | null> {
    const creatorId = await this.resolveCreatorId();
    if (!creatorId) return null; // ya logueado en resolveCreatorId()

    const [categoryId, priorityId, typeId, sourceId] = await Promise.all([
      this.resolveCategoryId(fields.categoryName),
      this.resolvePriorityId(fields.priorityName),
      this.resolveTypeId(fields.typeName),
      this.defaultSourceId(),
    ]);

    const missing = [
      categoryId === undefined && 'categoría (flowState.category o INVGATE_DEFAULT_CATEGORY_ID)',
      priorityId === undefined && 'prioridad (flowState.priority o INVGATE_DEFAULT_PRIORITY_ID)',
      typeId === undefined && 'tipo (flowState.ticketType o INVGATE_DEFAULT_TYPE_ID)',
    ].filter((m): m is string => !!m);
    if (missing.length) {
      this.logger.warn(`No se pudo crear el ticket en InvGate: falta ${missing.join(', ')}.`);
      return null;
    }

    return this.createIncident(
      {
        creatorId,
        customerId,
        categoryId: categoryId!,
        priorityId: priorityId!,
        typeId: typeId!,
        sourceId,
        title,
        description,
      },
      attachments,
    );
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

  private async authHeader(): Promise<string> {
    const [user, key] = await Promise.all([this.apiUser(), this.apiKey()]);
    const basic = Buffer.from(`${user}:${key}`).toString('base64');
    return `Basic ${basic}`;
  }

  private async get(endpoint: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const url = new URL(`${await this.baseUrl()}${API_PREFIX}/${endpoint}`);
    for (const [key, value] of Object.entries(this.clean(params))) {
      url.searchParams.set(key, String(value));
    }
    return this.send('GET', url);
  }

  private async post(endpoint: string, data: Record<string, unknown> = {}): Promise<unknown> {
    const url = new URL(`${await this.baseUrl()}${API_PREFIX}/${endpoint}`);
    return this.send('POST', url, this.formBody(data));
  }

  /**
   * Único write que necesita `multipart/form-data` en vez del form-urlencoded del resto de
   * la API — ver el comentario en `createIncident`. `fetch` arma el boundary solo cuando el
   * body es un `FormData` real; por eso `send()` NO le pone `Content-Type` a mano acá (a
   * diferencia de `post`/`put`) — ese header sin el boundary correcto invalida el multipart entero.
   */
  private async postMultipart(
    endpoint: string,
    fields: Record<string, unknown>,
    attachments: IncidentAttachment[],
  ): Promise<unknown> {
    const url = new URL(`${await this.baseUrl()}${API_PREFIX}/${endpoint}`);
    const form = new FormData();
    for (const [key, value] of Object.entries(this.clean(fields))) {
      form.append(key, String(value));
    }
    for (const att of attachments) {
      form.append('attachments[]', new Blob([new Uint8Array(att.data)], { type: att.contentType }), att.filename);
    }
    return this.send('POST', url, form, UPLOAD_TIMEOUT_MS);
  }

  private async put(endpoint: string, data: Record<string, unknown> = {}): Promise<unknown> {
    const url = new URL(`${await this.baseUrl()}${API_PREFIX}/${endpoint}`);
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

  private async send(
    method: string,
    url: URL,
    body?: URLSearchParams | FormData,
    timeoutMs: number = TIMEOUT_MS,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: await this.authHeader(),
          Accept: 'application/json',
          ...(body instanceof URLSearchParams ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
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
      const message = body?.error || body?.info || (await this.sanitize(text)).slice(0, MAX_ERROR_LEN);
      throw new Error(`InvGate API error ${res.status}: ${message}`);
    }

    return parsed;
  }

  /** Nunca dejar que el token termine en un mensaje de error logueado. */
  private async sanitize(text: string): Promise<string> {
    const token = await this.apiKey();
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
