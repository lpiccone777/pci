import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TitanConnection } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { SecretsCipher } from '../../config/secrets.cipher';
import { isProtectedRole } from '../rbac/protected-role';
import { systemTenantSlug } from '../../common/system-tenant';
import {
  ImportTitanUsersDto,
  UpsertTitanConnectionDto,
} from './dto/titan-sync.dto';
import {
  TitanApiError,
  TitanClient,
  TitanContact,
  TitanCredentials,
  TitanUser,
} from './titan-client';
import { toWhatsappPhone } from './titan-phone.util';

/** Consultas de contactos en paralelo contra Titan: bajo, por su rate limit de 300 req/min. */
const CONTACTS_CONCURRENCY = 4;

export type TitanUserStatus = 'new' | 'linked' | 'member' | 'other-tenant';

export interface TitanPreviewUser {
  titanUserId: number;
  email: string;
  firstName: string;
  lastName: string;
  locked: boolean;
  roles: string[];
  companyName: string | null;
  eligible: boolean;
  ineligibleReason: string | null;
  status: TitanUserStatus;
  pciUserId: string | null;
}

export type ImportOutcome = 'created' | 'linked' | 'updated' | 'skipped';

export interface ImportResultRow {
  titanUserId: number;
  email: string | null;
  outcome: ImportOutcome;
  reason?: string;
  phone?: string | null;
  warnings: string[];
}

@Injectable()
export class TitanSyncService {
  private readonly logger = new Logger(TitanSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly cipher: SecretsCipher,
    private readonly config: ConfigService,
  ) {}

  // --- Interruptor del módulo -----------------------------------------------------------

  isEnabled(): Promise<boolean> {
    return this.appConfig.getBoolean('TITAN_SYNC_ENABLED', false);
  }

  private async assertEnabled() {
    if (!(await this.isEnabled())) {
      throw new NotFoundException(
        'El módulo de importación desde TitanHR está deshabilitado (TITAN_SYNC_ENABLED en /settings)',
      );
    }
  }

  // --- Conexión -------------------------------------------------------------------------

  /** Siempre responde (aunque el módulo esté apagado): el frontend lo usa para mostrar o no el botón. */
  async getStatus(tenantId: string) {
    if (!(await this.isEnabled())) return { enabled: false, connection: null };
    const conn = await this.prisma.titanConnection.findUnique({
      where: { tenantId },
    });
    return {
      enabled: true,
      connection: conn ? this.toSafeConnection(conn) : null,
    };
  }

