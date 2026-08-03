'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';

interface UserData {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  createdAt: string;
}

export default function UsersPage() {
  const { hasPermission } = useAuth();
  const [users, setUsers] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ email: '', name: '', password: '', phone: '' });

  async function load() {
    try {
      const data = await apiFetch('/users');
      setUsers(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setForm({ email: '', name: '', password: '', phone: '' });
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (loading) return <p className="text-gray-500">Cargando...</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6 text-gray-800">Usuarios</h1>

      {error && <p className="text-red-500 mb-4">{error}</p>}

      {hasPermission('users', 'create') && (
        <form onSubmit={create} className="bg-white p-4 rounded shadow mb-6 space-y-3">
          <h2 className="font-semibold text-gray-700">Nuevo usuario</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <input
              placeholder="Email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="border px-3 py-2 rounded"
              required
            />
            <input
              placeholder="Nombre"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="border px-3 py-2 rounded"
            />
            <input
              placeholder="Contraseña"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="border px-3 py-2 rounded"
              required
            />
            <input
              placeholder="Teléfono"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="border px-3 py-2 rounded"
            />
          </div>
          <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
            Crear
          </button>
        </form>
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              <th className="text-left px-4 py-2">Email</th>
              <th className="text-left px-4 py-2">Nombre</th>
              <th className="text-left px-4 py-2">Teléfono</th>
              <th className="text-left px-4 py-2">Creado</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t">
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2">{u.name || '-'}</td>
                <td className="px-4 py-2">{u.phone || '-'}</td>
                <td className="px-4 py-2">{new Date(u.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
