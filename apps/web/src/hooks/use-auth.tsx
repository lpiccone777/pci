'use client';

import { useState, useEffect, useCallback, useMemo, createContext, useContext, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import {
  ALL_TENANTS_CACHE_KEY,
  SYSTEM_TENANT_ID_KEY,
  SYSTEM_TENANT_SLUG,
} from '@/lib/system-tenant';

interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
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
  activeTenant: string | null;
  setActiveTenant: (id: string) => void;
  /** Pertenece a la empresa de sistema: puede pararse en cualquier otra empresa. */
  isSystemUser: boolean;
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
    localStorage.removeItem('token');
    localStorage.removeItem('activeTenant');
    localStorage.removeItem(ALL_TENANTS_CACHE_KEY);
    localStorage.removeItem(SYSTEM_TENANT_ID_KEY);
    setToken(null);
    setUser(null);
    setActiveTenantState(null);
    window.location.href = '/login';
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

  const isSystemUser = useMemo(
    () => !!user?.tenants?.some((t) => t.tenant.slug === SYSTEM_TENANT_SLUG),
    [user],
  );

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
    return (
      user.tenants?.find((t) => t.tenantId === activeTenant) ??
      user.tenants?.find((t) => t.tenant.slug === SYSTEM_TENANT_SLUG) ??
      null
    );
  }, [user, activeTenant]);

  const hasPermission = useCallback(
    (resource: string, action: string) =>
      activeMembership?.role?.permissions?.some(
        (p) => p.resource === resource && p.action === action,
      ) ?? false,
    [activeMembership],
  );

  return (
    <AuthContext.Provider
      value={{ user, token, isLoading, login, verifyOtp, logout, hasPermission, activeTenant, setActiveTenant, isSystemUser }}
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
