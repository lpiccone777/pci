import { ALL_TENANTS, SYSTEM_TENANT_ID_KEY } from './system-tenant';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

/**
 * El id de empresa que va en `X-Tenant-Id`. Normalmente es el tenant activo tal cual, pero
 * el centinela "Todas las empresas" no es una empresa: se traduce al id de la empresa de
 * sistema, que es lo que `SystemTenantGuard` exige como empresa activa para responder los
 * endpoints cross-tenant (`/users/all`, etc.). Las pantallas, aparte, deciden pegar contra
 * los endpoints `/all` cuando están en ese modo.
 */
function getActiveTenant(): string | null {
  if (typeof window === 'undefined') return null;
  const active = localStorage.getItem('activeTenant');
  if (active === ALL_TENANTS) {
    return localStorage.getItem(SYSTEM_TENANT_ID_KEY);
  }
  return active;
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const token = getToken();
  const tenantId = getActiveTenant();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // El tenant activo viaja por request, no dentro del JWT: cambiar de tenant
  // no requiere reemitir el token (ver TenantGuard en el backend).
  if (tenantId) headers['X-Tenant-Id'] = tenantId;

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: 'Error desconocido' }));
    throw new Error(err.message || `HTTP ${res.status}`);
  }

  return res.json();
}
