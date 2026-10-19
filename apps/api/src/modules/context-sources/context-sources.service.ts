import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveReadableTenantIds } from '../../common/rbac/readable-tenant-ids';
import { SecretsCipher } from '../../config/secrets.cipher';
import { BrokerService } from '../broker/broker.service';
import { CreateContextSourceDto, UpdateContextSourceDto } from './dto/context-source.dto';
import {
  CONTEXT_SOURCE_TYPES,
  ContextSourceFieldDefinition,
  getContextSourceType,
  isValidContextSourceType,
} from './context-source-types.catalog';
import {
  CONTEXT_SOURCE_TEST_QUEUE,
  CONTEXT_SOURCE_QUERY_QUEUE,
  CONTEXT_SOURCE_MCP_TOOLS_QUEUE,
  CONTEXT_SOURCE_MCP_CALL_QUEUE,
  ConnectionTestResult,
  ContextSourceQueryResult,
  McpToolCallResult,
  McpToolsListResult,
} from './broker/context-source-connector.service';
import { readConfiguredTools, type McpIdentity, type McpToolConfig } from './broker/mcp-client';

/** Herramienta que el modo agente le ofrece al LLM (mismo shape que `LlmToolDefinition`). */
export interface AgentTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/**
 * Lo que necesita el motor de conversaciones para el modo agente de una fuente MCP: las
 * tools que puede ofrecer al LLM (ya filtradas por la conexión y, si hay identidad, por los
 * permisos de la persona en el servidor) y cómo invocarlas. `unavailable` explica por qué
 * no hay tools (persona no vinculada, servidor caído…) para que el LLM se lo diga al usuario.
 */
export interface AgentToolset {
  sourceName: string;
  tools: AgentTool[];
  maxSteps: number;
  unavailable?: string;
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

const DEFAULT_AGENT_STEPS = 6;
const MAX_AGENT_STEPS = 12;

// Debe quedar por encima de TEST_TIMEOUT_MS (context-source-connector.service.ts):
// este timeout envuelve por RPC a ese chequeo interno, así que si vencen a la vez
// el mensaje de error que llega al usuario es el genérico de "sin respuesta del
// broker" en vez del detalle real (ok:false + motivo) que arma el connector.
const TEST_CONNECTION_TIMEOUT_MS = 22_000;

// Mismo motivo que TEST_CONNECTION_TIMEOUT_MS, por encima de QUERY_TIMEOUT_MS.
const QUERY_TIMEOUT_MS = 32_000;

/** Cada tool configurada es un `tools/call` por mensaje del usuario: acotado a propósito. */
const MAX_MCP_TOOLS = 10;

/**
 * Fuentes de verdad (MCP / RAG / n8n) del tenant activo.
 *
 * Toda operación está scopeada por tenant (como Areas): el tenant sale del header,
 * nunca del body. `config` solo persiste las keys declaradas en el catálogo para el
 * `type` de cada fuente — el resto se descarta al guardar, así nunca queda basura
 * suelta de un formulario mal armado. Los campos `secret` del catálogo viajan
 * cifrados con `SecretsCipher` (mismo mecanismo que `Setting`) y nunca salen en
 * claro por esta clase, salvo `getResolvedConfig`, pensado únicamente para uso
 * interno del connector (test-connection, y más adelante el motor de flujos).
 */
@Injectable()
export class ContextSourcesService {
  private readonly logger = new Logger(ContextSourcesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretsCipher,
    private readonly broker: BrokerService,
  ) {}

  /** Catálogo de tipos disponibles, para que el frontend arme el formulario dinámico. */
  getTypes() {
    return CONTEXT_SOURCE_TYPES;
  }

