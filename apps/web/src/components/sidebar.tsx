'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { apiFetch } from '@/lib/api';
import {
  ALL_TENANTS,
  ALL_TENANTS_CACHE_KEY,
  SYSTEM_TENANT_SLUG,
} from '@/lib/system-tenant';

interface TenantOption {
  id: string;
  name: string;
}

interface MenuItem {
  label: string;
  href: string;
  resource: string;
  action: string;
  /** Solo visible con el tenant de sistema activo (ver SystemTenantGuard en el API). */
  systemTenantOnly?: boolean;
}

const menuDefinition: MenuItem[] = [
  { label: 'Dashboard', href: '/dashboard', resource: 'metrics', action: 'read' },
  { label: 'Usuarios', href: '/dashboard/users', resource: 'users', action: 'read' },
  {
    label: 'Tenants',
    href: '/dashboard/tenants',
    resource: 'tenants',
    action: 'read',
    // La pantalla lista desde `/tenants/all`, que solo responde parado en la empresa de
    // sistema. Sin esta marca, un rol no-sistema con `tenants:read` veía la opción y caía
    // en un 403 al entrar.
    systemTenantOnly: true,
  },
  { label: 'Áreas', href: '/dashboard/areas', resource: 'areas', action: 'read' },
  { label: 'Roles', href: '/dashboard/roles', resource: 'roles', action: 'read' },
  { label: 'Flujos IVR', href: '/dashboard/flows', resource: 'flows', action: 'read' },
  {
    label: 'Fuentes de Verdad',
    href: '/dashboard/context-sources',
    resource: 'context-sources',
    action: 'read',
  },
  {
    label: 'Configuración',
    href: '/settings',
    resource: 'settings',
    action: 'read',
    systemTenantOnly: true,
  },
];

export default function Sidebar() {
  const { user, hasPermission, logout, activeTenant, setActiveTenant, isSystemUser } =
    useAuth();
  const pathname = usePathname();
  const [allTenants, setAllTenants] = useState<TenantOption[] | null>(null);

  const activeSlug = user?.tenants?.find((t) => t.tenantId === activeTenant)?.tenant?.slug;
  const isAllTenants = activeTenant === ALL_TENANTS;
  // "Todas las empresas" ahora la tienen dos perfiles distintos: el superadmin (todas las del
  // sistema) y el usuario común con varias empresas (solo las suyas). Solo el primero es
  // contexto de sistema: es el único que ve los ítems solo-sistema (Tenants, Configuración) y
  // el único que puede pedir `/tenants/all`. Para el usuario común, "Todas mis empresas" es
  // una vista consolidada de las propias, no un pase a la administración global.
  const isSystemContext =
    activeSlug === SYSTEM_TENANT_SLUG || (isAllTenants && isSystemUser);
  // Puede consolidar varias empresas en el selector: el superadmin siempre; el usuario común
  // solo si pertenece a más de una.
  const canSeeAllOption = isSystemUser || (user?.tenants?.length ?? 0) > 1;

  /**
   * El superusuario puede pararse en cualquier empresa, así que el selector no puede
   * armarse solo con sus membresías. La lista completa solo se puede pedir estando en la
   * empresa de sistema, por eso se guarda: apenas salta a otra, el pedido daría 403 y sin
   * la copia guardada el selector se quedaría sin opciones y no habría cómo volver.
   */
  useEffect(() => {
    if (!isSystemUser) return;

    if (!isSystemContext) {
      try {
        const cached = localStorage.getItem(ALL_TENANTS_CACHE_KEY);
        if (cached) setAllTenants(JSON.parse(cached));
      } catch {
        // Copia ilegible: se cae a las membresías, que siempre incluyen la de sistema.
      }
      return;
    }

    apiFetch('/tenants/all')
      .then((list: TenantOption[]) => {
        setAllTenants(list);
        localStorage.setItem(ALL_TENANTS_CACHE_KEY, JSON.stringify(list));
      })
      .catch(() => {
        // Sin la lista el selector muestra las membresías: se degrada, no se rompe.
      });
  }, [isSystemUser, isSystemContext]);

  const tenantOptions: TenantOption[] =
    allTenants ?? user?.tenants?.map((t) => t.tenant) ?? [];

  const visibleMenu = menuDefinition.filter(
    (item) =>
      hasPermission(item.resource, item.action) &&
      (!item.systemTenantOnly || isSystemContext),
  );

  return (
    <aside className="w-64 bg-gray-900 text-white min-h-screen flex flex-col">
      <div className="p-4 border-b border-gray-800">
        <h2 className="text-xl font-bold">PCI Admin</h2>
        {user && (
          <div className="mt-2 text-sm text-gray-400">
            <p className="truncate">{user.email}</p>
            {tenantOptions.length > 1 || isSystemUser ? (
              <select
                value={activeTenant || ''}
                onChange={(e) => setActiveTenant(e.target.value)}
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
              >
                {/* La vista consolidada no es una empresa real. El superadmin ve todas las del
                    sistema; el usuario común con varias empresas, solo las suyas. */}
                {canSeeAllOption && (
                  <option value={ALL_TENANTS}>
                    {isSystemUser ? '🌐 Todas las empresas' : '🌐 Todas mis empresas'}
                  </option>
                )}
                {tenantOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            ) : tenantOptions[0] ? (
              <p className="text-xs mt-1">{tenantOptions[0].name}</p>
            ) : null}
          </div>
        )}
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {visibleMenu.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`block px-3 py-2 rounded text-sm ${
              pathname === item.href
                ? 'bg-blue-600 text-white'
                : 'text-gray-300 hover:bg-gray-800'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="p-4 border-t border-gray-800">
        <button
          onClick={logout}
          className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-gray-800 rounded"
        >
          Cerrar sesión
        </button>
      </div>
    </aside>
  );
}