  async upsertConnection(tenantId: string, dto: UpsertTitanConnectionDto) {
    await this.assertEnabled();

    // Misma semántica que los secrets de /settings y de ContextSource:
    // ausente = no tocar, null/'' = borrar, valor = cifrar y reemplazar.
    let itPassword: string | null | undefined;
    if (dto.itPassword === undefined) {
      itPassword = undefined;
    } else if (dto.itPassword === null || dto.itPassword === '') {
      itPassword = null;
    } else {
      if (!this.cipher.isConfigured) {
        throw new BadRequestException(
          'SETTINGS_ENCRYPTION_KEY no está configurada: no se puede guardar la contraseña del usuario técnico',
        );
      }
      itPassword = this.cipher.encrypt(dto.itPassword);
    }

    const baseUrl = dto.baseUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/api$/, '');
    const conn = await this.prisma.titanConnection.upsert({
      where: { tenantId },
      create: {
        tenantId,
        baseUrl,
        itEmail: dto.itEmail.trim(),
        itPassword: itPassword ?? null,
      },
      update: {
        baseUrl,
        itEmail: dto.itEmail.trim(),
        ...(itPassword !== undefined ? { itPassword } : {}),
      },
    });
    // Nunca loguear la contraseña: solo qué empresa cambió su conexión.
    this.logger.log(`Conexión con TitanHR actualizada para tenant ${tenantId}`);
    return this.toSafeConnection(conn);
  }

  async testConnection(tenantId: string) {
    await this.assertEnabled();
    const creds = await this.resolveCredentials(tenantId);
    const client = new TitanClient(creds);
    try {
      await client.login();
      const users = await client.listUsers();
      return {
        ok: true,
        totalUsers: users.length,
        eligibleUsers: users.filter((u) => this.ineligibleReason(u) === null)
          .length,
      };
    } catch (err) {
      if (err instanceof TitanApiError)
        return { ok: false, error: err.message };
      throw err;
    } finally {
      await client.logout();
    }
  }

  // --- Previsualización -----------------------------------------------------------------

  async previewUsers(tenantId: string) {
    await this.assertEnabled();
    const users = await this.withClient(tenantId, (client) =>
      client.listUsers(),
    );

    const [links, existing] = await Promise.all([
      this.prisma.titanUserLink.findMany({
        where: { tenantId },
        select: { titanUserId: true, userId: true },
      }),
      this.findActiveUsersByEmail(users.map((u) => u.email).filter(Boolean)),
    ]);
    const linkByTitanId = new Map(links.map((l) => [l.titanUserId, l.userId]));

    const rows: TitanPreviewUser[] = users.map((u) => {
      const reason = this.ineligibleReason(u);
      const names = this.splitName(u);
      const linkedUserId = linkByTitanId.get(u.userId) ?? null;
      const pci = u.email ? existing.get(u.email.toLowerCase()) : undefined;

      let status: TitanUserStatus = 'new';
      if (linkedUserId) status = 'linked';
      else if (pci)
        status = pci.tenantIds.includes(tenantId) ? 'member' : 'other-tenant';

      return {
        titanUserId: u.userId,
        email: u.email,
        firstName: names.firstName,
        lastName: names.lastName,
        locked: !!u.locked,
        roles: this.roleNames(u),
        companyName: u.companyName ?? null,
        eligible: reason === null,
        ineligibleReason: reason,
        status,
        pciUserId: linkedUserId ?? pci?.id ?? null,
      };
    });

    rows.sort((a, b) =>
      `${a.lastName} ${a.firstName}`.localeCompare(
        `${b.lastName} ${b.firstName}`,
        'es',
      ),
    );
    const roles = [...new Set(rows.flatMap((r) => r.roles))].sort((a, b) =>
      a.localeCompare(b, 'es'),
    );
    return { users: rows, roles };
  }

  // --- Importación ----------------------------------------------------------------------

  async importUsers(tenantId: string, dto: ImportTitanUsersDto) {
    await this.assertEnabled();
    await this.assertRoleAssignable(tenantId, dto.roleId);
    const areaId = dto.areaId || null;
    if (areaId) {
      const area = await this.prisma.area.findFirst({
        where: { id: areaId, tenantId },
      });
      if (!area)
        throw new BadRequestException(
          'El área no existe o no pertenece a este tenant',
        );
    }

    const requested = [...new Set(dto.titanUserIds)];

    // Todo lo que necesita Titan se trae de una vez, con UNA sesión del usuario técnico.
    const { byId, phones } = await this.withClient(tenantId, async (client) => {
      const all = await client.listUsers();
      const byId = new Map(all.map((u) => [u.userId, u]));
      const toFetch = requested
        .map((id) => byId.get(id))
        .filter(
          (u): u is TitanUser =>
            !!u && this.ineligibleReason(u) === null && !!u.personId,
        );
      const phones = new Map<
        number,
        { phone: string | null; raw: string | null }
      >();
      await mapLimit(toFetch, CONTACTS_CONCURRENCY, async (u) => {
        try {
          phones.set(
            u.userId,
            this.pickPhone(await client.listContacts(u.personId!)),
          );
        } catch (err) {
          this.logger.warn(
            `No se pudieron leer los contactos del usuario Titan ${u.userId}: ${(err as Error).message}`,
          );
          phones.set(u.userId, { phone: null, raw: null });
        }
      });
      return { byId, phones };
    });

    // Contraseña de PCI inutilizable: los importados entran por WhatsApp, no al backoffice.
    // Un único hash por importación (bcrypt por usuario tarda ~1 min cada 700) de un valor
    // aleatorio que se descarta en el acto: nadie lo conoce. Si alguno necesita backoffice,
    // se le cambia la contraseña desde la edición del usuario.
    const unusableHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);

    const results: ImportResultRow[] = [];
    for (const titanUserId of requested) {
      const u = byId.get(titanUserId);
      if (!u) {
        results.push({
          titanUserId,
          email: null,
          outcome: 'skipped',
          reason:
            'No existe en Titan, o el usuario técnico no lo ve (políticas de datos de Titan)',
          warnings: [],
        });
        continue;
      }
      try {
        results.push(
          await this.importOne(
            tenantId,
            u,
            phones.get(u.userId),
            dto.roleId,
            areaId,
            unusableHash,
          ),
        );
      } catch (err) {
        this.logger.error(
          `Falló la importación del usuario Titan ${u.userId}`,
          err as Error,
        );
        results.push({
          titanUserId,
          email: u.email,
          outcome: 'skipped',
          reason: `Error inesperado: ${(err as Error).message}`,
          warnings: [],
        });
      }
    }

    await this.prisma.titanConnection.update({
      where: { tenantId },
      data: { lastImportAt: new Date() },
    });

    const count = (o: ImportOutcome) =>
      results.filter((r) => r.outcome === o).length;
    const summary = {
      requested: requested.length,
      created: count('created'),
      linked: count('linked'),
      updated: count('updated'),
      skipped: count('skipped'),
    };
    this.logger.log(
      `Importación desde TitanHR en tenant ${tenantId}: ${JSON.stringify(summary)}`,
    );
    return { summary, results };
  }

  private async importOne(
    tenantId: string,
    u: TitanUser,
    phoneInfo: { phone: string | null; raw: string | null } | undefined,
    roleId: string,
    areaId: string | null,
    passwordHash: string,
  ): Promise<ImportResultRow> {
    const base = { titanUserId: u.userId, email: u.email ?? null };
    const reason = this.ineligibleReason(u);
    if (reason) return { ...base, outcome: 'skipped', reason, warnings: [] };

    const warnings: string[] = [];
    let phone = phoneInfo?.phone ?? null;
    if (!phone) {
      warnings.push(
        phoneInfo?.raw
          ? `Teléfono de Titan no reconocido ("${phoneInfo.raw}"): no va a poder escribirle al bot hasta cargarlo a mano`
          : 'Sin teléfono en Titan: no va a poder escribirle al bot hasta cargarlo a mano',
      );
    }

    const linkData = {
      titanEmail: u.email,
      titanPersonId: u.personId ?? null,
      titanCompanyId: u.companyId ?? null,
      titanCompanyName: u.companyName ?? null,
      titanRoles: this.roleNames(u),
      titanLocked: !!u.locked,
      lastSyncedAt: new Date(),
    };

    // 1) Ya vinculado en esta empresa: refrescar la foto de Titan (roles incluidos).
    const link = await this.prisma.titanUserLink.findUnique({
      where: { tenantId_titanUserId: { tenantId, titanUserId: u.userId } },
      include: { user: { select: { id: true, phone: true } } },
    });
    if (link) {
      await this.prisma.titanUserLink.update({
        where: { id: link.id },
        data: linkData,
      });
      phone = await this.fillPhoneIfEmpty(link.user, phone, warnings);
      return { ...base, outcome: 'updated', phone, warnings };
    }

    // 2) Ya existe en PCI con ese email.
    const existing = await this.prisma.user.findFirst({
      where: {
        email: { equals: u.email, mode: 'insensitive' },
        deletedAt: null,
      },
      select: {
        id: true,
        phone: true,
        tenants: { where: { tenantId }, select: { tenantId: true } },
      },
    });
    if (existing) {
      // Sumar a alguien de otra empresa sería un "alta encubierta", que se quitó a pedido del
      // alta de usuarios (ver UsersService.create): eso se hace explícito desde la edición.
      if (existing.tenants.length === 0) {
        return {
          ...base,
          outcome: 'skipped',
          reason:
            'Ya existe en PCI en otra empresa: sumalo a esta desde la edición del usuario y volvé a importar',
          warnings: [],
        };
      }
      const otherLink = await this.prisma.titanUserLink.findUnique({
        where: { userId_tenantId: { userId: existing.id, tenantId } },
      });
      if (otherLink) {
        return {
          ...base,
          outcome: 'skipped',
          reason: `El usuario de PCI ya está vinculado a otro usuario de Titan (#${otherLink.titanUserId})`,
          warnings: [],
        };
      }
      await this.prisma.titanUserLink.create({
        data: {
          ...linkData,
          userId: existing.id,
          tenantId,
          titanUserId: u.userId,
        },
      });
      phone = await this.fillPhoneIfEmpty(existing, phone, warnings);
      return { ...base, outcome: 'linked', phone, warnings };
    }

    // 3) Alta nueva: usuario + membresía (rol de PCI elegido) + vínculo, todo junto.
    if (phone && (await this.phoneTaken(phone))) {
      warnings.push(
        `El teléfono ${phone} ya lo usa otro usuario de PCI: se importó sin teléfono`,
      );
      phone = null;
    }
    const names = this.splitName(u);
    await this.prisma.user.create({
      data: {
        email: u.email,
        firstName: names.firstName || null,
        lastName: names.lastName || null,
        phone,
        passwordHash,
        tenants: { create: { tenantId, roleId, areaId } },
        titanLinks: {
          create: { ...linkData, tenantId, titanUserId: u.userId },
        },
      },
    });
    return { ...base, outcome: 'created', phone, warnings };
  }

  /** Completa el teléfono de un usuario existente solo si no tenía: nunca pisa uno cargado a mano. */
  private async fillPhoneIfEmpty(
    user: { id: string; phone: string | null },
    phone: string | null,
    warnings: string[],
  ): Promise<string | null> {
    if (user.phone) return user.phone;
    if (!phone) return null;
    if (await this.phoneTaken(phone, user.id)) {
      warnings.push(
        `El teléfono ${phone} ya lo usa otro usuario de PCI: no se cargó`,
      );
      return null;
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { phone } });
    return phone;
  }

  private async phoneTaken(
    phone: string,
    exceptUserId?: string,
  ): Promise<boolean> {
    const owner = await this.prisma.user.findFirst({
      where: {
        phone,
        deletedAt: null,
        ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
      },
      select: { id: true },
    });
    return !!owner;
  }

  // --- Helpers --------------------------------------------------------------------------

  /** Un usuario de Titan es importable si puede loguearse y es una persona (no una cuenta técnica). */
  private ineligibleReason(u: TitanUser): string | null {
    if (!u.email || !u.email.includes('@')) return 'Sin email válido en Titan';
    if (u.locked) return 'Bloqueado en Titan';
    if (!u.personId) return 'Sin persona asociada en Titan (cuenta técnica)';
    return null;
  }

  private roleNames(u: TitanUser): string[] {
    return [
      ...new Set((u.roles ?? []).map((r) => r.name).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b, 'es'));
  }

  private splitName(u: TitanUser): { firstName: string; lastName: string } {
    const first = u.person?.firstName?.trim();
    const last = u.person?.lastName?.trim();
    if (first || last)
      return {
        firstName: (first ?? '').slice(0, 80),
        lastName: (last ?? '').slice(0, 80),
      };
    const parts = (u.name ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: '', lastName: '' };
    if (parts.length === 1)
      return { firstName: parts[0].slice(0, 80), lastName: '' };
    return {
      firstName: parts.slice(0, -1).join(' ').slice(0, 80),
      lastName: parts[parts.length - 1].slice(0, 80),
    };
  }

  /**
   * Elige el teléfono para WhatsApp entre los contactos de la persona: primero celulares,
   * después el principal, después cualquier teléfono. Devuelve el primero que se puede
   * normalizar, y el crudo del mejor candidato para reportar si ninguno sirvió.
   */
  private pickPhone(contacts: TitanContact[]): {
    phone: string | null;
    raw: string | null;
  } {
    const typeText = (c: TitanContact) =>
      `${c.contactType?.value ?? ''} ${c.contactType?.code ?? ''} ${c.phoneType?.value ?? ''}`.toLowerCase();
    const phones = contacts.filter(
      (c) =>
        c.value &&
        !c.value.includes('@') &&
        /\d/.test(c.value) &&
        /tel|cel|m[oó]vil|whats|phone/.test(typeText(c)),
    );
    const isMobile = (c: TitanContact) =>
      /cel|m[oó]vil|whats/.test(typeText(c));
    phones.sort(
      (a, b) =>
        Number(isMobile(b)) - Number(isMobile(a)) ||
        Number(!!b.isPrimary) - Number(!!a.isPrimary),
    );
    for (const c of phones) {
      const normalized = toWhatsappPhone(c.value);
      if (normalized) return { phone: normalized, raw: c.value };
    }
    return { phone: null, raw: phones[0]?.value ?? null };
  }

  private async findActiveUsersByEmail(emails: string[]) {
    const out = new Map<string, { id: string; tenantIds: string[] }>();
    if (emails.length === 0) return out;
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null, email: { in: emails, mode: 'insensitive' } },
      select: {
        id: true,
        email: true,
        tenants: { select: { tenantId: true } },
      },
    });
    for (const u of users)
      out.set(u.email.toLowerCase(), {
        id: u.id,
        tenantIds: u.tenants.map((t) => t.tenantId),
      });
    return out;
  }

  /**
   * El rol de PCI tiene que ser de esta empresa, y nunca el protegido (SuperAdmin): una
   * importación masiva no es el lugar para repartir superusuarios.
   */
  private async assertRoleAssignable(tenantId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId },
      select: { name: true, tenant: { select: { slug: true } } },
    });
    if (!role)
      throw new BadRequestException(
        'El rol no existe o no pertenece a este tenant',
      );
    if (
      isProtectedRole(
        role.name,
        role.tenant.slug,
        systemTenantSlug(this.config),
      )
    ) {
      throw new ForbiddenException(
        'No se puede asignar ese rol en una importación',
      );
    }
  }

  private async resolveCredentials(
    tenantId: string,
  ): Promise<TitanCredentials> {
    const conn = await this.prisma.titanConnection.findUnique({
      where: { tenantId },
    });
    if (!conn || !conn.baseUrl || !conn.itEmail || !conn.itPassword) {
      throw new BadRequestException(
        'Falta configurar la conexión con TitanHR (URL, usuario técnico y contraseña)',
      );
    }
    return {
      baseUrl: conn.baseUrl,
      email: conn.itEmail,
      password: this.cipher.decrypt(conn.itPassword),
    };
  }

  /** Login → trabajo → logout, traduciendo los errores de Titan a un 502 entendible. */
  private async withClient<T>(
    tenantId: string,
    work: (client: TitanClient) => Promise<T>,
  ): Promise<T> {
    const client = new TitanClient(await this.resolveCredentials(tenantId));
    try {
      await client.login();
      return await work(client);
    } catch (err) {
      if (err instanceof TitanApiError) {
        throw new BadRequestException(
          `Error al consultar TitanHR: ${err.message}`,
        );
      }
      throw err;
    } finally {
      await client.logout();
    }
  }

  /**
   * Es una contraseña, no una API key: ni siquiera el enmascarado parcial de
   * `SecretsCipher.mask` (primeros 3 + últimos 4) — solo puntos y el flag `itPasswordIsSet`.
   */
  private toSafeConnection(conn: TitanConnection) {
    return {
      baseUrl: conn.baseUrl,
      itEmail: conn.itEmail,
      itPassword: conn.itPassword ? '••••••••' : '',
      itPasswordIsSet: !!conn.itPassword,
      configured: !!(conn.baseUrl && conn.itEmail && conn.itPassword),
      lastImportAt: conn.lastImportAt,
    };
  }
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
}
