'use client';

import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';

interface User {
  id: string;
  email: string;
  name: string | null;
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
  login: (email: string, password: string, tenantId?: string) => Promise<{ step: string; message?: string; accessToken?: string }>;
  verifyOtp: (code: string) => Promise<void>;
  logout: () => void;
  hasPermission: (resource: string, action: string) => boolean;
  activeTenant: string | null;
  setActiveTenant: (id: string) => void;
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
      const firstTenant = tenantId || data.tenants?.[0]?.tenantId;
      if (firstTenant) {
        setActiveTenantState(firstTenant);
        localStorage.setItem('activeTenant', firstTenant);
      }
    } catch {
      logout();
    }
  }

  const login = useCallback(async (email: string, password: string, tenantId?: string) => {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      headers: { 'User-Agent': 'PCI-Web' },
      body: JSON.stringify({ email, password, tenantId }),
    });

    if (data.step === 'authenticated' && data.accessToken) {
      localStorage.setItem('token', data.accessToken);
      setToken(data.accessToken);
      await fetchUser(data.accessToken, tenantId);
    }

    return data;
  }, []);

  const verifyOtp = useCallback(async (code: string) => {
    const data = await apiFetch('/auth/verify-otp', {
      method: 'POST',
      headers: { 'User-Agent': 'PCI-Web' },
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
    setToken(null);
    setUser(null);
    setActiveTenantState(null);
    window.location.href = '/login';
  }, []);

  const setActiveTenant = useCallback((id: string) => {
    setActiveTenantState(id);
    localStorage.setItem('activeTenant', id);
  }, []);

  const hasPermission = useCallback(
    (resource: string, action: string) => {
      if (!user || !activeTenant) return false;
      const tenant = user.tenants?.find((t) => t.tenantId === activeTenant);
      return tenant?.role?.permissions?.some(
        (p) => p.resource === resource && p.action === action,
      ) ?? false;
    },
    [user, activeTenant],
  );

  return (
    <AuthContext.Provider
      value={{ user, token, isLoading, login, verifyOtp, logout, hasPermission, activeTenant, setActiveTenant }}
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
