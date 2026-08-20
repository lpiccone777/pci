'use client';

import { useState, useEffect, useCallback, useMemo, createContext, useContext, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession } from '@/lib/api';
import {
  ALL_TENANTS,
  FALLBACK_TENANT_ID_KEY,
  SYSTEM_TENANT_ID_KEY,
  SYSTEM_TENANT_SLUG,
} from '@/lib/system-tenant';

interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /**
   * Superusuario del sistema: rol SuperAdmin en el tenant de sistema. Lo calcula el backend
   * en `/auth/me` (misma lógica que los guards cross-tenant); el frontend nunca lo deduce por
   * pertenencia, porque un usuario común puede ser miembro del tenant de sistema con otro rol.
   */
  isSuperAdmin: boolean;
  tenants: Array<{
    tenantId: string;
    tenant: { id: string; name: string; slug: string };
    role: { id: string; name: string; permissions: Array<{ resource: string; action: string }> };
  }>;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ step: string; message?: string; accessToken?: string }>;
  verifyOtp: (code: string) => Promise<void>;
  logout: () => void;
  hasPermission: (resource: string, action: string) => boolean;
  /**
   * Igual que `hasPermission` pero para una empresa puntual, no la activa. Lo usa la vista
   * "Todas las empresas", donde cada fila es de una empresa distinta y los botones (editar,
   * eliminar) dependen del permiso que el usuario tiene EN esa empresa. El superusuario del
   * sistema, que puede operar en cualquiera, cae a su rol de sistema para empresas donde no
   * es miembro.
   */
  hasPermissionInTenant: (tenantId: string, resource: string, action: string) => boolean;
  activeTenant: string | null;
  setActiveTenant: (id: string) => void;
  /**
   * Superusuario del sistema (rol SuperAdmin en el tenant de sistema): puede pararse en
   * cualquier empresa y operar cross-tenant. Un usuario común miembro del tenant de sistema
   * NO lo es. Ver `isSuperAdmin` en el modelo `User`.
   */
  isSuperAdmin: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTenant, setActiveTenantState] = useState<string | null>(null);

  useEffect(() => {
    const savedToken = localStorage.getItem('token');
    const savedTenant = localStorage.getItem('activeTenant');
    if (savedToken) {
      setToken(savedToken);
      fetchUser(savedToken, savedTenant).finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, []);

  async function fetchUser(tkn: string, tenantId?: string | null) {
    try {
      const data = await apiFetch('/auth/me', {
        headers: { Authorization: `Bearer ${tkn}` },
      });
      setUser(data);

      // El id de la empresa de sistema lo necesita `apiFetch` para traducir el centinela
      // "Todas las empresas" al header que exige `SystemTenantGuard`. Se guarda acá, donde
      // ya tenemos las membresías con su slug.
      const systemTenantId = data.tenants?.find(
        (t: { tenant: { slug: string; id: string } }) =>
          t.tenant.slug === SYSTEM_TENANT_SLUG,
      )?.tenant.id;
      if (systemTenantId) {
        localStorage.setItem(SYSTEM_TENANT_ID_KEY, systemTenantId);
      }

      // Empresa de respaldo para el header en modo "Todas las empresas" del usuario común:
      // su primera membresía. Ver `FALLBACK_TENANT_ID_KEY` y `apiFetch`.
      const fallbackTenantId = data.tenants?.[0]?.tenantId;
      if (fallbackTenantId) {
        localStorage.setItem(FALLBACK_TENANT_ID_KEY, fallbackTenantId);
      }

      const firstTenant = tenantId || data.tenants?.[0]?.tenantId;
      if (firstTenant) {
        setActiveTenantState(firstTenant);
        localStorage.setItem('activeTenant', firstTenant);
      }
    } catch {
      logout();
    }
  }

  const login = useCallback(async (email: string, password: string) => {
    // No seteamos User-Agent a mano: el browser manda el suyo, que es el que necesita
    // el fingerprint de dispositivo. Fijarlo lo rompía (todos los navegadores del mismo
    // usuario daban un fingerprint idéntico) y además el preflight CORS lo rechazaba.
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    if (data.step === 'authenticated' && data.accessToken) {
      localStorage.setItem('token', data.accessToken);
      setToken(data.accessToken);
      await fetchUser(data.accessToken);
    }

    return data;
  }, []);

  const verifyOtp = useCallback(async (code: string) => {
    // Mismo criterio que en login: el User-Agent lo pone el browser.
    const data = await apiFetch('/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });

    if (data.step === 'authenticated' && data.accessToken) {
      localStorage.setItem('token', data.accessToken);
      setToken(data.accessToken);
      await fetchUser(data.accessToken);
    }
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setActiveTenantState(null);
    // Limpia localStorage y redirige a /login — misma función que usa `apiFetch` cuando un
    // 401 en un request autenticado detecta la sesión caída, así no hay dos lugares
    // borrando (y potencialmente desincronizando) la misma lista de keys.
    clearSession();
  }, []);

  const setActiveTenant = useCallback((id: string) => {
    // No tocamos el estado de React antes de recargar. Cambiarlo dispara un re-render que
    // vuelve a lanzar los fetch de la pantalla con el tenant nuevo, y la recarga los aborta
    // a mitad de camino: ese era el "NetworkError" en rojo que se alcanzaba a ver al cambiar
    // de empresa. La recarga sola alcanza —el API opera por el header X-Tenant-Id, no por el
    // JWT—, y el tenant activo se relee de localStorage al montar.
    localStorage.setItem('activeTenant', id);
    window.location.reload();
  }, []);

  const isSuperAdmin = useMemo(() => !!user?.isSuperAdmin, [user]);

  /**
   * El vínculo con el que se resuelven los permisos.
   *
   * Normalmente es el de la empresa activa. Cuando el superusuario del sistema está parado
   * en una empresa de la que no es miembro no hay vínculo con ella, así que manda el rol
   * que tiene en la empresa de sistema — el mismo criterio que aplica `RolesGuard` en el
   * backend. Sin este respaldo, cambiar de empresa dejaría el menú vacío y todos los
   * botones escondidos, aunque el API los siga aceptando.
   */
  const activeMembership = useMemo(() => {
    if (!user || !activeTenant) return null;
    const direct = user.tenants?.find((t) => t.tenantId === activeTenant);
    if (direct) return direct;
    // Respaldo SOLO para el superusuario: parado en una empresa de la que no es miembro,
    // manda su rol de sistema. Un usuario común nunca llega acá (el selector solo lista sus
    // empresas), y si llegara no debe heredar el rol de sistema aunque pertenezca a él.
    if (!user.isSuperAdmin) return null;
    return user.tenants?.find((t) => t.tenant.slug === SYSTEM_TENANT_SLUG) ?? null;
  }, [user, activeTenant]);

  const hasPermission = useCallback(
    (resource: string, action: string) => {
      // En "Todas las empresas" no hay una única empresa activa: el permiso alcanza para el
      // menú y los botones globales (como "Nuevo usuario") si el usuario lo tiene en alguna
      // de sus empresas. El corte fino por empresa lo hace `hasPermissionInTenant` en cada
      // fila. El superusuario del sistema tiene su rol de sistema entre las membresías, así
      // que este `some` le da todos los permisos igual.
      if (activeTenant === ALL_TENANTS) {
        return (
          user?.tenants?.some((t) =>
            t.role?.permissions?.some(
              (p) => p.resource === resource && p.action === action,
            ),
          ) ?? false
        );
      }
      return (
        activeMembership?.role?.permissions?.some(
          (p) => p.resource === resource && p.action === action,
        ) ?? false
      );
    },
    [activeMembership, activeTenant, user],
  );

  const hasPermissionInTenant = useCallback(
    (tenantId: string, resource: string, action: string) => {
      // El vínculo con esa empresa; si no es miembro y es el superusuario del sistema operando
      // sobre otra empresa, cae a su rol de sistema — mismo respaldo (y misma condición) que
      // `activeMembership`. El usuario común no hereda el rol de sistema aunque pertenezca a él.
      const direct = user?.tenants?.find((t) => t.tenantId === tenantId);
      const membership =
        direct ??
        (user?.isSuperAdmin
          ? user?.tenants?.find((t) => t.tenant.slug === SYSTEM_TENANT_SLUG)
          : undefined);
      return (
        membership?.role?.permissions?.some(
          (p) => p.resource === resource && p.action === action,
        ) ?? false
      );
    },
    [user],
  );

  return (
    <AuthContext.Provider
      value={{ user, token, isLoading, login, verifyOtp, logout, hasPermission, hasPermissionInTenant, activeTenant, setActiveTenant, isSuperAdmin }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
