import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IntegrationsConfigService } from '../integrations/integrations-config.service';
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
import { MCP_QUESTION_PLACEHOLDER, readConfiguredTools, type McpToolConfig, type McpToolInfo } from './broker/mcp-client';
import type { LlmToolCall, LlmToolDefinition } from '../llm/llm-provider.interface';

// Debe quedar por encima de TEST_TIMEOUT_MS (context-source-connector.service.ts):
// este timeout envuelve por RPC a ese chequeo interno, así que si vencen a la vez
// el mensaje de error que llega al usuario es el genérico de "sin respuesta del
// broker" en vez del detalle real (ok:false + motivo) que arma el connector.
const TEST_CONNECTION_TIMEOUT_MS = 22_000;

// Mismo motivo que TEST_CONNECTION_TIMEOUT_MS, por encima de QUERY_TIMEOUT_MS.
const QUERY_TIMEOUT_MS = 32_000;

/** Cada tool configurada es un `tools/call` por mensaje del usuario: acotado a propósito. */
const MAX_MCP_TOOLS = 10;

/** Caché del `tools/list` de cada fuente para el LLM (C61): no se paga en cada mensaje. */
const MCP_TOOLS_CACHE_MS = 5 * 60_000;
/** Timeout del `tools/list` cuando se arma el toolset en medio de una conversación. */
const MCP_TOOLS_LIST_TIMEOUT_MS = 5_000;
/** Timeout por defecto de una tool elegida por el LLM. */
const MCP_TOOL_CALL_TIMEOUT_MS = 15_000;

/**
 * Tools de una fuente MCP listas para el LLM del flujo (contrato C61). `execute` nunca tira:
 * un error vuelve como `{ ok: false, content }` para que el LLM lo lea.
 */
export interface McpLlmToolset {
  sourceName: string;
  tools: LlmToolDefinition[];
  execute(call: LlmToolCall, timeoutMs?: number): Promise<{ ok: boolean; content: string }>;
}

/**
 * Un argumento de la configuración es fijo si tiene un valor real: no vacío, sin
 * `{{pregunta}}` y distinto de 0 (el formulario pone 0 y "" de relleno en los obligatorios).
 * Los fijos los inyecta pci y se sacan del esquema; el resto lo completa el LLM.
 */
