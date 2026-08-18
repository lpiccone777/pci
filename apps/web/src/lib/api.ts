import {
  ALL_TENANTS,
  ALL_TENANTS_CACHE_KEY,
  FALLBACK_TENANT_ID_KEY,
  SYSTEM_TENANT_ID_KEY,
} from './system-tenant';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

/**
 * Limpia toda la sesión guardada y manda a `/login`. Única fuente de verdad de qué se borra
 * (antes duplicado acá y en `useAuth().logout`) — la usan tanto el logout manual (botón
 * "Cerrar sesión") como `apiFetch` cuando detecta que el token dejó de servir (ver más abajo).
 */
export function clearSession() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('token');
  localStorage.removeItem('activeTenant');
  localStorage.removeItem(ALL_TENANTS_CACHE_KEY);
  localStorage.removeItem(SYSTEM_TENANT_ID_KEY);
  localStorage.removeItem(FALLBACK_TENANT_ID_KEY);
  window.location.href = '/login';
}

/**
 * El id de empresa que va en `X-Tenant-Id`. Normalmente es el tenant activo tal cual, pero
 * el centinela "Todas las empresas" no es una empresa: se traduce a un id real que sirva de
 * empresa activa. Para el superadmin es la empresa de sistema (lo que exige
 * `SystemTenantGuard` en los endpoints cross-tenant `/all`); para el usuario común, que no
 * es miembro del sistema, es su empresa de respaldo, así `TenantGuard` no rechaza la
 * request. Las pantallas, aparte, eligen el endpoint (`/all` vs `/mine`) según el modo.
 */
function getActiveTenant(): string | null {
  if (typeof window === 'undefined') return null;
  const active = localStorage.getItem('activeTenant');
  if (active === ALL_TENANTS) {
    return (
      localStorage.getItem(SYSTEM_TENANT_ID_KEY) ||
      localStorage.getItem(FALLBACK_TENANT_ID_KEY)
    );
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
  // no requiere reemitir el token (ver TenantGuard en el backend). Si quien llama ya fijó
  // un `X-Tenant-Id` (una operación sobre la empresa de una fila puntual, distinta del
  // selector), se respeta ese y no se pisa con el activo.
  if (tenantId && !headers['X-Tenant-Id']) headers['X-Tenant-Id'] = tenantId;

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  // Sesión deslizante: en cada request autenticado, `SlidingSessionInterceptor` (backend)
  // reemite un JWT fresco de 15 minutos en este header — mientras haya actividad real, la
  // sesión nunca vence. Guardarlo acá alcanza: el próximo `apiFetch` ya lee el nuevo de
  // `localStorage` vía `getToken()`, no hace falta tocar el estado de React.
  const refreshedToken = res.headers.get('X-Access-Token');
  if (refreshedToken && typeof window !== 'undefined') localStorage.setItem('token', refreshedToken);

  // Sesión inválida/expirada: el 401 llegó respondiendo a un request que SÍ mandaba token, así
  // que no es un intento de login/OTP con credenciales mal escritas (esas requests no mandan
  // Authorization, y su propio 401 lo maneja la pantalla de login como error de credenciales,
  // no como sesión caída). Antes esto quedaba sin manejar: la pantalla en uso seguía mostrando
  // datos viejos o fallando en silencio hasta que el usuario recargaba la página a mano — recién
  // ahí `AuthProvider` volvía a llamar `/auth/me`, fallaba, y se disparaba el logout.
  if (res.status === 401 && token) {
    clearSession();
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: 'Error desconocido' }));
    // Se conserva `err.message` como siempre (los consumidores lo leen), pero además se cuelga
    // el cuerpo completo y el status: algunos errores (p. ej. un campo global en uso) traen
    // datos extra —`field`, `conflict`— que la pantalla necesita para mostrar el detalle.
    const error = new Error(body?.message || `HTTP ${res.status}`) as Error & {
      status?: number;
      body?: any;
    };
    error.status = res.status;
    error.body = body;
    throw error;
  }

  return res.json();
}
