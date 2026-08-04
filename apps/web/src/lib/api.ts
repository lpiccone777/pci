export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

function getActiveTenant(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('activeTenant');
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