export function isFixedToolArgument(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '' && !value.includes(MCP_QUESTION_PLACEHOLDER);
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

/** Nombre de tool que aceptan todos los proveedores: `^[a-zA-Z0-9_-]{1,64}$`. */
function llmToolName(name: string, taken: Set<string>): string {
  const base = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'tool';
  let out = base;
  for (let i = 2; taken.has(out); i++) out = `${base}_${i}`;
  taken.add(out);
  return out;
}

/** `inputSchema` del servidor sin las propiedades que fija la configuración. */
function schemaWithoutFixed(inputSchema: Record<string, unknown> | undefined, fixed: string[]): Record<string, unknown> {
  const schema = inputSchema && typeof inputSchema === 'object' ? { ...inputSchema } : {};
  const properties = { ...((schema.properties as Record<string, unknown>) ?? {}) };
  for (const key of fixed) delete properties[key];
  const required = Array.isArray(schema.required) ? (schema.required as string[]).filter((k) => !fixed.includes(k)) : [];
  delete schema.$schema;
  return { ...schema, type: 'object', properties, ...(required.length ? { required } : { required: undefined }) };
}

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
/** Nombre para voz (C65): recortado; vacío es `null`. */
function normalizeVoiceName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

@Injectable()
export class ContextSourcesService {
  private readonly logger = new Logger(ContextSourcesService.name);

  private readonly mcpToolsCache = new Map<string, { at: number; serverUrl: unknown; tools: McpToolInfo[] }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretsCipher,
    private readonly broker: BrokerService,
    private readonly integrations: IntegrationsConfigService,
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
        voiceName: normalizeVoiceName(dto.voiceName),
        isActive: dto.isActive ?? true,
      },
    });
    this.logger.log(`Fuente de verdad creada: ${source.name} (${source.type}) en tenant ${tenantId}`);
    if (source.voiceName) await this.notifyVoiceNameChanged(source.name);
    return this.toSafeDto(source);
  }

  async update(tenantId: string, id: string, dto: UpdateContextSourceDto) {
    const existing = await this.getOwned(tenantId, id);

    const data: { name?: string; isActive?: boolean; config?: Prisma.InputJsonValue; voiceName?: string | null } = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      await this.assertNameAvailable(tenantId, name, id);
      data.name = name;
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.voiceName !== undefined) data.voiceName = normalizeVoiceName(dto.voiceName);

    if (dto.config !== undefined) {
      const existingConfig = (existing.config as Record<string, unknown>) ?? {};
      const merged = this.mergeConfigForWrite(existing.type, existingConfig, dto.config);
      this.assertRequiredFieldsPresent(existing.type, merged);
      data.config = merged as Prisma.InputJsonValue;
    }

    const source = await this.prisma.contextSource.update({ where: { id }, data });
    this.mcpToolsCache.delete(id);
    // Los avisos de espera con {label} se pregraban con cada nombre para voz (voiceLiterals, C65).
    if ((source.voiceName ?? null) !== (existing.voiceName ?? null) || (source.voiceName && source.isActive !== existing.isActive)) {
      await this.notifyVoiceNameChanged(source.name);
    }
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
  async testConnection(tenantId: string, id: string): Promise<ConnectionTestResult> {
    const { type, config } = await this.getResolvedConfig(tenantId, id);

    try {
      const reply = await this.broker.request(
        CONTEXT_SOURCE_TEST_QUEUE,
        { pattern: 'context-source.test-connection', data: { type, config }, tenantId },
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
  async queryKnowledge(tenantId: string, contextSourceId: string, question: string): Promise<ContextSourceQueryResult> {
    try {
      // A diferencia de `testConnection` (detrás de un controller: una excepción acá
      // se traduce sola en un 404 HTTP), esto corre en medio de una conversación —
      // nunca puede tirar, o el mensaje del usuario se pierde sin respuesta.
      const { type, config } = await this.getResolvedConfig(tenantId, contextSourceId);
      const reply = await this.broker.request(
        CONTEXT_SOURCE_QUERY_QUEUE,
        { pattern: 'context-source.query', data: { type, config, question }, tenantId },
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

    try {
      const reply = await this.broker.request(
        CONTEXT_SOURCE_MCP_TOOLS_QUEUE,
        { pattern: 'context-source.mcp.list-tools', data: { config }, tenantId },
        { timeoutMs: TEST_CONNECTION_TIMEOUT_MS },
      );
      return reply.data as McpToolsListResult;
    } catch (err) {
      return {
        ok: false,
        latencyMs: 0,
        message: err instanceof Error ? err.message : 'No se pudieron listar las tools del servidor MCP',
      };
    }
  }

  /**
   * Tools de la fuente para que el LLM del flujo la opere (contrato C61): las configuradas en
   * la conexión, con descripción y esquema del `tools/list` del servidor (caché de 5 min), sin
   * los argumentos fijos de la configuración — esos los inyecta `execute` y el LLM no los ve ni
   * los pisa. `null` si la fuente no es MCP, no tiene tools o el servidor no las lista: el
   * llamador sigue con la consulta de siempre (`queryKnowledge`). Nunca tira.
   */
  async mcpToolsetForLlm(tenantId: string, sourceId: string): Promise<McpLlmToolset | null> {
    try {
      const { type, name, config } = await this.getResolvedConfig(tenantId, sourceId);
      if (type !== 'mcp') return null;
      const configured = readConfiguredTools(config).slice(0, MAX_MCP_TOOLS);
      if (!configured.length) return null;

      const serverTools = await this.cachedMcpTools(tenantId, sourceId, config);
      if (!serverTools) return null;

      const taken = new Set<string>();
      const byLlmName = new Map<string, { mcpName: string; fixed: Record<string, unknown> }>();
      const tools: LlmToolDefinition[] = [];
      for (const tool of configured) {
        const info = serverTools.find((t) => t.name === tool.name);
        if (!info) {
          this.logger.warn(`Fuente ${sourceId}: la tool configurada "${tool.name}" no existe en el servidor.`);
          continue;
        }
        const fixed = Object.fromEntries(Object.entries(tool.arguments ?? {}).filter(([, v]) => isFixedToolArgument(v)));
        const llmName = llmToolName(tool.name, taken);
        byLlmName.set(llmName, { mcpName: tool.name, fixed });
        tools.push({
          name: llmName,
          description: (info.description ?? '').slice(0, 1000),
          parameters: schemaWithoutFixed(info.inputSchema, Object.keys(fixed)),
        });
      }
      if (!tools.length) return null;

      return {
        sourceName: name,
        tools,
        execute: async (call, timeoutMs = MCP_TOOL_CALL_TIMEOUT_MS) => {
          const target = byLlmName.get(call.name);
          if (!target) return { ok: false, content: `No existe la herramienta "${call.name}".` };
          // Los fijos van encima: el LLM no puede cambiar lo que fijó la configuración.
          const args = { ...(call.arguments ?? {}), ...target.fixed };
          try {
            const reply = await this.broker.request(
              CONTEXT_SOURCE_MCP_CALL_QUEUE,
              { pattern: 'context-source.mcp.call-tool', data: { config, name: target.mcpName, arguments: args, timeoutMs }, tenantId },
              { timeoutMs: timeoutMs + 2_000 },
            );
            const result = reply.data as McpToolCallResult;
            return result.ok && result.text
              ? { ok: true, content: result.text }
              : { ok: false, content: `Error de la herramienta: ${result.message}` };
          } catch (err) {
            return { ok: false, content: `No se pudo consultar: ${err instanceof Error ? err.message : err}` };
          }
        },
      };
    } catch (err) {
      this.logger.warn(`Fuente ${sourceId}: no se pudieron armar las tools — ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async cachedMcpTools(
    tenantId: string,
    sourceId: string,
    config: Record<string, unknown>,
  ): Promise<McpToolInfo[] | null> {
    const hit = this.mcpToolsCache.get(sourceId);
    if (hit && hit.serverUrl === config.serverUrl && Date.now() - hit.at < MCP_TOOLS_CACHE_MS) return hit.tools;
    const reply = await this.broker
      .request(
        CONTEXT_SOURCE_MCP_TOOLS_QUEUE,
        { pattern: 'context-source.mcp.list-tools', data: { config }, tenantId },
        { timeoutMs: MCP_TOOLS_LIST_TIMEOUT_MS },
      )
      .catch(() => null);
    const result = reply?.data as McpToolsListResult | undefined;
    if (!result?.ok || !result.tools) {
      this.logger.warn(`Fuente ${sourceId}: tools/list falló (${result?.message ?? 'sin respuesta'}).`);
      return null;
    }
    this.mcpToolsCache.set(sourceId, { at: Date.now(), serverUrl: config.serverUrl, tools: result.tools });
    return result.tools;
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
  /** Que falle el aviso no deshace el guardado (mismo criterio que los flujos de voz, C60). */
  private async notifyVoiceNameChanged(sourceName: string) {
    try {
      await this.integrations.notifyVoiceFlowsChanged(`nombre para voz de la fuente ${sourceName}`);
    } catch (err) {
      this.logger.warn(`No se avisó al voicebot el nombre para voz de ${sourceName}: ${err instanceof Error ? err.message : err}`);
    }
  }

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
