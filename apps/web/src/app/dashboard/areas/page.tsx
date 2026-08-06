'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';

interface AreaData {
  id: string;
  name: string;
  createdAt: string;
  /** Cuántos usuarios del tenant activo están asignados a esta área. */
  userCount: number;
}

interface AreaUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export default function AreasPage() {
  const { hasPermission } = useAuth();
  const [areas, setAreas] = useState<AreaData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewingUsers, setViewingUsers] = useState<AreaData | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = hasPermission('areas', 'create');
  const canUpdate = hasPermission('areas', 'update');
  const canDelete = hasPermission('areas', 'delete');

  async function load() {
    try {
      setAreas(await apiFetch('/areas'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function startEdit(a: AreaData) {
    setEditingId(a.id);
    setName(a.name);
    setNotice('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openUsers(a: AreaData) {
    setNotice('');
    setViewingUsers(a);
  }

  function cancelEdit() {
    setEditingId(null);
    setName('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (editingId) {
        await apiFetch(`/areas/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        });
        setNotice('Área actualizada.');
      } else {
        await apiFetch('/areas', {
          method: 'POST',
          body: JSON.stringify({ name }),
        });
        setNotice('Área creada.');
      }
      cancelEdit();
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: AreaData) {
    if (!confirm(`¿Eliminar el área "${a.name}"?`)) return;

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiFetch(`/areas/${a.id}`, { method: 'DELETE' });
      setNotice(res.message || 'Área eliminada.');
      await load();
    } catch (err: any) {
      // El backend rechaza el borrado si el área tiene usuarios asignados, y el mensaje
      // ya dice cuántos son: mostrarlo tal cual es más útil que un "no se pudo".
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-gray-500">Cargando...</p>;

  const showForm = editingId ? canUpdate : canCreate;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2 text-gray-800">Áreas</h1>
      <p className="text-sm text-gray-500 mb-6">
        Agrupan a los usuarios de esta empresa para auditoría y métricas. No intervienen en
        los flujos IVR, que se resuelven por rol.
      </p>

      {error && <p className="text-red-500 mb-4">{error}</p>}
      {notice && <p className="text-green-600 mb-4">{notice}</p>}

      {showForm && (
        <form onSubmit={submit} className="bg-white p-4 rounded shadow mb-6 space-y-3">
          <h2 className="font-semibold text-gray-700">
            {editingId ? 'Editar área' : 'Nueva área'}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <label className="block text-xs text-gray-500 mb-1">Nombre *</label>
              <input
                placeholder="Soporte"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="border px-3 py-2 rounded w-full"
                maxLength={80}
                required
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
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
              <th className="text-right px-4 py-2 whitespace-nowrap">Usuarios</th>
              <th className="text-left px-4 py-2">Creada</th>
              {(canUpdate || canDelete) && <th className="px-4 py-2"></th>}
            </tr>
          </thead>
          <tbody>
            {areas.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-gray-400">
                  No hay áreas en esta empresa.
                </td>
              </tr>
            )}
            {areas.map((a) => (
              <tr key={a.id} className="border-t hover:bg-gray-50">
                <td className="px-4 py-2">{a.name}</td>
                <td className="px-4 py-2 text-right">
                  {/* El número ES el acceso a la lista, igual que en Roles: el dato y la
                      forma de abrirlo son la misma cosa, así que no lleva un botón aparte. */}
                  <button
                    onClick={() => openUsers(a)}
                    title={`Ver los usuarios del área ${a.name}`}
                    className="text-blue-600 hover:text-blue-800 hover:underline tabular-nums"
                  >
                    {a.userCount}
                  </button>
                </td>
                <td className="px-4 py-2">{new Date(a.createdAt).toLocaleDateString()}</td>
                {(canUpdate || canDelete) && (
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {canUpdate && (
                      <button
                        onClick={() => startEdit(a)}
                        disabled={busy}
                        className="text-blue-600 hover:text-blue-800 text-sm px-2"
                      >
                        Editar
                      </button>
                    )}
                    {canDelete && (
                      <button
                        onClick={() => remove(a)}
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

      {viewingUsers && (
        <UsersModal area={viewingUsers} onClose={() => setViewingUsers(null)} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ventana de usuarios del área                                        */
/* ------------------------------------------------------------------ */

function UsersModal({ area, onClose }: { area: AreaData; onClose: () => void }) {
  const router = useRouter();
  const [people, setPeople] = useState<AreaUser[] | null>(null);
  const [error, setError] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    apiFetch(`/areas/${area.id}/users`)
      .then(setPeople)
      .catch((err: any) => setError(err.message));
  }, [area.id]);

  useEffect(() => {
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-gray-900/55"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="area-users-modal-title"
    >
      <div className="bg-white rounded-md shadow-2xl w-full max-w-[520px] max-h-full flex flex-col text-gray-900">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2
              id="area-users-modal-title"
              className="text-lg font-semibold text-gray-800"
            >
              Usuarios del área {area.name}
            </h2>
            <p className="mt-2 text-xs text-gray-500">
              {area.userCount === 0
                ? 'Ningún usuario está asignado a esta área.'
                : area.userCount === 1
                  ? '1 usuario'
                  : `${area.userCount} usuarios`}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="text-xl leading-none text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-2 py-1"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          {error && <p className="text-red-500 text-sm">{error}</p>}

          {!error && people === null && (
            <p className="text-gray-500 text-sm">Cargando...</p>
          )}

          {!error && people !== null && people.length === 0 && (
            <p className="py-6 text-center text-sm text-gray-400">
              Nadie está en esta área todavía.
              <br />
              Por eso se puede eliminar sin dejar a nadie sin área.
            </p>
          )}

          {!error && people !== null && people.length > 0 && (
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1.5 text-[11px] uppercase tracking-wider text-gray-500 font-semibold border-b border-gray-200">
                    Nombre
                  </th>
                  <th className="text-left px-2 py-1.5 text-[11px] uppercase tracking-wider text-gray-500 font-semibold border-b border-gray-200">
                    Email
                  </th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-2 py-1.5 border-b border-gray-100">
                      {[p.firstName, p.lastName].filter(Boolean).join(' ') || '-'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-gray-100 text-gray-500">
                      {p.email}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center gap-3 rounded-b-md">
          <span className="flex-1 text-[13px] text-gray-500">
            {people && people.length > 0 ? 'El área se cambia desde cada usuario.' : ''}
          </span>
          <button
            onClick={() => router.push('/dashboard/users')}
            className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100 whitespace-nowrap"
          >
            Ir a Usuarios
          </button>
          <button
            ref={closeRef}
            onClick={onClose}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
