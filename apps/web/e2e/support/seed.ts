/**
 * Siembra de datos para los tests e2e del backoffice, VÍA LA API REAL (`localhost:3101`).
 *
 * El paquete `web` no tiene fixtures de Prisma como el backend (`apps/api/test/support/scenario.ts`),
 * así que todo dato de prueba se monta por HTTP contra la API aislada, autenticándose como el
 * SuperAdmin del seed. El único dato preexistente del que se depende es ese SuperAdmin
 * (`admin@pci.local` del seed); el resto —empresas, roles, usuarios, settings— lo crea cada test
 * en su propio setup.
 *
 * Siembra cross-tenant: el SuperAdmin del sistema puede crear roles y usuarios en CUALQUIER
 * empresa, aunque no sea miembro. `TenantGuard` tiene una excepción para el superusuario del
 * sistema (`resolveAsSystemUser`): mandando `X-Tenant-Id: <empresa destino>`, el backend lo deja
 * operar en esa empresa igual que en la propia, y `RolesGuard` lo pasa sin mirar permisos por su
 * rol protegido. Por eso `createRole` / `createUserWithPermissions` aceptan un `tenantId` destino
 * (default: la empresa de sistema) y siembran ahí, sea o no la de sistema. `POST /users/multi`
 * (SystemTenantGuard) va siempre con el header de sistema, pero las membresías del body pueden
 * apuntar a cualquier empresa: `assertCanManageUsersInTenant` también deja pasar al superusuario.
 */
import { API_URL } from './ports';

/**
 * Credenciales del SuperAdmin del seed. Son el default documentado del seed
 * (`apps/api/prisma/seed.ts`), no un secreto: se pueden pisar por entorno para no fijar un
 * literal si algún día el seed cambia.
 */
export const SEED_ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? 'admin@pci.local',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'changeme123',
};

/** Slug de la empresa de sistema; tiene que coincidir con el backend y el frontend. */
export const SYSTEM_TENANT_SLUG =
  process.env.NEXT_PUBLIC_SYSTEM_TENANT_SLUG ?? process.env.SYSTEM_TENANT_SLUG ?? 'system';

/**
 * User-Agent estable para los logins de siembra. El fingerprint de dispositivo del backend es
 * teléfono + User-Agent: al sembrar un device con ESTE UA (distinto del Chromium real del
 * navegador), el login por la UI queda con un fingerprint que no matchea y dispara el OTP
 * (necesario para FE-LOG-03/04/05/07). Además es consistente entre llamadas, así el device del
 * admin sembrado siempre valida y el login de siembra nunca cae en un OTP.
 */
export const SEED_USER_AGENT = 'pci-e2e-seed-agent';

// --- Identificadores únicos (los campos globales de User y el slug de Tenant son @unique) ---

let counter = 0;
function uid(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
export function uniqueSlug(prefix = 'e2e'): string {
  return `${prefix}-${uid()}`.toLowerCase();
}
export function uniqueEmail(prefix = 'e2e'): string {
  return `${prefix}-${uid()}@e2e.local`;
}
export function uniquePhone(): string {
  return `+549${Math.floor(100000000 + Math.random() * 899999999)}`;
}
/** Contraseña de prueba única (≥8 chars). Nunca un literal reutilizado entre usuarios. */
export function uniquePassword(): string {
  return `Pw-${uid()}-Aa1`;
}

// --- Cliente HTTP mínimo contra la API aislada ---

interface ReqOpts {
  method?: string;
  token?: string;
  tenantId?: string;
  body?: unknown;
  userAgent?: string;
}

async function req(path: string, opts: ReqOpts = {}): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.tenantId) headers['X-Tenant-Id'] = opts.tenantId;
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent;

  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`[seed] ${opts.method ?? 'GET'} ${path} → ${res.status}: ${detail}`);
  }
  return data;
}

// --- Login de bajo nivel (POST /auth/login real) ---

export interface LoginResult {
  step: string;
  accessToken?: string;
  message?: string;
}

/**
 * `POST /auth/login` crudo. `userAgent` fija el header para controlar el fingerprint de
 * dispositivo (ver `SEED_USER_AGENT`). Devuelve el cuerpo tal cual: puede ser
 * `{ step: 'authenticated', accessToken }` o `{ step: 'otp_required' }`.
 */
export async function apiLogin(
  email: string,
  password: string,
  opts: { userAgent?: string } = {},
): Promise<LoginResult> {
  return req('/auth/login', {
    method: 'POST',
    body: { email, password },
    userAgent: opts.userAgent ?? SEED_USER_AGENT,
  });
}

// --- Contexto del SuperAdmin (token + id de la empresa de sistema) ---

export interface AdminCtx {
  token: string;
  systemTenantId: string;
}

/**
 * Autentica al SuperAdmin del seed y resuelve el id de la empresa de sistema (que exigen los
 * endpoints cross-tenant y el header `X-Tenant-Id` de las operaciones globales).
 */