  async findAll(tenantId: string) {
    const sources = await this.prisma.contextSource.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });
    return sources.map((s) => this.toSafeDto(s));
  }

  /**
   * Fuentes de TODAS las empresas (vista consolidada "Todas las empresas" del superadmin).
   * Operación cross-tenant → `SystemTenantGuard` en el controller. Mismo shape que `findAll`
   * pero con la empresa de cada fila, para la columna "Empresa". Espejo de
   * `AreasService.findAllCrossTenant`.
   */
  async findAllCrossTenant() {
    const sources = await this.prisma.contextSource.findMany({
      // No listar fuentes de empresas dadas de baja: la empresa desaparece del selector,
      // así que su contenido no debe seguir apareciendo en la vista consolidada.
      where: { tenant: { deletedAt: null } },
      orderBy: [{ tenant: { name: 'asc' } }, { name: 'asc' }],
      include: { tenant: { select: { id: true, name: true, slug: true } } },
    });
    return sources.map((s) => this.toSafeDto(s));
  }

  /**
   * Fuentes de TODAS las empresas del propio usuario (vista "Todas mis empresas" del usuario
   * común). Acotado a las empresas donde su rol tiene `context-sources:read`. El scope lo pone
   * el userId, no el header. Espejo de `AreasService.findMine`.
   */
  async findMine(userId: string) {
    const readableTenantIds = await resolveReadableTenantIds(
      this.prisma,
      userId,
      'context-sources',
    );

    if (readableTenantIds.length === 0) return [];

    const sources = await this.prisma.contextSource.findMany({
      where: { tenantId: { in: readableTenantIds } },
      orderBy: [{ tenant: { name: 'asc' } }, { name: 'asc' }],
      include: { tenant: { select: { id: true, name: true, slug: true } } },
    });
    return sources.map((s) => this.toSafeDto(s));
  }

  async findOne(tenantId: string, id: string) {
    return this.toSafeDto(await this.getOwned(tenantId, id));
  }

  async create(tenantId: string, dto: CreateContextSourceDto) {
    if (!isValidContextSourceType(dto.type)) {
      throw new BadRequestException(`Tipo de fuente desconocido: "${dto.type}"`);
    }
    const name = dto.name.trim();
    await this.assertNameAvailable(tenantId, name);

    const config = this.prepareConfigForWrite(dto.type, dto.config ?? {});
    this.assertRequiredFieldsPresent(dto.type, config);

    const source = await this.prisma.contextSource.create({
      data: {
        tenantId,
        name,
        type: dto.type,
        config: config as Prisma.InputJsonValue,
        isActive: dto.isActive ?? true,
      },
    });
    this.logger.log(`Fuente de verdad creada: ${source.name} (${source.type}) en tenant ${tenantId}`);
    return this.toSafeDto(source);
  }

  async update(tenantId: string, id: string, dto: UpdateContextSourceDto) {
    const existing = await this.getOwned(tenantId, id);

    const data: { name?: string; isActive?: boolean; config?: Prisma.InputJsonValue } = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      await this.assertNameAvailable(tenantId, name, id);
      data.name = name;
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    if (dto.config !== undefined) {
      const existingConfig = (existing.config as Record<string, unknown>) ?? {};
      const merged = this.mergeConfigForWrite(existing.type, existingConfig, dto.config);
      this.assertRequiredFieldsPresent(existing.type, merged);
      data.config = merged as Prisma.InputJsonValue;
    }

    const source = await this.prisma.contextSource.update({ where: { id }, data });
    return this.toSafeDto(source);
  }

  async remove(tenantId: string, id: string) {
    const source = await this.getOwned(tenantId, id);

    const flowsUsingIt = await this.prisma.flow.count({ where: { contextSourceId: id } });
    if (flowsUsingIt > 0) {
      throw new ConflictException(
        `"${source.name}" está vinculada a ${flowsUsingIt} ${
          flowsUsingIt === 1 ? 'flujo' : 'flujos'
        }. Desvinculala antes de eliminarla.`,
      );
    }

    await this.prisma.contextSource.delete({ where: { id } });
    this.logger.log(`Fuente de verdad eliminada: ${source.name} (tenant ${tenantId})`);
    return { deleted: true, message: 'Fuente de verdad eliminada.' };
  }

  /**
   * `config` con los secrets ya descifrados, para uso interno exclusivo del
   * connector (`ContextSourceConnectorService`). Nunca exponer el resultado de
   * este método por API — es la única razón de ser de `toSafeDto` en el resto de
   * la clase.
   */
  async getResolvedConfig(tenantId: string, id: string): Promise<{ type: string; name: string; config: Record<string, unknown> }> {
    const source = await this.getOwned(tenantId, id);
    const typeDef = getContextSourceType(source.type);
    const raw = (source.config as Record<string, unknown>) ?? {};
    const resolved: Record<string, unknown> = { ...raw };

    for (const field of typeDef?.fields ?? []) {
      if (!field.secret) continue;
      const value = raw[field.key];
      if (typeof value === 'string' && value) {
        resolved[field.key] = this.cipher.decrypt(value);
      }
    }
    return { type: source.type, name: source.name, config: resolved };
  }

  /**
   * "Probar conexión": resuelve el config con los secrets en claro y lo manda por
   * el broker (patrón RPC, ver `ContextSourceConnectorService`) en vez de hacer el
   * `fetch` acá mismo — todo I/O externo pasa por el broker (AGENTS.md).
   */
  async testConnection(tenantId: string, id: string, userId?: string): Promise<ConnectionTestResult> {
    const { type, config } = await this.getResolvedConfig(tenantId, id);
    // Con identidad, se prueba EN NOMBRE de quien aprieta el botón (su usuario de Titan vinculado):
    // el servidor lista las tools que esa persona puede usar.
    const identity = type === 'mcp' && config.identityMode === 'titan' && userId
      ? await this.resolveTitanIdentity(tenantId, userId)
      : null;
    if (type === 'mcp' && config.identityMode === 'titan' && !identity) {
      return {
        ok: false,
        latencyMs: 0,
        message:
          'Esta conexión envía la identidad de la persona: para probarla, tu usuario tiene que estar ' +
          'vinculado a un usuario de TitanHR (importalo con titan-sync).',
      };
    }

    try {
      const reply = await this.broker.request(
        CONTEXT_SOURCE_TEST_QUEUE,
        { pattern: 'context-source.test-connection', data: { type, config, identity }, tenantId },
        { timeoutMs: TEST_CONNECTION_TIMEOUT_MS },
      );
      return reply.data as ConnectionTestResult;
    } catch (err) {
      return {
        ok: false,
        latencyMs: 0,
        message: err instanceof Error ? err.message : 'No se pudo probar la conexión',
      };
    }
  }

  /**
   * Consulta real durante una conversación en curso (a diferencia de
   * `testConnection`, pensado para el botón de admin): usada tanto por
   * `ConversationsService.orchestratorLlm` (charla fuera del flujo armado) como
   * por el nodo `llm_query` dentro de un flujo — en ambos casos, siempre que el
   * `Flow` en curso tenga una fuente de verdad vinculada. Mismo patrón RPC por
   * el broker, cola separada (`CONTEXT_SOURCE_QUERY_QUEUE`) — ver
   * `ContextSourceConnectorService.query`.
   */
  async queryKnowledge(
    tenantId: string,
    contextSourceId: string,
    question: string,
    userId?: string,
  ): Promise<ContextSourceQueryResult> {
    try {
      // A diferencia de `testConnection` (detrás de un controller: una excepción acá
      // se traduce sola en un 404 HTTP), esto corre en medio de una conversación —
      // nunca puede tirar, o el mensaje del usuario se pierde sin respuesta.
      const { type, config } = await this.getResolvedConfig(tenantId, contextSourceId);
      let identity: McpIdentity | null = null;
      if (type === 'mcp' && config.identityMode === 'titan') {
        identity = userId ? await this.resolveTitanIdentity(tenantId, userId) : null;
        if (!identity) {
          return { ok: false, latencyMs: 0, message: 'La persona no está vinculada a un usuario de TitanHR' };
        }
      }
      const reply = await this.broker.request(
        CONTEXT_SOURCE_QUERY_QUEUE,
        { pattern: 'context-source.query', data: { type, config, question, identity }, tenantId },
        { timeoutMs: QUERY_TIMEOUT_MS },
      );
      return reply.data as ContextSourceQueryResult;
    } catch (err) {
      return {
        ok: false,
        latencyMs: 0,
        message: err instanceof Error ? err.message : 'No se pudo consultar la fuente de verdad',
      };
    }
  }

  /**
   * "Descubrir tools" (`tools/list`) de un servidor MCP para el formulario de
   * alta/edición. Trabaja sobre la config que está en pantalla, todavía sin guardar
   * (`draftConfig`) — así se pueden elegir las tools antes de crear la conexión. Si se
   * está editando una existente (`sourceId`), la base es su config guardada: los
   * secretos nunca vuelven al frontend en claro, así que un `apiKey` que no viene en el
   * body se toma de la base (mismo criterio que `mergeConfigForWrite`).
   */
  async listMcpTools(
    tenantId: string,
    sourceId: string | undefined,
    draftConfig: Record<string, unknown>,
    userId?: string,
  ): Promise<McpToolsListResult> {
    let config: Record<string, unknown> = {};
    if (sourceId) {
      const stored = await this.getResolvedConfig(tenantId, sourceId);
      if (stored.type !== 'mcp') throw new BadRequestException('La fuente de verdad no es de tipo MCP');
      config = stored.config;
    }
    for (const field of getContextSourceType('mcp')?.fields ?? []) {
      const incoming = draftConfig[field.key];
      if (incoming === undefined) continue;
      if (incoming === null || incoming === '') delete config[field.key];
      else config[field.key] = incoming;
    }

    const identity = config.identityMode === 'titan' && userId ? await this.resolveTitanIdentity(tenantId, userId) : null;
    if (config.identityMode === 'titan' && !identity) {
      return {
        ok: false,
        latencyMs: 0,
        message:
          'Esta conexión envía la identidad de la persona: para descubrir tools, tu usuario tiene que estar ' +
          'vinculado a un usuario de TitanHR (importalo con titan-sync).',
      };
    }

    try {
      return await this.requestMcpTools(tenantId, config, identity);
    } catch (err) {
      return {
        ok: false,
        latencyMs: 0,
        message: err instanceof Error ? err.message : 'No se pudieron listar las tools del servidor MCP',
      };
    }
  }

  /**
   * Modo agente (`queryMode: 'agent'`) de una fuente MCP, para el motor de conversaciones:
   * las tools que el LLM puede usar y cómo invocarlas. `null` si la fuente no es MCP o no
   * está en modo agente (el caller sigue con `queryKnowledge`). Nunca tira: cualquier
   * problema queda en `unavailable` para que la charla siga.
   *
   * Con `identityMode: 'titan'` todo viaja firmado en nombre de la persona que escribe
   * (`TitanUserLink`): el servidor solo anuncia y ejecuta lo que esa persona puede ver.
   */
  async getAgentToolset(tenantId: string, contextSourceId: string, userId: string): Promise<AgentToolset | null> {
    let resolved: { type: string; name: string; config: Record<string, unknown> };
    try {
      resolved = await this.getResolvedConfig(tenantId, contextSourceId);
    } catch (err) {
      this.logger.warn(`getAgentToolset: fuente ${contextSourceId} no disponible — ${err instanceof Error ? err.message : err}`);
      return null;
    }
    const { type, name: sourceName, config } = resolved;
    if (type !== 'mcp' || config.queryMode !== 'agent') return null;

    const steps = Number(config.maxToolSteps);
    const maxSteps = Number.isFinite(steps) && steps >= 1 ? Math.min(Math.trunc(steps), MAX_AGENT_STEPS) : DEFAULT_AGENT_STEPS;
    const unavailable = (reason: string): AgentToolset => ({
      sourceName,
      tools: [],
      maxSteps,
      unavailable: reason,
      call: async () => reason,
    });

    let identity: McpIdentity | null = null;
    if (config.identityMode === 'titan') {
      identity = await this.resolveTitanIdentity(tenantId, userId);
      if (!identity) {
        return unavailable(
          'La persona no tiene un usuario de TitanHR vinculado (o está bloqueado), así que no se pueden consultar sus datos.',
        );
      }
    }

    let listed: McpToolsListResult;
    try {
      listed = await this.requestMcpTools(tenantId, config, identity);
    } catch (err) {
      listed = { ok: false, latencyMs: 0, message: err instanceof Error ? err.message : String(err) };
    }
    if (!listed.ok || !listed.tools) {
      this.logger.warn(`Fuente ${sourceName}: no se pudieron listar las tools — ${listed.message}`);
      return unavailable(`El servicio de datos "${sourceName}" no está disponible en este momento.`);
    }

    // Si la conexión lista tools, el LLM solo puede usar esas (el admin acota); vacía = todas.
    const configured = new Set(readConfiguredTools(config).map((t) => t.name));
    const tools: AgentTool[] = listed.tools
      .filter((t) => !configured.size || configured.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
      }));
    const allowed = new Set(tools.map((t) => t.name));

    return {
      sourceName,
      tools,
      maxSteps,
      call: async (toolName, args) => {
        if (!allowed.has(toolName)) return `La herramienta "${toolName}" no está disponible.`;
        const reply = await this.broker.request(
          CONTEXT_SOURCE_MCP_CALL_QUEUE,
          { pattern: 'context-source.mcp.call-tool', data: { config, identity, name: toolName, arguments: args }, tenantId },
          { timeoutMs: QUERY_TIMEOUT_MS },
        );
        const result = reply.data as McpToolCallResult;
        if (!result.ok) throw new Error(result.message);
        return result.text ?? '';
      },
    };
  }

  /**
   * Usuario de TitanHR vinculado a una persona de PCI en esta empresa (lo deja `titan-sync`
   * en `TitanUserLink`). Se lee la tabla directo y no el servicio de `titan-sync` para no
   * depender del módulo (es instalable): si no está instalado o la persona no fue
   * importada, simplemente no hay vínculo. Un usuario bloqueado en Titan no tiene identidad.
   */
  async resolveTitanIdentity(tenantId: string, userId: string): Promise<McpIdentity | null> {
    try {
      const link = await this.prisma.titanUserLink.findUnique({ where: { userId_tenantId: { userId, tenantId } } });
      if (!link || link.titanLocked) return null;
      return { titanUserId: link.titanUserId, titanEmail: link.titanEmail, pciUserId: userId, tenantId };
    } catch (err) {
      this.logger.warn(`No se pudo resolver el usuario de TitanHR de ${userId}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async requestMcpTools(
    tenantId: string,
    config: Record<string, unknown>,
    identity: McpIdentity | null,
  ): Promise<McpToolsListResult> {
    const reply = await this.broker.request(
      CONTEXT_SOURCE_MCP_TOOLS_QUEUE,
      { pattern: 'context-source.mcp.list-tools', data: { config, identity }, tenantId },
      { timeoutMs: TEST_CONNECTION_TIMEOUT_MS },
    );
    return reply.data as McpToolsListResult;
  }

  // --- helpers ---

  private async getOwned(tenantId: string, id: string) {
    const source = await this.prisma.contextSource.findFirst({ where: { id, tenantId } });
    if (!source) throw new NotFoundException('La fuente de verdad no existe en este tenant');
    return source;
  }

  /**
   * Mismo criterio que `AreasService.assertNameAvailable`: chequeo previo insensible
   * a mayúsculas para dar el mensaje en castellano antes de que choque el índice único.
   */
  private async assertNameAvailable(tenantId: string, name: string, exceptId?: string) {
    const existing = await this.prisma.contextSource.findFirst({
      where: {
        tenantId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });
    if (existing) {
      throw new ConflictException('Ya existe una fuente de verdad con ese nombre en este tenant');
    }
  }

  private assertRequiredFieldsPresent(type: string, config: Record<string, unknown>) {
    const typeDef = getContextSourceType(type);
    const missing = (typeDef?.fields ?? [])
      .filter((f) => f.required && !config[f.key])
      .map((f) => f.label);
    if (missing.length) {
      throw new BadRequestException(`Faltan campos obligatorios: ${missing.join(', ')}`);
    }
  }

  /** Solo persiste las keys declaradas en el catálogo para `type`; cifra las `secret`. */
  private prepareConfigForWrite(type: string, input: Record<string, unknown>): Record<string, unknown> {
    const typeDef = getContextSourceType(type);
    const out: Record<string, unknown> = {};
    for (const field of typeDef?.fields ?? []) {
      const value = input[field.key];
      if (value === undefined || value === null || value === '') continue;
      out[field.key] = this.normalizeForWrite(field, value);
    }
    return out;
  }

  /** Cifra los `secret` y valida/normaliza los campos estructurados (`mcpTools`). */
  private normalizeForWrite(field: ContextSourceFieldDefinition, value: unknown): unknown {
    if (field.secret) return this.cipher.encrypt(String(value));
    if (field.type === 'mcpTools') return this.normalizeMcpTools(field.label, value);
    return value;
  }

  /**
   * `config.tools` de un `mcp`: `[{ name, arguments }]`. Se valida acá (y no en el DTO)
   * porque `config` es un Json libre cuyo shape depende del `type` — mismo criterio que
   * el resto del catálogo. `arguments` es la plantilla con `{{pregunta}}`, ver
   * `broker/mcp-client.ts`.
   */
  private normalizeMcpTools(label: string, value: unknown): McpToolConfig[] {
    if (!Array.isArray(value)) throw new BadRequestException(`"${label}" debe ser una lista de tools`);
    if (value.length > MAX_MCP_TOOLS) {
      throw new BadRequestException(`"${label}": como máximo ${MAX_MCP_TOOLS} tools por conexión`);
    }
    const seen = new Set<string>();
    return value.map((item, i) => {
      const name = item && typeof item === 'object' && typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) throw new BadRequestException(`"${label}": la tool #${i + 1} no tiene nombre`);
      if (seen.has(name)) throw new BadRequestException(`"${label}": la tool "${name}" está repetida`);
      seen.add(name);
      const args = item.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) {
        throw new BadRequestException(`"${label}": los argumentos de "${name}" deben ser un objeto JSON`);
      }
      return { name, arguments: args as Record<string, unknown> };
    });
  }

  /**
   * Igual que `prepareConfigForWrite`, pero para un update: si un campo `secret` no
   * viene en `input` (porque el GET nunca lo devolvió en claro), conserva el valor
   * cifrado que ya había en vez de borrarlo. Mandar el campo explícitamente en
   * `null`/`''` sí lo borra.
   */
  private mergeConfigForWrite(
    type: string,
    existing: Record<string, unknown>,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const typeDef = getContextSourceType(type);
    const out: Record<string, unknown> = {};
    for (const field of typeDef?.fields ?? []) {
      const incoming = input[field.key];
      if (incoming === undefined) {
        if (existing[field.key] !== undefined) out[field.key] = existing[field.key];
        continue;
      }
      if (incoming === null || incoming === '') continue;
      out[field.key] = this.normalizeForWrite(field, incoming);
    }
    return out;
  }

  /**
   * Nunca devuelve un secret en claro: lo enmascara (`SecretsCipher.mask`, igual
   * que `/settings`) y agrega `<key>IsSet` para que la UI sepa si hay algo cargado
   * sin necesitar el valor real.
   */
  private toSafeDto(source: { config: unknown; type: string; [k: string]: unknown }) {
    const typeDef = getContextSourceType(source.type);
    const raw = (source.config as Record<string, unknown>) ?? {};
    const safeConfig: Record<string, unknown> = {};

    for (const field of typeDef?.fields ?? []) {
      const value = raw[field.key];
      if (field.secret) {
        const plain = this.tryDecrypt(value);
        safeConfig[field.key] = plain ? this.cipher.mask(plain) : '';
        safeConfig[`${field.key}IsSet`] = !!plain;
      } else if (value !== undefined) {
        safeConfig[field.key] = value;
      }
    }

    return { ...source, config: safeConfig };
  }

  /** No tira si `SETTINGS_ENCRYPTION_KEY` rotó: reporta "cargado pero ilegible", como `/settings`. */
  private tryDecrypt(value: unknown): string {
    if (typeof value !== 'string' || !value) return '';
    try {
      return this.cipher.isEncrypted(value) ? this.cipher.decrypt(value) : value;
    } catch {
      return '(no se pudo descifrar)';
    }
  }
}
