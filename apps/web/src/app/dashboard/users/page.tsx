'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';

interface RoleOption {
  id: string;
  name: string;
}

interface UserData {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  createdAt: string;
  role: RoleOption | null;
}

const EMPTY_FORM = {
  email: '',
  firstName: '',
  lastName: '',
  password: '',
  phone: '',
  roleId: '',
};

export default function UsersPage() {
  const { hasPermission, user: currentUser } = useAuth();
  const [users, setUsers] = useState<UserData[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = hasPermission('users', 'create');
  const canUpdate = hasPermission('users', 'update');
  const canDelete = hasPermission('users', 'delete');
  const canReadRoles = hasPermission('roles', 'read');

  async function load() {
    try {
      const [userData, roleData] = await Promise.all([
        apiFetch('/users'),
        canReadRoles ? apiFetch('/roles') : Promise.resolve([]),
      ]);
      setUsers(userData);
      setRoles(roleData.map((r: any) => ({ id: r.id, name: r.name })));
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startEdit(u: UserData) {
    setEditingId(u.id);
    setForm({
      email: u.email,
      firstName: u.firstName ?? '',
      lastName: u.lastName ?? '',
      password: '',
      phone: u.phone ?? '',
      roleId: u.role?.id ?? '',
    });
    setNotice('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (editingId) {
        const payload: Record<string, string> = {
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone,
          roleId: form.roleId,
        };
        // La contraseña solo viaja si se completó: vacío significa "no la cambies".
        if (form.password) payload.password = form.password;

        await apiFetch(`/users/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setNotice('Usuario actualizado.');
      } else {
        await apiFetch('/users', {
          method: 'POST',
          body: JSON.stringify(form),
        });
        setNotice('Usuario creado.');
      }
      cancelEdit();
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(u: UserData) {
    const label = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
    if (!confirm(`¿Dar de baja a ${label} de este tenant?`)) return;

    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(`/users/${u.id}`, { method: 'DELETE' });
      setNotice(res.message || 'Usuario dado de baja.');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-gray-500">Cargando...</p>;

  const showForm = editingId ? canUpdate : canCreate;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6 text-gray-800">Usuarios</h1>

      {error && <p className="text-red-500 mb-4">{error}</p>}
      {notice && <p className="text-green-600 mb-4">{notice}</p>}

      {/* La lista de roles queda vacía por dos motivos distintos —la empresa no tiene
          ninguno, o esta persona no puede verlos— y cada uno se resuelve de otra forma.
          Con un solo mensaje, a quien le falta el permiso se le decía que no hay roles
          (falso) y se lo mandaba a una pantalla a la que tampoco puede entrar. */}
      {roles.length === 0 && canCreate && (
        <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-4 text-sm">
          {canReadRoles ? (
            <>
              No hay roles en este tenant. El rol es obligatorio, así que creá uno en{' '}
              <strong>Roles</strong> antes de dar de alta usuarios.
            </>
          ) : (
            <>
              No tenés permiso para ver los roles, y el rol es obligatorio para dar de alta
              un usuario. Pedile a un administrador que te habilite <strong>ver roles</strong>.
            </>
          )}
        </p>
      )}

      {showForm && (
        <form onSubmit={submit} className="bg-white p-4 rounded shadow mb-6 space-y-3">
          <h2 className="font-semibold text-gray-700">
            {editingId ? 'Editar usuario' : 'Nuevo usuario'}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Nombre *</label>
              <input
                placeholder="Juan"
                value={form.firstName}
                onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                className="border px-3 py-2 rounded w-full"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Apellido *</label>
              <input
                placeholder="Pérez"
                value={form.lastName}
                onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                className="border px-3 py-2 rounded w-full"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Email *</label>
              <input
                type="email"
                placeholder="juan.perez@empresa.com"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="border px-3 py-2 rounded w-full disabled:bg-gray-100"
                disabled={!!editingId}
                title={editingId ? 'El email no se puede cambiar' : undefined}
                required
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">Rol *</label>
              <select
                value={form.roleId}
                onChange={(e) => setForm({ ...form, roleId: e.target.value })}
                className="border px-3 py-2 rounded w-full"
                required
              >
                <option value="">Seleccionar rol</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Teléfono</label>
              <input
                placeholder="+54911..."
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="border px-3 py-2 rounded w-full"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                {editingId ? 'Nueva contraseña' : 'Contraseña *'}
              </label>
              <input
                type="password"
                placeholder={editingId ? 'Dejar vacío para no cambiarla' : 'Mínimo 8 caracteres'}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="border px-3 py-2 rounded w-full"
                minLength={8}
                required={!editingId}
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || roles.length === 0}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300"
            >
              {busy ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear'}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={cancelEdit}
                className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100"
              >
                Cancelar
              </button>
            )}
          </div>
        </form>
      )}

      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              <th className="text-left px-4 py-2">Nombre</th>
              <th className="text-left px-4 py-2">Apellido</th>
              <th className="text-left px-4 py-2">Email</th>
              <th className="text-left px-4 py-2">Rol</th>
              <th className="text-left px-4 py-2">Teléfono</th>
              <th className="text-left px-4 py-2">Creado</th>
              {(canUpdate || canDelete) && <th className="px-4 py-2"></th>}
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                  No hay usuarios en este tenant.
                </td>
              </tr>
            )}
            {users.map((u) => (
              <tr key={u.id} className="border-t">
                <td className="px-4 py-2">{u.firstName || '-'}</td>
                <td className="px-4 py-2">{u.lastName || '-'}</td>
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2">
                  {u.role ? (
                    <span className="inline-block bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-xs">
                      {u.role.name}
                    </span>
                  ) : (
                    '-'
                  )}
                </td>
                <td className="px-4 py-2">{u.phone || '-'}</td>
                <td className="px-4 py-2">{new Date(u.createdAt).toLocaleDateString()}</td>
                {(canUpdate || canDelete) && (
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {canUpdate && (
                      <button
                        onClick={() => startEdit(u)}
                        disabled={busy}
                        className="text-blue-600 hover:text-blue-800 text-sm px-2"
                      >
                        Editar
                      </button>
                    )}
                    {canDelete && u.id !== currentUser?.id && (
                      <button
                        onClick={() => remove(u)}
                        disabled={busy}
                        className="text-red-600 hover:text-red-800 text-sm px-2"
                      >
                        Eliminar
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
