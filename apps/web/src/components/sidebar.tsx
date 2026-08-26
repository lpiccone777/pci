'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { apiFetch } from '@/lib/api';
import {
  ALL_TENANTS,
  ALL_TENANTS_CACHE_KEY,
  SYSTEM_TENANT_SLUG,
  TENANTS_CHANGED_EVENT,
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
  const { user, hasPermission, logout, activeTenant, setActiveTenant, isSuperAdmin } =
    useAuth();
  const pathname = usePathname();
  const [allTenants, setAllTenants] = useState<TenantOption[] | null>(null);

  const activeSlug = user?.tenants?.find((t) => t.tenantId === activeTenant)?.tenant?.slug;
  const isAllTenants = activeTenant === ALL_TENANTS;
  // Miembro del tenant de sistema (por membresía real, no por ser superadmin): un usuario
  // común puede pertenecer a la empresa de sistema con un rol que le da `settings`/`tenants`.
  const isSystemMember = !!user?.tenants?.some(
    (t) => t.tenant.slug === SYSTEM_TENANT_SLUG,
  );
  // "Contexto de sistema" = estar operando dentro del tenant de sistema. Habilita los ítems
  // solo-sistema del menú (Tenants, Configuración), que en el backend van con
  // `SystemTenantGuard` (membresía en sistema) + permiso RBAC. Por eso el corte acá es estar
  // PARADO en la empresa de sistema —no ser superadmin—: un usuario común miembro del tenant
  // de sistema con el permiso correspondiente debe verlos y usarlos (manda el RBAC). En la
  // vista consolidada "Todas las empresas" no hay una empresa puntual activa, así que ese
  // contexto también aplica a quien es miembro del sistema (el superadmin lo es siempre; el
  // usuario común, solo si pertenece a esa empresa) — para ellos `apiFetch` ya traduce el
  // header al id de sistema, que es lo que exige `SystemTenantGuard`.
  const isSystemContext =
    activeSlug === SYSTEM_TENANT_SLUG || (isAllTenants && isSystemMember);
  // Puede consolidar varias empresas en el selector: el superadmin siempre; el usuario común
  // solo si pertenece a más de una.
  const canSeeAllOption = isSuperAdmin || (user?.tenants?.length ?? 0) > 1;

  /**
   * El superusuario puede pararse en cualquier empresa, así que el selector no puede
   * armarse solo con sus membresías. La lista completa solo se puede pedir estando en la
   * empresa de sistema, por eso se guarda: apenas salta a otra, el pedido daría 403 y sin
   * la copia guardada el selector se quedaría sin opciones y no habría cómo volver.
   */
  // Trae la lista completa de empresas (solo en contexto de sistema, que es donde
  // `/tenants/all` responde) y la cachea. Fuera de ese contexto, cae a la copia guardada.
  const refreshAllTenants = useCallback(() => {
    if (!isSuperAdmin) return;

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
  }, [isSuperAdmin, isSystemContext]);

  useEffect(() => {
    refreshAllTenants();
  }, [refreshAllTenants]);

  // La lista se cachea al montar, así que un alta/renombre/baja/restauración desde la
  // pantalla de Tenants no se reflejaba en el selector hasta recargar (FE-TEN-06/07 y N2).
  // Esa pantalla emite `TENANTS_CHANGED_EVENT` tras cada cambio y acá volvemos a traerla.
  useEffect(() => {
    const handler = () => refreshAllTenants();
    window.addEventListener(TENANTS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(TENANTS_CHANGED_EVENT, handler);
  }, [refreshAllTenants]);

  const tenantOptions: TenantOption[] =
    allTenants ?? user?.tenants?.map((t) => t.tenant) ?? [];

  // El superusuario del sistema ve el menú COMPLETO, sin importar en qué empresa del selector
  // esté parado: puede operar cualquier pantalla en cualquier empresa (los guards del backend
  // lo dejan pasar por su vínculo de sistema), así que ninguna opción debe desaparecerle. Para
  // el resto sigue mandando el permiso del rol, y los ítems solo-sistema exigen contexto de
  // sistema.
  const visibleMenu = isSuperAdmin
    ? menuDefinition
    : menuDefinition.filter(
        (item) =>
          hasPermission(item.resource, item.action) &&
          (!item.systemTenantOnly || isSystemContext),
      );

  // Id de la empresa de sistema (de las membresías), para saber si la empresa nueva del
  // selector da "contexto de sistema".
  const systemTenantId = user?.tenants?.find(
    (t) => t.tenant.slug === SYSTEM_TENANT_SLUG,
  )?.tenant.id;

  const isSystemContextForTenant = (id: string): boolean =>
    id === ALL_TENANTS ? isSystemMember : !!systemTenantId && id === systemTenantId;

  /**
   * A dónde mandar al usuario cuando cambia de empresa, si la pantalla actual ya no
   * corresponde a la empresa nueva. `undefined` = quedarse donde está (recarga en el lugar).
   */
  const redirectOnTenantChange = (newId: string): string | undefined => {
    // FE-FLW-22: en el editor de un flujo, cambiar de empresa saca al listado — el flujo
    // abierto puede ser de otra empresa.
    if (pathname?.startsWith('/dashboard/flows/edit')) return '/dashboard/flows/';
    // FE-INF-16: parado en una pantalla solo-sistema, pasar a una empresa que no da contexto
    // de sistema deja la pantalla huérfana (fuera del menú) → volver al dashboard. La comparación
    // normaliza la barra final: con `trailingSlash`, `usePathname()` puede traer
    // "/dashboard/tenants/" y el match exacto contra el href del menú (sin barra) fallaría.
    const normalizedPath = (pathname ?? '').replace(/\/+$/, '') || '/';
    const current = menuDefinition.find((m) => m.href === normalizedPath);
    if (current?.systemTenantOnly && !isSystemContextForTenant(newId)) return '/dashboard/';
    return undefined;
  };

  return (
    <aside className="w-64 bg-gray-900 text-white min-h-screen flex flex-col">
      <div className="p-4 border-b border-gray-800">
        <h2 className="text-xl font-bold">PCI Admin</h2>
        {user && (
          <div className="mt-2 text-sm text-gray-400">
            <p className="truncate">{user.email}</p>
            {tenantOptions.length > 1 || isSuperAdmin ? (
              <select
                value={activeTenant || ''}
                onChange={(e) =>
                  setActiveTenant(e.target.value, redirectOnTenantChange(e.target.value))
                }
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
              >
                {/* La vista consolidada no es una empresa real. El superadmin ve todas las del
                    sistema; el usuario común con varias empresas, solo las suyas. */}
                {canSeeAllOption && (
                  <option value={ALL_TENANTS}>
                    {isSuperAdmin ? '🌐 Todas las empresas' : '🌐 Todas mis empresas'}
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
