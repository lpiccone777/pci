import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveReadableTenantIds } from '../../common/rbac/readable-tenant-ids';
import { SecretsCipher } from '../../config/secrets.cipher';
import { BrokerService } from '../broker/broker.service';
import { CreateContextSourceDto, UpdateContextSourceDto } from './dto/context-source.dto';
import {
  CONTEXT_SOURCE_TYPES,
  getContextSourceType,
  isValidContextSourceType,
} from './context-source-types.catalog';
import {
  CONTEXT_SOURCE_TEST_QUEUE,
  CONTEXT_SOURCE_QUERY_QUEUE,
  ConnectionTestResult,
  ContextSourceQueryResult,
} from './broker/context-source-connector.service';

// Debe quedar por encima de TEST_TIMEOUT_MS (context-source-connector.service.ts):
// este timeout envuelve por RPC a ese chequeo interno, así que si vencen a la vez
// el mensaje de error que llega al usuario es el genérico de "sin respuesta del
// broker" en vez del detalle real (ok:false + motivo) que arma el connector.
const TEST_CONNECTION_TIMEOUT_MS = 22_000;

// Mismo motivo que TEST_CONNECTION_TIMEOUT_MS, por encima de QUERY_TIMEOUT_MS.
const QUERY_TIMEOUT_MS = 32_000;

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
      out[field.key] = field.secret ? this.cipher.encrypt(String(value)) : value;
    }
    return out;
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
      out[field.key] = field.secret ? this.cipher.encrypt(String(incoming)) : incoming;
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