export async function adminContext(): Promise<AdminCtx> {
  const login = await apiLogin(SEED_ADMIN.email, SEED_ADMIN.password);
  if (!login.accessToken) {
    throw new Error(`[seed] El login del admin no devolvió token (step=${login.step}).`);
  }
  const me = await req('/auth/me', { token: login.accessToken });
  const sys = me.tenants?.find(
    (t: { tenant: { slug: string; id: string } }) => t.tenant.slug === SYSTEM_TENANT_SLUG,
  );
  if (!sys) {
    throw new Error('[seed] El admin del seed no es miembro de la empresa de sistema.');
  }
  return { token: login.accessToken, systemTenantId: sys.tenant.id };
}

// --- Altas ---

export interface SeededTenant {
  id: string;
  name: string;
  slug: string;
}

/** Crea una empresa (`POST /tenants`, solo SuperAdmin en contexto de sistema). */
export async function createTenant(
  admin: AdminCtx,
  opts: { name?: string; slug?: string } = {},
): Promise<SeededTenant> {
  const slug = opts.slug ?? uniqueSlug('emp');
  const name = opts.name ?? `Empresa ${slug}`;
  return req('/tenants', {
    method: 'POST',
    token: admin.token,
    tenantId: admin.systemTenantId,
    body: { name, slug },
  });
}

/**
 * Crea un rol en la empresa `tenantId` (default: la de sistema) con los permisos indicados.
 * Funciona en CUALQUIER empresa por el bypass del superusuario en `TenantGuard` (se manda su id
 * en `X-Tenant-Id`). Los permisos van como `'recurso:accion'` y se aplican con un
 * `PUT /roles/:id/permissions` posterior (el `POST /roles` solo acepta el nombre).
 */
export async function createRole(
  admin: AdminCtx,
  opts: { tenantId?: string; name?: string; permissions?: string[] } = {},
): Promise<{ id: string; name: string }> {
  const tenantId = opts.tenantId ?? admin.systemTenantId;
  const name = opts.name ?? `Rol ${uniqueSlug('r')}`;
  const role = await req('/roles', {
    method: 'POST',
    token: admin.token,
    tenantId,
    body: { name },
  });
  const permissions = (opts.permissions ?? []).map((p) => {
    const [resource, action] = p.split(':');
    return { resource, action };
  });
  if (permissions.length > 0) {
    await req(`/roles/${role.id}/permissions`, {
      method: 'PUT',
      token: admin.token,
      tenantId,
      body: { permissions },
    });
  }
  return role;
}

export interface SeededUser {
  email: string;
  password: string;
  phone: string;
}

/**
 * Crea un usuario (`POST /users/multi`, solo SuperAdmin) con las membresías indicadas. Devuelve
 * las credenciales en claro (email + contraseña generada) para poder loguearlo después por la UI
 * o por la API. La contraseña es única por usuario, generada acá; nunca un literal fijo.
 */
export async function createUser(
  admin: AdminCtx,
  opts: {
    memberships: Array<{ tenantId: string; roleId: string; areaId?: string }>;
    email?: string;
    password?: string;
    phone?: string;
    firstName?: string;
    lastName?: string;
  },
): Promise<SeededUser> {
  const email = opts.email ?? uniqueEmail('user');
  const password = opts.password ?? uniquePassword();
  const phone = opts.phone ?? uniquePhone();
  await req('/users/multi', {
    method: 'POST',
    token: admin.token,
    tenantId: admin.systemTenantId,
    body: {
      email,
      firstName: opts.firstName ?? 'Test',
      lastName: opts.lastName ?? 'E2E',
      password,
      phone,
      memberships: opts.memberships,
    },
  });
  return { email, password, phone };
}

/**
 * Atajo: crea un usuario común en la empresa `tenantId` (default: la de sistema) con un rol de
 * los permisos indicados. Sirve para cualquier empresa gracias al bypass del superusuario.
 */
export async function createUserWithPermissions(
  admin: AdminCtx,
  permissions: string[],
  opts: { tenantId?: string } = {},
): Promise<SeededUser & { roleId: string; tenantId: string }> {
  const tenantId = opts.tenantId ?? admin.systemTenantId;
  const role = await createRole(admin, { tenantId, permissions });
  const user = await createUser(admin, {
    memberships: [{ tenantId, roleId: role.id }],
  });
  return { ...user, roleId: role.id, tenantId };
}

// --- Settings globales ---

/** Fija un setting (`PATCH /settings/:key`, contexto de sistema + `settings:update`). */
export async function setSetting(admin: AdminCtx, key: string, value: string): Promise<void> {
  await req(`/settings/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    token: admin.token,
    tenantId: admin.systemTenantId,
    body: { value },
  });
}

/** Borra un setting (vuelve a resolver por env/default). */
export async function deleteSetting(admin: AdminCtx, key: string): Promise<void> {
  await req(`/settings/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    token: admin.token,
    tenantId: admin.systemTenantId,
  });
}
