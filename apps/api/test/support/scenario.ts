/**
 * Constructores de fixtures del Apéndice C del plan de pruebas.
 *
 * El seed solo deja el tenant de sistema, el rol `SuperAdmin` y `admin@pci.local`. Todo el
 * resto del escenario (empresas, roles, personas, áreas, flujos, skills, fuentes) lo arma cada
 * test con estos helpers, en un `beforeAll`/`beforeEach`.
 *
 * ## Aislamiento entre specs (LEER)
 *
 * Todos los specs corren SERIALMENTE (`maxWorkers: 1`) contra **la misma** base efímera. Por
 * eso:
 *  - Los 4 campos únicos de `User` (`email`, `phone`, `internalPhone`, `invgateUserId`) son
 *    **únicos GLOBALES**: usá `uniqueEmail()`/`uniquePhone()` o valores propios del spec, nunca
 *    un literal que otro archivo pueda repetir.
 *  - El `slug` de `Tenant` es único global: usá `uniqueSlug('acme')`.
 *  - `Role.name`, `Area.name`, `Skill.name`, `ContextSource.name` son únicos POR empresa: como
 *    cada spec crea sus propias empresas, no chocan entre archivos.
 *  - `Setting.key` es único global: si tocás un setting (p. ej. `OTP_ENABLED`), seteálo en
 *    `beforeEach` y limpiálo en `afterEach` para no contaminar otros specs.
 */
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../src/prisma/prisma.service';

export const DEFAULT_PASSWORD = 'Password123!';

let counter = 0;
/** Token corto y único dentro de la corrida (Date.now está permitido en tests, no en workflows). */
export function uid(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}

export const uniqueSlug = (label = 'tenant') => `${label}-${uid()}`;
export const uniqueEmail = (label = 'user') => `${label}-${uid()}@e2e.test`;
/** Teléfono E.164 sintético único (prefijo +5491 + 8 dígitos derivados del contador/tiempo). */
export function uniquePhone(): string {
  const n = (Date.now() % 100000000) + counter++;
  return `+5491${n.toString().padStart(8, '0').slice(-8)}`;
}

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}

// --- Empresas ---

export function createTenant(
  prisma: PrismaService,
  opts: { slug: string; name?: string; deletedAt?: Date | null },
) {
  return prisma.tenant.create({
    data: { slug: opts.slug, name: opts.name ?? opts.slug, deletedAt: opts.deletedAt ?? null },
  });
}

/** El tenant de sistema y el admin del seed (siempre presentes). Slug de `SYSTEM_TENANT_SLUG` o `system`. */
export async function getSystemContext(prisma: PrismaService) {
  const slug = process.env.SYSTEM_TENANT_SLUG || 'system';
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@pci.local' } });
  return { tenant, admin, systemSlug: slug };
}

// --- Roles y permisos ---

/** `'users:read'` o `{ resource, action }`. */
export type PermSpec = string | { resource: string; action: string };

function parsePerm(p: PermSpec): { resource: string; action: string } {
  if (typeof p === 'string') {
    const [resource, action] = p.split(':');
    return { resource, action };
  }
  return p;
}

export async function grantPermissions(
  prisma: PrismaService,
  roleId: string,
  perms: PermSpec[],
): Promise<void> {
  for (const p of perms) {
    const { resource, action } = parsePerm(p);
    await prisma.rolePermission.create({ data: { roleId, resource, action } });
  }
}

export async function createRole(
  prisma: PrismaService,
  opts: { tenantId: string; name: string; permissions?: PermSpec[] },
) {
  const role = await prisma.role.create({ data: { name: opts.name, tenantId: opts.tenantId } });
  if (opts.permissions?.length) await grantPermissions(prisma, role.id, opts.permissions);
  return role;
}

// --- Áreas ---

export function createArea(prisma: PrismaService, opts: { tenantId: string; name: string }) {
  return prisma.area.create({ data: { name: opts.name, tenantId: opts.tenantId } });
}

// --- Personas ---

export interface MembershipSpec {
  tenantId: string;
  roleId: string;
  areaId?: string | null;
}

export async function createUser(
  prisma: PrismaService,
  opts: {
    email: string;
    password?: string;
    phone?: string | null;
    internalPhone?: string | null;
    invgateUserId?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    deletedAt?: Date | null;
    memberships?: MembershipSpec[];
  },
) {
  const passwordHash = await hashPassword(opts.password ?? DEFAULT_PASSWORD);
  const user = await prisma.user.create({
    data: {
      email: opts.email,
      passwordHash,
      phone: opts.phone ?? null,
      internalPhone: opts.internalPhone ?? null,
      invgateUserId: opts.invgateUserId ?? null,
      firstName: opts.firstName ?? null,
      lastName: opts.lastName ?? null,
      deletedAt: opts.deletedAt ?? null,
    },
  });
  for (const m of opts.memberships ?? []) {
    await prisma.userTenant.create({
      data: { userId: user.id, tenantId: m.tenantId, roleId: m.roleId, areaId: m.areaId ?? null },
    });
  }
  return user;
}

// --- Flujos ---

export interface FlowAssignment {
  tenantId: string;
  isStart?: boolean;
  roleIds?: string[];
}

export async function createFlow(
  prisma: PrismaService,
  opts: {
    name: string;
    nodes?: unknown[];
    edges?: unknown[];
    isDefault?: boolean;
    isActive?: boolean;
    context?: string;
    contextSourceId?: string | null;
    skillId?: string | null;
    description?: string | null;
    assign?: FlowAssignment[];
  },
) {
  const flow = await prisma.flow.create({
    data: {
      name: opts.name,
      description: opts.description ?? null,
      nodes: (opts.nodes ?? []) as never,
      edges: (opts.edges ?? []) as never,
      isDefault: opts.isDefault ?? false,
      isActive: opts.isActive ?? true,
      context: opts.context ?? 'none',
      contextSourceId: opts.contextSourceId ?? null,
      skillId: opts.skillId ?? null,
    },
  });
  for (const a of opts.assign ?? []) {
    const tf = await prisma.tenantFlow.create({
      data: { flowId: flow.id, tenantId: a.tenantId, isStart: a.isStart ?? false },
    });
    for (const roleId of a.roleIds ?? []) {
      await prisma.tenantFlowRole.create({ data: { tenantFlowId: tf.id, roleId } });
    }
  }
  return flow;
}

// --- Skills ---

export function createSkill(
  prisma: PrismaService,
  opts: { tenantId: string; name: string; promptText: string; isActive?: boolean },
) {
  return prisma.skill.create({
    data: {
      tenantId: opts.tenantId,
      name: opts.name,
      promptText: opts.promptText,
      isActive: opts.isActive ?? true,
    },
  });
}

// --- Fuentes de verdad ---

export function createContextSource(
  prisma: PrismaService,
  opts: {
    tenantId: string;
    name: string;
    type: string;
    config?: Record<string, unknown>;
    isActive?: boolean;
  },
) {
  return prisma.contextSource.create({
    data: {
      tenantId: opts.tenantId,
      name: opts.name,
      type: opts.type,
      config: (opts.config ?? {}) as never,
      isActive: opts.isActive ?? true,
    },
  });
}

// --- Settings (globales: setear en beforeEach, limpiar en afterEach) ---

export async function setSetting(prisma: PrismaService, key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

export async function deleteSetting(prisma: PrismaService, key: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key } });
}
