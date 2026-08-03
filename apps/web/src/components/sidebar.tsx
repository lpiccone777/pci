'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';

const menuDefinition = [
  { label: 'Dashboard', href: '/dashboard', resource: 'metrics', action: 'read' },
  { label: 'Usuarios', href: '/dashboard/users', resource: 'users', action: 'read' },
  { label: 'Tenants', href: '/dashboard/tenants', resource: 'tenants', action: 'read' },
  { label: 'Roles', href: '/dashboard/roles', resource: 'roles', action: 'read' },
  { label: 'Flujos IVR', href: '/dashboard/flows', resource: 'flows', action: 'read' },
];

export default function Sidebar() {
  const { user, hasPermission, logout, activeTenant, setActiveTenant } = useAuth();
  const pathname = usePathname();

  const visibleMenu = menuDefinition.filter((item) => hasPermission(item.resource, item.action));

  return (
    <aside className="w-64 bg-gray-900 text-white min-h-screen flex flex-col">
      <div className="p-4 border-b border-gray-800">
        <h2 className="text-xl font-bold">PCI Admin</h2>
        {user && (
          <div className="mt-2 text-sm text-gray-400">
            <p className="truncate">{user.email}</p>
            {user.tenants && user.tenants.length > 1 ? (
              <select
                value={activeTenant || ''}
                onChange={(e) => setActiveTenant(e.target.value)}
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
              >
                {user.tenants.map((t) => (
                  <option key={t.tenantId} value={t.tenantId}>
                    {t.tenant.name}
                  </option>
                ))}
              </select>
            ) : user.tenants?.[0] ? (
              <p className="text-xs mt-1">{user.tenants[0].tenant.name}</p>
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
