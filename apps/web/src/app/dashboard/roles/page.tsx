'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';

interface RoleData {
  id: string;
  name: string;
  permissions: Array<{ id: string; resource: string; action: string }>;
}

export default function RolesPage() {
  const { hasPermission, activeTenant } = useAuth();
  const [roles, setRoles] = useState<RoleData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newRole, setNewRole] = useState('');
  const [permForm, setPermForm] = useState({ roleId: '', resource: '', action: '' });

  async function load() {
    try {
      const data = await apiFetch('/roles');
      setRoles(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createRole(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/roles', {
        method: 'POST',
        body: JSON.stringify({ name: newRole }),
      });
      setNewRole('');
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function addPermission(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch(`/roles/${permForm.roleId}/permissions`, {
        method: 'POST',
        body: JSON.stringify({ resource: permForm.resource, action: permForm.action }),
      });
      setPermForm({ roleId: '', resource: '', action: '' });
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (loading) return <p className="text-gray-500">Cargando...</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6 text-gray-800">Roles</h1>
      {error && <p className="text-red-500 mb-4">{error}</p>}

      {hasPermission('roles', 'create') && (
        <form onSubmit={createRole} className="bg-white p-4 rounded shadow mb-6 flex gap-3 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">Nuevo rol</label>
            <input
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              className="w-full border px-3 py-2 rounded"
              placeholder="Nombre del rol"
              required
            />
          </div>
          <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
            Crear
          </button>
        </form>
      )}

      {hasPermission('permissions', 'create') && (
        <form onSubmit={addPermission} className="bg-white p-4 rounded shadow mb-6 space-y-3">
          <h2 className="font-semibold text-gray-700">Agregar permiso</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <select
              value={permForm.roleId}
              onChange={(e) => setPermForm({ ...permForm, roleId: e.target.value })}
              className="border px-3 py-2 rounded"
              required
            >
              <option value="">Seleccionar rol</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <input
              placeholder="Recurso (ej: users)"
              value={permForm.resource}
              onChange={(e) => setPermForm({ ...permForm, resource: e.target.value })}
              className="border px-3 py-2 rounded"
              required
            />
            <input
              placeholder="Acción (ej: create)"
              value={permForm.action}
              onChange={(e) => setPermForm({ ...permForm, action: e.target.value })}
              className="border px-3 py-2 rounded"
              required
            />
          </div>
          <button type="submit" className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700">
            Agregar permiso
          </button>
        </form>
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              <th className="text-left px-4 py-2">Rol</th>
              <th className="text-left px-4 py-2">Permisos</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-4 py-2 font-medium">{r.name}</td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {r.permissions.map((p) => (
                      <span
                        key={p.id}
                        className="inline-block bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-xs"
                      >
                        {p.resource}:{p.action}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
